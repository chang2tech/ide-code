export * as Job from "./job.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

export const Kind = Schema.Literals(["shell", "subagent"])
export type Kind = typeof Kind.Type

export const Status = Schema.Literals(["running", "completed", "error", "cancelled", "exited", "timeout", "killed"])
export type Status = typeof Status.Type

/**
 * Unified wire view over the two background-work registries: location-scoped
 * shell commands and process-global subagent jobs. Runtime registries stay in
 * Core; this is only the minimal summary a client needs to list, follow, and
 * cancel background work. Shell terminal statuses (`exited`/`timeout`/`killed`)
 * are preserved at this layer rather than collapsed into `completed`.
 */
export const Summary = Schema.Struct({
  id: Schema.String,
  kind: Kind,
  status: Status,
  title: Schema.String,
  sessionID: optional(Schema.String).annotate({
    description: "Session that owns the job, when known. Shell: metadata.sessionID; subagent: parent session.",
  }),
  started_at: Schema.Finite.annotate({ description: "Start time in milliseconds since the Unix epoch" }),
  completed_at: optional(Schema.Finite).annotate({
    description: "Completion time in milliseconds since the Unix epoch",
  }),
  exit: optional(Schema.Finite).annotate({ description: "Process exit code. Shell jobs only." }),
  signal: optional(Schema.String).annotate({ description: "Signal that ended the process. Shell jobs only." }),
  file: optional(Schema.String).annotate({
    description: "Absolute path of the file capturing combined output. Shell jobs only.",
  }),
  outputAvailable: Schema.Boolean,
}).annotate({ identifier: "Job.Summary" })
export interface Summary extends Schema.Schema.Type<typeof Summary> {}
