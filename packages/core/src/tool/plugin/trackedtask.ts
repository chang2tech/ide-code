export * as TrackedTaskTool from "./trackedtask.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema } from "effect"
import { KV } from "../../kv.js"
import { Location } from "../../location.js"

// Tracked tasks: Linear-style project tasks (docs/rea/deep-agent-tools.md §3.4).
// Longer-lived than session todos; scoped to the workspace directory.

export const name = "trackedtask"

export const description = [
  "Manage project-level tracked tasks: create, list, update, delete, and manage task statuses.",
  "Use for work that outlives a single session; use todo for short-lived session checklists.",
].join("\n")

const Status = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  icon: Schema.optionalKey(Schema.String),
  category: Schema.optionalKey(Schema.String),
})

const Task = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  status: Schema.String,
  owner: Schema.optionalKey(Schema.String),
  parent: Schema.optionalKey(Schema.String),
  links: Schema.optionalKey(Schema.Array(Schema.String)),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

const NewTask = Schema.Struct({
  client_ref: Schema.optionalKey(Schema.String),
  title: Schema.String,
  status: Schema.optionalKey(Schema.String),
  owner: Schema.optionalKey(Schema.String),
  parent: Schema.optionalKey(Schema.String),
  links: Schema.optionalKey(Schema.Array(Schema.String)),
})

const TaskUpdate = Schema.Struct({
  key: Schema.String,
  title: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  owner: Schema.optionalKey(Schema.String),
})

export const Input = Schema.Struct({
  action: Schema.Literals(["create", "list", "update", "delete", "update_statuses"]).annotate({
    description: "The operation to perform.",
  }),
  tasks: Schema.optionalKey(Schema.Array(NewTask)).annotate({ description: "Tasks to create (create)." }),
  keys: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Task keys to list or delete.",
  }),
  updates: Schema.optionalKey(Schema.Array(TaskUpdate)).annotate({ description: "Task updates (update)." }),
  statuses: Schema.optionalKey(Schema.Array(Status)).annotate({
    description: "Status definitions to register (update_statuses).",
  }),
  status_categories: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Filter listed tasks by status category.",
  }),
  owner: Schema.optionalKey(Schema.String).annotate({ description: "Filter listed tasks by owner." }),
})

const Output = Schema.Struct({
  tasks: Schema.optionalKey(Schema.Array(Task)),
  statuses: Schema.optionalKey(Schema.Array(Status)),
  message: Schema.optionalKey(Schema.String),
})

const DEFAULT_STATUSES = [
  { id: "todo", label: "Todo", category: "open" },
  { id: "in_progress", label: "In Progress", category: "open" },
  { id: "done", label: "Done", category: "closed" },
]

