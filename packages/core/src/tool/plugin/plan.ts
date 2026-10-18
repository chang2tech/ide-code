export * as PlanTool from "./plan.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Global } from "@opencode/util/global"
import { Effect, Schema } from "effect"
import path from "path"
import { Permission } from "../../permission.js"

export const name = "plan"

export const description = [
  "Create, update, read, and list plan documents for the current task.",
  "Use this when breaking work into steps the user should review before implementation (Cursor-style plan mode).",
  "Plans are markdown files stored in the shared plan directory; creating or updating a plan does not modify project files.",
  "Actions: create (needs title + content), update (needs id + content), read (needs id), list.",
].join("\n")

export const Input = Schema.Struct({
  action: Schema.Literals(["create", "update", "read", "list"]).annotate({
    description: "create: new plan (title + content). update: replace plan body (id + content). read: fetch one plan (id). list: all plans.",
  }),
  id: Schema.optionalKey(Schema.String).annotate({ description: "Plan id for update/read. Returned by create and list." }),
  title: Schema.optionalKey(Schema.String).annotate({ description: "Plan title, used for create." }),
  content: Schema.optionalKey(Schema.String).annotate({ description: "Markdown plan body for create/update." }),
})

const PlanSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
})

export const Output = Schema.Struct({
  plans: Schema.optionalKey(Schema.Array(PlanSummary)),
  plan: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      content: Schema.String,
    }),
  ),
})

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "plan"

export const Plugin = {
  id: "opencode.tool.plan",
  effect: Effect.fn("PlanTool.Plugin")(function* (ctx: Context) {
    const global = yield* Global.Service
    const permission = yield* Permission.Service
    const directory = path.join(global.home, ".opencode", "plan")

    const ensureDir = Effect.tryPromise({
      try: () => Bun.$`mkdir -p ${directory}`.quiet().then(() => undefined),
      catch: (error) => new ToolFailure({ message: `Could not create plan directory: ${directory}`, error }),
    })

    const listFiles = Effect.tryPromise({
      try: () => Bun.$`ls ${directory}`.quiet().text(),
      catch: () => "",
    })

    const readTitle = (id: string) =>
      Effect.tryPromise({
        try: async () => {
          const text = await Bun.file(path.join(directory, `${id}.md`)).text()
          const first = text.split("\n").find((line) => line.startsWith("# "))?.slice(2).trim()
          return { id, title: first ?? id, content: text }
        },
        catch: (error) => new ToolFailure({ message: `Plan not found: ${id}`, error }),
      })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, permission: "edit" },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.messageID,
                id: context.id,
              }
              yield* permission.assert({
                action: "edit",
                resources: [path.join(directory, "*")],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              yield* ensureDir
              switch (input.action) {
                case "list": {
                  const files = yield* listFiles
                  const ids = files
                    .split("\n")
                    .map((f) => f.trim())
                    .filter((f) => f.endsWith(".md"))
                    .map((f) => f.slice(0, -3))
                  const plans = yield* Effect.forEach(ids, (id) =>
                    readTitle(id).pipe(
                      Effect.map((plan) => ({ id: plan.id, title: plan.title })),
                      Effect.orElseSucceed(() => ({ id, title: id })),
                    ),
                  )
                  return { output: { plans }, content: `Plans (${plans.length}):\n${plans.map((p) => `- ${p.id}: ${p.title}`).join("\n") || "(none)"}`, metadata: {} }
                }
                case "read": {
                  if (!input.id) return yield* new ToolFailure({ message: "read needs id" })
                  const plan = yield* readTitle(input.id)
                  return { output: { plan }, content: `# ${plan.title}\n\n${plan.content}`, metadata: {} }
                }
                case "create": {
                  if (!input.title || !input.content)
                    return yield* new ToolFailure({ message: "create needs title and content" })
                  const id = `${slug(input.title)}-${Date.now().toString(36)}`
                  const body = `# ${input.title}\n\n${input.content}\n`
                  yield* Effect.tryPromise({
                    try: () => Bun.write(path.join(directory, `${id}.md`), body).then(() => undefined),
                    catch: (error) => new ToolFailure({ message: `Failed to write plan: ${id}`, error }),
                  })
                  return {
                    output: { plan: { id, title: input.title, content: body }, plan_uri: path.join(directory, `${id}.md`) },
                    content: `Plan created: ${id}`,
                    metadata: {},
                  }
                }
                case "update": {
                  if (!input.id || !input.content)
                    return yield* new ToolFailure({ message: "update needs id and content" })
                  const existing = yield* readTitle(input.id)
                  const body = input.content.startsWith("# ")
                    ? `${input.content}\n`
                    : `# ${existing.title}\n\n${input.content}\n`
                  yield* Effect.tryPromise({
                    try: () => Bun.write(path.join(directory, `${input.id}.md`), body).then(() => undefined),
                    catch: (error) => new ToolFailure({ message: `Failed to write plan: ${input.id}`, error }),
                  })
                  return {
                    output: { plan: { id: input.id, title: existing.title, content: body } },
                    content: `Plan updated: ${input.id}`,
                    metadata: {},
                  }
                }
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Plan tool failed", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
