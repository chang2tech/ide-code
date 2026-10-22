export * as HookSchema from "./schema.js"

import { Schema } from "effect"

// One hook entry (docs/rea/parity-rules-mcp.md §C2).
// `type: "prompt"` entries are LLM-evaluated hooks: parsed and validated here,
// but the runner reports them as unsupported (they need a model call, which the
// synchronous gate path cannot do). They are never silently ignored — the
// loader surfaces them as diagnostics.
export const HookType = Schema.Literals(["command", "prompt"])
export type HookType = typeof HookType.Type

export const HookEntry = Schema.Struct({
  command: Schema.String,
  type: Schema.optionalKey(HookType),
  // seconds
  timeout: Schema.optionalKey(Schema.Number),
  loop_limit: Schema.optionalKey(Schema.Union(Schema.Number, Schema.Null)),
  failClosed: Schema.optionalKey(Schema.Boolean),
  // regex applied to the event's matchable field (see HookEvents.MATCHER_FIELD)
  matcher: Schema.optionalKey(Schema.String),
})
export type HookEntry = typeof HookEntry.Type

export const HooksFile = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  hooks: Schema.optionalKey(Schema.Record({ key: Schema.String, value: Schema.Array(HookEntry) })),
})
export type HooksFile = typeof HooksFile.Type
