export * as TodoTool from "./todo.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema } from "effect"
import { KV } from "../../kv.js"
import { Permission } from "../../permission.js"

export const name = "todo"

export const description = [
  "Track the task's progress as a session-scoped todo list.",
  "Use this for multi-step work: set the full list up front, then update item statuses as you go.",
  "The list is visible to the user and persists for the session; it is replaced wholesale on every set.",
].join("\n")

const TodoItem = Schema.Struct({
  content: Schema.String.annotate({ description: "What needs doing, imperative form." }),
  status: Schema.Literals(["pending", "in_progress", "completed"]).annotate({
    description: "pending: not started. in_progress: actively working (at most one). completed: done.",
  }),
})

export const Input = Schema.Struct({
  action: Schema.Literals(["set", "list"]).annotate({
    description: "set: replace the whole list. list: read the current list.",
  }),
  todos: Schema.optionalKey(Schema.Array(TodoItem).annotate({ description: "Required for set." })),
})

export const Output = Schema.Struct({
  todos: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      status: Schema.String,
    }),
  ),
})

const key = (sessionID: string) => `todo:${sessionID}`

// P2 (QA-05): bound list size and item length to prevent KV/context bloat.
const MAX_TODOS = 100
const MAX_TODO_CONTENT_CHARS = 2_000

const Stored = Schema.Array(
  Schema.Struct({
    content: Schema.String,
    status: Schema.Literals(["pending", "in_progress", "completed"]),
  }),
)

export const Plugin = {
  id: "opencode.tool.todo",
  effect: Effect.fn("TodoTool.Plugin")(function* (ctx: Context) {
    const kv = yield* KV.Service
    const permission = yield* Permission.Service

    const load = (sessionID: string): Effect.Effect<typeof Stored.Type> =>
      kv.get(key(sessionID)).pipe(
        Effect.map((value) =>
          value === undefined
            ? []
            : Option.getOrElse(Schema.decodeUnknownOption(Stored)(value), () => []),
        ),
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
                resources: [context.sessionID],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              if (input.action === "list") {
                const todos = yield* load(context.sessionID)
                return {
                  output: { todos: [...todos] },
                  content:
                    todos.length === 0
                      ? "No todos."
                      : todos.map((t) => `- [${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "}] ${t.content}`).join("\n"),
                  metadata: {},
                }
              }
              if (input.todos === undefined)
                return yield* new ToolFailure({ message: "set needs todos" })
              if (input.todos.length > MAX_TODOS)
                return yield* new ToolFailure({ message: `At most ${MAX_TODOS} todos` })
              for (const t of input.todos) {
                if (t.content.length > MAX_TODO_CONTENT_CHARS)
                  return yield* new ToolFailure({
                    message: `Todo content too long (max ${MAX_TODO_CONTENT_CHARS} chars): ${t.content.slice(0, 50)}…`,
                  })
              }
              const inProgress = input.todos.filter((t) => t.status === "in_progress")
              if (inProgress.length > 1)
                return yield* new ToolFailure({ message: "At most one todo may be in_progress" })
              yield* kv.set(key(context.sessionID), [...input.todos])
              return {
                output: { todos: [...input.todos] },
                content: `Todo list updated (${input.todos.length} items).`,
                metadata: {},
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Todo tool failed", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
