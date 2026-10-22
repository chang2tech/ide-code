export * as HookRunner from "./runner.js"

import { Effect } from "effect"
import type { HookEntry } from "./schema.js"
import { HookVariables } from "./variables.js"

// Hook command execution (docs/rea/parity-rules-mcp.md §C4–C5).
//
// Enforcement contract:
//   exit code 2            → block/deny the operation
//   any other non-zero     → fail-open (operation proceeds) unless
//                            failClosed: true, which blocks instead
//   exit 0                 → allow
//
// A hook may also emit a JSON decision on its last stdout line:
//   {"decision": "allow"|"block"|"ask", "reason": "..."}
// An explicit JSON block/ask wins over the exit code; without it the exit
// code decides. ("ask" in Cursor's Auto-review mode is silently dropped
// upstream; only "deny" is enforced — the runner reports it and lets the
// caller decide.)

export type Decision = "allow" | "block" | "ask"

export interface RunContext {
  readonly home: string
  readonly workspace: string
  readonly version: string
  readonly userEmail: string | undefined
  readonly transcriptPath: string | undefined
}

export interface HookResult {
  readonly decision: Decision
  readonly reason: string | undefined
  readonly output: string
  readonly exitCode: number | null
  readonly timedOut: boolean
}

const DEFAULT_TIMEOUT_S = 60

const parseJsonDecision = (stdout: string): { decision: Decision; reason: string | undefined } | undefined => {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "")
  if (lines.length === 0) return undefined
  const last = lines[lines.length - 1]!
  if (!last.startsWith("{")) return undefined
  try {
    const parsed = JSON.parse(last) as { decision?: unknown; reason?: unknown }
    if (parsed.decision !== "allow" && parsed.decision !== "block" && parsed.decision !== "ask") return undefined
    const reason = typeof parsed.reason === "string" ? parsed.reason : undefined
    return { decision: parsed.decision, reason }
  } catch {
    return undefined
  }
}

export const run = (
  entry: HookEntry,
  command: string,
  input: Record<string, unknown>,
  ctx: RunContext,
): Effect.Effect<HookResult, never> =>
  Effect.gen(function* () {
    const timeoutMs = (entry.timeout ?? DEFAULT_TIMEOUT_S) * 1000
    const expanded = HookVariables.expand(command, { home: ctx.home, workspace: ctx.workspace, input })
    const inputJson = JSON.stringify(input)

    const env: Record<string, string> = { ...process.env }
    env["CURSOR_PROJECT_DIR"] = ctx.workspace
    env["CURSOR_VERSION"] = ctx.version
    if (ctx.userEmail !== undefined) env["CURSOR_USER_EMAIL"] = ctx.userEmail
    if (ctx.transcriptPath !== undefined) env["CURSOR_TRANSCRIPT_PATH"] = ctx.transcriptPath
    env["CURSOR_CODE_REMOTE"] = ""
    env["CLAUDE_PROJECT_DIR"] = ctx.workspace

    const runOnce = (): Promise<HookResult> =>
      new Promise((resolve) => {
        let timedOut = false
        let settled = false
        const finish = (result: HookResult) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        }
        const proc = Bun.spawn(["sh", "-c", expanded], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env,
          cwd: ctx.workspace,
        })
        const timer = setTimeout(() => {
          timedOut = true
          proc.kill()
          finish({
            decision: entry.failClosed === true ? "block" : "allow",
            reason: `hook timed out after ${entry.timeout ?? DEFAULT_TIMEOUT_S}s`,
            output: "",
            exitCode: null,
            timedOut: true,
          })
        }, timeoutMs)
        // Bun.spawn with piped stdin needs explicit end; ignore write errors
        // (the hook may exit before reading).
        try {
          proc.stdin.write(inputJson)
          proc.stdin.end()
        } catch {
          // hook already exited; fall through to exit handling
        }
        proc.exited.then((exitCode) => {
          Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(
            ([stdout, stderr]) => {
              if (timedOut) return
              const output = stdout + (stderr ? `\n${stderr}` : "")
              const json = parseJsonDecision(stdout)
              if (json?.decision === "block")
                return finish({ decision: "block", reason: json.reason, output, exitCode, timedOut: false })
              if (json?.decision === "ask")
                return finish({ decision: "ask", reason: json.reason, output, exitCode, timedOut: false })
              if (exitCode === 2)
                return finish({
                  decision: "block",
                  reason:
                    stderr.trim() ||
                    stdout.trim() ||
                    `Hook blocked this action (exit code 2) but provided no reason.`,
                  output,
                  exitCode,
                  timedOut: false,
                })
              if (exitCode !== 0)
                return finish({
                  decision: entry.failClosed === true ? "block" : "allow",
                  reason: entry.failClosed === true ? `hook failed (exit ${exitCode}) with failClosed: true` : undefined,
                  output,
                  exitCode,
                  timedOut: false,
                })
              finish({ decision: "allow", reason: json?.reason, output, exitCode, timedOut: false })
            },
          )
        })
      })

    return yield* Effect.promise(runOnce)
  })
