export * as PlanTool from "./plan.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Global } from "@opencode/util/global"
import { Effect, Schema } from "effect"
import { mkdir, readdir } from "node:fs/promises"
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
  // Wire contract (CreatePlanResult): URI of the created plan file.
  plan_uri: Schema.optionalKey(Schema.String),
})

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "plan"

// P0 (QA-05): plan ids are used in filesystem paths. Reject anything that could
// traverse out of the plan directory. Only alphanumerics, dash, underscore.
// Exported for regression testing.
export const PLAN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/
export const sanitizePlanId = (id: string): string | undefined => {
  if (!PLAN_ID_RE.test(id)) return undefined
  if (id.includes("..")) return undefined
  return id
}

// Max bytes to read from a plan file (P2: bound unbounded reads).
const MAX_PLAN_READ_BYTES = 100_000

export const Plugin = {
  id: "opencode.tool.plan",
  effect: Effect.fn("PlanTool.Plugin")(function* (ctx: Context) {
    const global = yield* Global.Service
    const permission = yield* Permission.Service
    const directory = path.join(global.home, ".opencode", "plan")

    // P2 (QA-05): use fs APIs instead of shell-outs (no metacharacter risk).
    const ensureDir = Effect.tryPromise({
      try: () => mkdir(directory, { recursive: true }).then(() => undefined),
      catch: (error) => new ToolFailure({ message: `Could not create plan directory: ${directory}`, error }),
    })

    const listFiles = Effect.tryPromise({
      try: async () => {
        try {
          return await readdir(directory)
        } catch {
          return [] as string[]
        }
      },
      catch: () => [] as string[],
    })

    const planPath = (id: string) => {
      const safe = sanitizePlanId(id)
      if (safe === undefined) return undefined
      // Belt-and-suspenders: verify the resolved path stays inside the directory.
      const resolved = path.resolve(directory, `${safe}.md`)
      if (resolved !== path.join(directory, `${safe}.md`)) return undefined
      return resolved
    }

    const readTitle = (id: string) =>
      Effect.tryPromise({
        try: async () => {
          const file = planPath(id)
          if (file === undefined) throw new Error(`Invalid plan id: ${id}`)
          // P2: cap the read so a huge file can't blow up memory.
          const text = await Bun.file(file).slice(0, MAX_PLAN_READ_BYTES).text()
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
                    .map((f) => f.trim())
                    .filter((f) => f.endsWith(".md"))
                    .map((f) => f.slice(0, -3))
                    .filter((id) => sanitizePlanId(id) !== undefined)
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
                  if (sanitizePlanId(input.id) === undefined)
                    return yield* new ToolFailure({ message: `Invalid plan id: ${input.id}` })
                  const plan = yield* readTitle(input.id)
                  return { output: { plan }, content: `# ${plan.title}\n\n${plan.content}`, metadata: {} }
                }
                case "create": {
                  if (!input.title || !input.content)
                    return yield* new ToolFailure({ message: "create needs title and content" })
                  // P2: random suffix avoids same-millisecond slug collisions.
                  const id = `${slug(input.title)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
                  const body = `# ${input.title}\n\n${input.content}\n`
                  const file = planPath(id)
                  if (file === undefined)
                    return yield* new ToolFailure({ message: `Failed to create plan id: ${id}` })
                  yield* Effect.tryPromise({
                    try: () => Bun.write(file, body).then(() => undefined),
                    catch: (error) => new ToolFailure({ message: `Failed to write plan: ${id}`, error }),
                  })
                  return {
                    output: { plan: { id, title: input.title, content: body }, plan_uri: file },
                    content: `Plan created: ${id}`,
                    metadata: {},
                  }
                }
                case "update": {
                  if (!input.id || !input.content)
                    return yield* new ToolFailure({ message: "update needs id and content" })
                  if (sanitizePlanId(input.id) === undefined)
                    return yield* new ToolFailure({ message: `Invalid plan id: ${input.id}` })
                  const existing = yield* readTitle(input.id)
                  const body = input.content.startsWith("# ")
                    ? `${input.content}\n`
                    : `# ${existing.title}\n\n${input.content}\n`
                  const file = planPath(input.id)
                  if (file === undefined)
                    return yield* new ToolFailure({ message: `Invalid plan id: ${input.id}` })
                  yield* Effect.tryPromise({
                    try: () => Bun.write(file, body).then(() => undefined),
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
