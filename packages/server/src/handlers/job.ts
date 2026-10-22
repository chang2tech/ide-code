import { Shell } from "@opencode/core/shell"
import { Job } from "@opencode/core/job"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionSchema } from "@opencode/core/session/schema"
// Genuine name collisions with the Core namespaces above; aliased type imports are the last resort allowed by AGENTS.md.
import type { Shell as ShellWire } from "@opencode/schema/shell"
import type { Job as JobWire } from "@opencode/schema/job"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { JobNotFoundError } from "@opencode/protocol/errors"
import { Api } from "../api"
import { response } from "../location"

type Summary = JobWire.Summary

function shellSummary(info: ShellWire.Info): Summary {
  const sessionID = typeof info.metadata.sessionID === "string" ? info.metadata.sessionID : undefined
  return {
    id: info.id,
    kind: "shell",
    // Shell terminal statuses stay as-is on the wire (SPEC A2.2); clients may map them for display.
    status: info.status,
    title: info.command,
    ...(sessionID !== undefined ? { sessionID } : {}),
    started_at: info.time.started,
    ...(info.time.completed !== undefined ? { completed_at: info.time.completed } : {}),
    ...(info.exit !== undefined ? { exit: info.exit } : {}),
    ...(info.signal !== undefined ? { signal: info.signal } : {}),
    file: info.file,
    outputAvailable: true,
  }
}

function shellJobSummary(info: Job.Info, recovery: Extract<Job.Recovery, { kind: "shell" }>): Summary {
  return {
    id: info.id,
    kind: "shell",
    status: info.status,
    title: info.title ?? recovery.command,
    sessionID: recovery.sessionID,
    started_at: info.started_at,
    ...(info.completed_at !== undefined ? { completed_at: info.completed_at } : {}),
    outputAvailable: info.output !== undefined,
  }
}

function subagentSummary(info: Job.Info, recovery: Extract<Job.Recovery, { kind: "subagent" }>): Summary {
  return {
    id: info.id,
    kind: "subagent",
    status: info.status,
    title: info.title ?? recovery.description,
    sessionID: recovery.parentSessionID,
    started_at: info.started_at,
    ...(info.completed_at !== undefined ? { completed_at: info.completed_at } : {}),
    outputAvailable: info.output !== undefined,
  }
}

/**
 * Merges the two existing registries into one jobs view; no third registry is
 * created. Shell jobs come from the location's Shell service (list "all", E-A1);
 * subagent jobs come from the process-global Job service. Dedupe is by id: the
 * shell tool registers its Job with id = shellID, so a shell present in both
 * sources collapses to one record that prefers the Job record's title/recovery
 * session and takes file/exit/signal/status from Shell.Info. Either source may
 * be missing (session-shell shells have no Job entry; evicted shells may only
 * remain as a Job entry) — both cases still produce a record.
 */
function collect(shellInfos: ShellWire.Info[], jobInfos: Job.Info[], sessionID?: string) {
  const byID = new Map<string, Summary>()
  for (const info of shellInfos) byID.set(info.id, shellSummary(info))
  for (const info of jobInfos) {
    if (info.recovery?.kind === "subagent") {
      byID.set(info.id, subagentSummary(info, info.recovery))
      continue
    }
    if (info.recovery?.kind === "shell") {
      const existing = byID.get(info.id)
      if (!existing) {
        byID.set(info.id, shellJobSummary(info, info.recovery))
        continue
      }
      byID.set(info.id, {
        ...existing,
        title: info.title ?? existing.title,
        sessionID: info.recovery.sessionID,
      })
      continue
    }
    // Jobs without recovery only join the unified view when their type is unambiguous.
    if (info.type === "subagent") {
      const sessionIDFromMetadata = typeof info.metadata?.sessionID === "string" ? info.metadata.sessionID : undefined
      byID.set(info.id, {
        id: info.id,
        kind: "subagent",
        status: info.status,
        title: info.title ?? info.id,
        ...(sessionIDFromMetadata !== undefined ? { sessionID: sessionIDFromMetadata } : {}),
        started_at: info.started_at,
        ...(info.completed_at !== undefined ? { completed_at: info.completed_at } : {}),
        outputAvailable: info.output !== undefined,
      })
    }
  }
  return Array.from(byID.values())
    .filter((summary) => sessionID === undefined || summary.sessionID === sessionID)
    .toSorted((a, b) => b.started_at - a.started_at)
}

export const JobHandler = HttpApiBuilder.group(Api, "server.job", (handlers) =>
  Effect.gen(function* () {
    const jobs = yield* Job.Service
    const execution = yield* SessionExecution.Service

    const collectForLocation = Effect.fnUntraced(function* (sessionID?: SessionSchema.ID) {
      const shell = yield* Shell.Service
      const shellInfos = yield* shell.list({ status: "all" })
      const jobInfos = yield* jobs.list(sessionID ? { sessionID } : undefined)
      return collect(shellInfos, jobInfos, sessionID)
    })

    return handlers
      .handle(
        "job.list",
        Effect.fn(function* (ctx) {
          return yield* response(collectForLocation(ctx.query.sessionID))
        }),
      )
      .handle(
        "job.get",
        Effect.fn(function* (ctx) {
          const found = (yield* collectForLocation()).find((summary) => summary.id === ctx.params.id)
          if (!found)
            return yield* new JobNotFoundError({ id: ctx.params.id, message: `Job not found: ${ctx.params.id}` })
          return yield* response(Effect.succeed(found))
        }),
      )
      .handle(
        "job.remove",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          const found = (yield* collectForLocation()).find((summary) => summary.id === ctx.params.id)
          if (found?.kind === "subagent") {
            yield* jobs.cancel(ctx.params.id).pipe(Effect.ignore)
            const childSessionID = yield* Effect.try(() => SessionSchema.ID.make(ctx.params.id)).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (childSessionID) yield* execution.interrupt(childSessionID).pipe(Effect.ignore)
            return HttpApiSchema.NoContent.make()
          }
          // Shell kind (or unknown id, kept idempotent like shell.remove): remove from the
          // shell registry and cancel a same-id Job entry when one exists.
          yield* shell
            .remove(ctx.params.id as ShellWire.ID)
            .pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.void))
          if (yield* jobs.get(ctx.params.id)) yield* jobs.cancel(ctx.params.id).pipe(Effect.ignore)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
