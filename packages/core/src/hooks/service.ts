export * as HookService from "./service.js"

import { Context, Effect, Layer } from "effect"
import { Global } from "@opencode/util/global"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { HookEvents } from "./events.js"
import { HookLoader, type SourceError } from "./loader.js"
import { HookRunner, type Decision, type HookResult } from "./runner.js"
import type { HookEntry } from "./schema.js"

// Cursor-style hooks engine (docs/rea/parity-rules-mcp.md §C).
// fire() runs every matching hook for an event and merges decisions:
// deny > ask > allow. Exit code 2 blocks; any other non-zero exit fails
// open unless the entry sets failClosed: true.

export interface FireInput {
  readonly event: HookEvents.Event
  readonly workspace: string
  readonly payload: Record<string, unknown>
}

export interface FireResult {
  readonly decision: Decision
  readonly reasons: ReadonlyArray<string>
  readonly blocked: boolean
  readonly executed: number
}

export interface LogEntry {
  readonly at: number
  readonly event: HookEvents.Event
  readonly command: string
  readonly decision: Decision
  readonly reason: string | undefined
  readonly exitCode: number | null
  readonly timedOut: boolean
}

export interface Interface {
  readonly fire: (input: FireInput) => Effect.Effect<FireResult, never>
  readonly log: () => Effect.Effect<ReadonlyArray<LogEntry>, never>
  readonly errors: () => Effect.Effect<ReadonlyArray<SourceError>, never>
  readonly reload: (workspace: string) => Effect.Effect<void, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Hooks") {}

const CACHE_TTL_MS = 30_000
const LOG_CAP = 200

const appVersion = (): string => {
  try {
    const pkg = JSON.parse(Bun.file("packages/core/package.json").textSync()) as { version?: unknown }
    return typeof pkg.version === "string" ? pkg.version : "dev"
  } catch {
    return "dev"
  }
}

const matches = (entry: HookEntry, event: HookEvents.Event, payload: Record<string, unknown>): boolean => {
  if (entry.matcher === undefined) return true
  const field = HookEvents.MATCHER_FIELD[event]
  if (field === null) return true
  const value = payload[field]
  if (typeof value !== "string") return false
  try {
    return new RegExp(entry.matcher).test(value)
  } catch {
    return false
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const version = appVersion()
    const home = Global.Path.home
    const cache = new Map<string, { loaded: HookLoader.LoadedHooks; loadedAt: number }>()
    const executions: Array<LogEntry> = []

    const loadAll = (workspace: string) =>
      Effect.gen(function* () {
        const cached = cache.get(workspace)
        if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.loaded
        const loaded = yield* HookLoader.load({ home, workspace })
        cache.set(workspace, { loaded, loadedAt: Date.now() })
        return loaded
      })

    const fire: Interface["fire"] = (input) =>
      Effect.gen(function* () {
        const loaded = yield* loadAll(input.workspace)
        const entries = loaded.hooks[input.event] ?? []
        const baseInput: Record<string, unknown> = {
          hook_event_name: input.event,
          conversation_id: input.payload["sessionID"] ?? "",
          generation_id: input.payload["messageID"] ?? "",
          model: input.payload["model"] ?? "",
          cursor_version: version,
          workspace_roots: [input.workspace],
          user_email: process.env["CURSOR_USER_EMAIL"] ?? "",
          transcript_path: "",
          ...input.payload,
        }

        let decision: Decision = "allow"
        const reasons: string[] = []
        let executed = 0

        for (const entry of entries) {
          if (!matches(entry, input.event, input.payload)) continue
          executed++
          const result: HookResult = yield* HookRunner.run(
            entry,
            entry.command,
            baseInput,
            {
              home,
              workspace: input.workspace,
              version,
              userEmail: process.env["CURSOR_USER_EMAIL"],
              transcriptPath: undefined,
            },
          )
          executions.push({
            at: Date.now(),
            event: input.event,
            command: entry.command,
            decision: result.decision,
            reason: result.reason,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          })
          if (executions.length > LOG_CAP) executions.splice(0, executions.length - LOG_CAP)

          if (result.decision === "block") {
            decision = "block"
            if (result.reason) reasons.push(result.reason)
            continue
          }
          if (result.decision === "ask" && decision !== "block") {
            decision = "ask"
            if (result.reason) reasons.push(result.reason)
          }
        }

        yield* Effect.logDebug("[hooks]", {
          event: input.event,
          executed,
          decision,
        })
        return { decision, reasons, blocked: decision === "block", executed }
      })

    const log: Interface["log"] = () => Effect.succeed([...executions])

    const errors: Interface["errors"] = () =>
      Effect.gen(function* () {
        // Surface the most recently loaded workspace's config errors.
        const last = [...cache.values()].pop()
        return last?.loaded.errors ?? []
      })

    const reload: Interface["reload"] = (workspace) =>
      Effect.sync(() => {
        cache.delete(workspace)
      })

    return Service.of({ fire, log, errors, reload })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