export const Plugin = {
  id: "opencode.tool.trackedtask",
  effect: Effect.fn("TrackedTaskTool.Plugin")(function* (ctx: Context) {
    const kv = yield* KV.Service
    const location = yield* Location.Service

    const scope = () => `trackedtask:${location.directory}`
    const taskKey = (key: string) => `${scope()}:task:${key}`
    const statusesKey = () => `${scope()}:statuses`

    const decodeTask = (value: unknown) => Schema.decodeUnknownOption(Task)(value)
    const decodeStatuses = (value: unknown) =>
      Option.getOrElse(Schema.decodeUnknownOption(Schema.Array(Status))(value), () => DEFAULT_STATUSES)

    // KV values must be valid Json: strip explicit undefineds before writing.
    const toJson = (value: { [key: string]: Schema.Json | undefined }): { [key: string]: Schema.Json } => {
      const out: { [key: string]: Schema.Json } = {}
      for (const [key, val] of Object.entries(value)) if (val !== undefined) out[key] = val
      return out
    }

    const loadStatuses = (): Effect.Effect<ReadonlyArray<typeof Status.Type>> =>
      kv.get(statusesKey()).pipe(Effect.map((value) => (value === undefined ? DEFAULT_STATUSES : decodeStatuses(value))))

    const statusIds = (statuses: ReadonlyArray<typeof Status.Type>) => new Set(statuses.map((s) => s.id))

    const loadTask = (key: string): Effect.Effect<typeof Task.Type | undefined> =>
      kv.get(taskKey(key)).pipe(
        Effect.map((value) => (value === undefined ? undefined : Option.getOrUndefined(decodeTask(value)))),
      )

    const listTasks = (input: typeof Input.Type): Effect.Effect<Array<typeof Task.Type>> =>
      kv.scan({ prefix: `${scope()}:task:` }).pipe(
        Effect.flatMap((result) =>
          Effect.forEach(result.entries, (entry) =>
            Effect.succeed(Option.getOrUndefined(decodeTask(entry.value))),
          ),
        ),
        Effect.map((tasks) =>
          tasks
            .filter((t) => t !== undefined)
            .filter((t) => (input.keys === undefined ? true : input.keys.includes(t.key)))
            .filter((t) => (input.owner === undefined ? true : t.owner === input.owner)),
        ),
      )

    const toFailure = (message: string) => (error: unknown) =>
      error instanceof ToolFailure ? error : new ToolFailure({ message, error })

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
              switch (input.action) {
                case "create": {
                  const statuses = yield* loadStatuses()
                  const ids = statusIds(statuses)
                  const created: Array<typeof Task.Type> = []
                  for (const item of input.tasks ?? []) {
                    const key = item.client_ref ?? `task-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`
                    const existing = yield* loadTask(key)
                    if (existing !== undefined)
                      return yield* new ToolFailure({ message: `Tracked task already exists: ${key}` })
                    const status = item.status ?? "todo"
                    if (!ids.has(status))
                      return yield* new ToolFailure({ message: `Unknown status: ${status}` })
                    const now = Date.now()
                    const task: Record<string, string | number | ReadonlyArray<string>> = {
                      key,
                      title: item.title,
                      status,
                      createdAt: now,
                      updatedAt: now,
                    }
                    if (item.owner !== undefined) task.owner = item.owner
                    if (item.parent !== undefined) task.parent = item.parent
                    if (item.links !== undefined) task.links = [...item.links]
                    yield* kv.set(taskKey(key), toJson(task))
                    const decoded = Option.getOrUndefined(decodeTask(task))
                    if (decoded !== undefined) created.push(decoded)
                  }
                  return {
                    output: { tasks: created, message: `Created ${created.length} tracked task(s).` },
                    content: `Created ${created.length} tracked task(s): ${created.map((t) => t.key).join(", ")}`,
                    metadata: {},
                  }
                }
                case "list": {
                  const tasks = yield* listTasks(input)
                  const statuses = yield* loadStatuses()
                  const categoryOf = new Map(statuses.map((s) => [s.id, s.category]))
                  const filtered = tasks.filter((t) =>
                    input.status_categories === undefined
                      ? true
                      : input.status_categories.includes(categoryOf.get(t.status) ?? ""),
                  )
                  return {
                    output: { tasks: filtered, statuses: [...statuses] },
                    content:
                      filtered.length === 0
                        ? "No tracked tasks."
                        : filtered.map((t) => `- [${t.status}] ${t.key}: ${t.title}`).join("\n"),
                    metadata: {},
                  }
                }
                case "update": {
                  const statuses = yield* loadStatuses()
                  const ids = statusIds(statuses)
                  const updated: Array<typeof Task.Type> = []
                  for (const item of input.updates ?? []) {
                    const existing = yield* loadTask(item.key)
                    if (existing === undefined)
                      return yield* new ToolFailure({ message: `Tracked task not found: ${item.key}` })
                    if (item.status !== undefined && !ids.has(item.status))
                      return yield* new ToolFailure({ message: `Unknown status: ${item.status}` })
                    const next = {
                      ...existing,
                      ...(item.title !== undefined ? { title: item.title } : {}),
                      ...(item.status !== undefined ? { status: item.status } : {}),
                      ...(item.owner !== undefined ? { owner: item.owner } : {}),
                      updatedAt: Date.now(),
                    }
                    yield* kv.set(taskKey(item.key), toJson(next))
                    const decodedUpdate = Option.getOrUndefined(decodeTask(next))
                    if (decodedUpdate !== undefined) updated.push(decodedUpdate)
                  }
                  return {
                    output: { tasks: updated, message: `Updated ${updated.length} tracked task(s).` },
                    content: `Updated ${updated.length} tracked task(s).`,
                    metadata: {},
                  }
                }
                case "delete": {
                  for (const key of input.keys ?? []) yield* kv.remove(taskKey(key))
                  return {
                    output: { message: `Deleted ${(input.keys ?? []).length} tracked task(s).` },
                    content: `Deleted ${(input.keys ?? []).length} tracked task(s).`,
                    metadata: {},
                  }
                }
                case "update_statuses": {
                  const next = [...(input.statuses ?? [])]
                  yield* kv.set(statusesKey(), next)
                  return {
                    output: { statuses: next, message: `Registered ${next.length} status(es).` },
                    content: `Registered ${next.length} status(es).`,
                    metadata: {},
                  }
                }
              }
            }).pipe(Effect.mapError(toFailure("Tracked task tool failed"))),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
