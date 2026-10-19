export * as GoalTool from "./goal.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema } from "effect"
import { KV } from "../../kv.js"
import { Permission } from "../../permission.js"

export const name = "goal"

export const description = [
  "Create and track durable goals: long-lived objectives that persist across sessions.",
  "Use this for user commitments and multi-session projects (Cursor-style goals).",
  "Goals live in project storage and can be listed, updated, and completed over time.",
  "Actions: create (title + description), update (id + fields), get (id), list, remove (id).",
].join("\n")

const Status = Schema.Literals(["active", "completed", "abandoned"])

const Stored = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  status: Status,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

export const Input = Schema.Struct({
  action: Schema.Literals(["create", "update", "get", "list", "remove"]).annotate({
    description: "create: title + description. update: id + any of title/description/status. get/remove: id.",
  }),
  id: Schema.optionalKey(Schema.String).annotate({ description: "Goal id for update/get/remove." }),
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Status),
})

export const Output = Schema.Struct({
  goals: Schema.optionalKey(Schema.Array(Stored)),
  goal: Schema.optionalKey(Stored),
})

const prefix = "goal:"
const key = (id: string) => `${prefix}${id}`

// P2 (QA-05): bound title/description length to prevent KV bloat.
const MAX_GOAL_TITLE_CHARS = 200
const MAX_GOAL_DESCRIPTION_CHARS = 10_000

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "goal"

export const Plugin = {
  id: "opencode.tool.goal",
  effect: Effect.fn("GoalTool.Plugin")(function* (ctx: Context) {
    const kv = yield* KV.Service
    const permission = yield* Permission.Service

    const load = (id: string): Effect.Effect<typeof Stored.Type, ToolFailure> =>
      kv.get(key(id)).pipe(
        Effect.flatMap((value) => {
          const decoded = value === undefined ? Option.none() : Schema.decodeUnknownOption(Stored)(value)
          if (Option.isNone(decoded)) return Effect.fail(new ToolFailure({ message: `Goal not found: ${id}` }))
          return Effect.succeed(decoded.value)
        }),
      )

    const list: Effect.Effect<Array<typeof Stored.Type>> = kv.scan({ prefix }).pipe(
      Effect.flatMap((result) =>
        Effect.forEach(result.entries, (entry) =>
          Effect.succeed(Option.getOrUndefined(Schema.decodeUnknownOption(Stored)(entry.value))),
        ),
      ),
      Effect.map((goals) => goals.filter((g) => g !== undefined)),
    )

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              const now = Date.now()
              switch (input.action) {
                case "list": {
                  const goals = yield* list
                  return {
                    output: { goals },
                    content:
                      goals.length === 0
                        ? "No goals."
                        : goals.map((g) => `- ${g.id} [${g.status}]: ${g.title}`).join("\n"),
                    metadata: {},
                  }
                }
                case "get": {
                  if (!input.id) return yield* new ToolFailure({ message: "get needs id" })
                  const goal = yield* load(input.id)
                  return { output: { goal }, content: `${goal.title} [${goal.status}]\n${goal.description}`, metadata: {} }
                }
                case "create": {
                  if (!input.title || !input.description)
                    return yield* new ToolFailure({ message: "create needs title and description" })
                  if (input.title.length > MAX_GOAL_TITLE_CHARS)
                    return yield* new ToolFailure({ message: `Title too long (max ${MAX_GOAL_TITLE_CHARS} chars)` })
                  if (input.description.length > MAX_GOAL_DESCRIPTION_CHARS)
                    return yield* new ToolFailure({ message: `Description too long (max ${MAX_GOAL_DESCRIPTION_CHARS} chars)` })
                  // P2: random suffix avoids same-millisecond slug collisions.
                  const id = `${slug(input.title)}-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
                  const goal = { id, title: input.title, description: input.description, status: "active" as const, createdAt: now, updatedAt: now }
                  yield* kv.set(key(id), goal)
                  return { output: { goal }, content: `Goal created: ${id}`, metadata: {} }
                }
                case "update": {
                  if (!input.id) return yield* new ToolFailure({ message: "update needs id" })
                  if (input.title !== undefined && input.title.length > MAX_GOAL_TITLE_CHARS)
                    return yield* new ToolFailure({ message: `Title too long (max ${MAX_GOAL_TITLE_CHARS} chars)` })
                  if (input.description !== undefined && input.description.length > MAX_GOAL_DESCRIPTION_CHARS)
                    return yield* new ToolFailure({ message: `Description too long (max ${MAX_GOAL_DESCRIPTION_CHARS} chars)` })
                  const existing = yield* load(input.id)
                  const goal = {
                    ...existing,
                    title: input.title ?? existing.title,
                    description: input.description ?? existing.description,
                    status: input.status ?? existing.status,
                    updatedAt: now,
                  }
                  yield* kv.set(key(input.id), goal)
                  return { output: { goal }, content: `Goal updated: ${input.id} [${goal.status}]`, metadata: {} }
                }
                case "remove": {
                  if (!input.id) return yield* new ToolFailure({ message: "remove needs id" })
                  yield* load(input.id)
                  yield* kv.remove(key(input.id))
                  return { output: {}, content: `Goal removed: ${input.id}`, metadata: {} }
                }
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Goal tool failed", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
