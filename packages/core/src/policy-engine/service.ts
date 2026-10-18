export * as PolicyEngine from "./service.js"

import { Context, Effect, Layer } from "effect"
import { ToolFailure } from "@opencode/ai"
import { Global } from "@opencode/util/global"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { PolicyLoader, type EffectivePolicy } from "./loader.js"
import { ApprovalGate } from "./gate.js"
import { CommandMatcher } from "./matcher.js"
import { IgnorePolicy } from "./ignore.js"
import { LogRedaction, PolicyLogFields } from "./redaction.js"

// Sandbox substrate seam: the gate decides policy; the substrate enforces it.
// The future ShadowWorkspaceService plugs in here (docs/rea/deep-sandbox.md §3).
// Default substrate is a passthrough — confinement is recorded, not emulated.
export interface SandboxSubstrate {
  readonly name: string
  readonly confine: <A, E, R>(
    policy: "insecure_none" | "workspace_readwrite" | "workspace_readonly",
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export const PassthroughSubstrate: SandboxSubstrate = {
  name: "passthrough",
  confine: (_policy, effect) => effect,
}

export interface GateInput {
  readonly tool: string
  readonly input: unknown
  readonly sessionID: string
  readonly agent: string
  readonly directory: string
}

export type Verdict =
  | { readonly kind: "allow" }
  | { readonly kind: "approvable"; readonly reasons: ReadonlyArray<string> }
  | { readonly kind: "deny"; readonly reasons: ReadonlyArray<string> }

export interface Interface {
  // Single choke point: every tool call is decided here before execution.
  readonly decide: (input: GateInput) => Effect.Effect<Verdict, ToolFailure>
  // File-visibility policy compiled at session start (.ideignore/.cursorignore).
  readonly isVisible: (absolutePath: string, directory: string) => Effect.Effect<boolean>
  readonly reload: (directory: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PolicyEngine") {}

// Safe extraction from unvalidated tool input.
const field = (input: unknown, name: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined
  const value = (input as Record<string, unknown>)[name]
  return typeof value === "string" ? value : undefined
}

const SHELL_COMMANDS = new Set(["shell"])
const FILE_READ_TOOLS = new Set(["read", "glob", "grep", "ls"])
const FILE_WRITE_TOOLS = new Set(["edit", "write", "patch", "delete"])

const logDecision = (input: GateInput, verdict: Verdict) => {
  const redacted = LogRedaction.redactFields({
    tool: { value: input.tool, classification: PolicyLogFields.tool },
    sessionID: { value: input.sessionID, classification: PolicyLogFields.sessionID },
    decision: { value: verdict.kind, classification: PolicyLogFields.decision },
    command: { value: field(input.input, "command"), classification: PolicyLogFields.command },
    path: { value: field(input.input, "path"), classification: PolicyLogFields.path },
  })
  return Effect.logDebug("[policy-engine]", redacted)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cache = new Map<string, { policy: EffectivePolicy; ignore: IgnorePolicy.Compiled }>()
    let substrate: SandboxSubstrate = PassthroughSubstrate

    const loadAll = (directory: string) =>
      Effect.gen(function* () {
        const cached = cache.get(directory)
        if (cached) return cached
        const policy = yield* PolicyLoader.load({ home: Global.Path.home, workspace: directory })
        const ignore = yield* IgnorePolicy.load(directory)
        const entry = { policy, ignore }
        cache.set(directory, entry)
        return entry
      })

    const isVisible: Interface["isVisible"] = (absolutePath, directory) =>
      loadAll(directory).pipe(Effect.map(({ ignore }) => IgnorePolicy.isVisible(ignore, absolutePath, directory)))

    const decide: Interface["decide"] = (input) =>
      Effect.gen(function* () {
        const { policy } = yield* loadAll(input.directory)
        const sandboxPolicy = policy.sandboxPolicyType ?? "insecure_none"

        const run = (verdict: Verdict): Effect.Effect<Verdict, ToolFailure> =>
          logDecision(input, verdict).pipe(Effect.as(verdict))

        // Shell: per-command decision facts through the full check order.
        if (SHELL_COMMANDS.has(input.tool)) {
          const command = field(input.input, "command") ?? ""
          const facts = yield* ApprovalGate.buildDecisionFacts(
            { commands: [command], workspace: input.directory },
            policy,
          )
          const denied = facts.find((f) => f.state === "denied")
          if (denied) return yield* run({ kind: "deny", reasons: denied.reasons })
          const approvable = facts.find((f) => f.state === "approvable")
          if (approvable)
            return yield* run({
              kind: "approvable",
              reasons: approvable.reasons,
            })
          return yield* run({ kind: "allow" })
        }

        // File reads: enforce the compiled visibility policy.
        if (FILE_READ_TOOLS.has(input.tool)) {
          const target = field(input.input, "path") ?? field(input.input, "target_directory")
          if (target !== undefined) {
            const visible = yield* isVisible(target, input.directory)
            if (!visible) return yield* run({ kind: "deny", reasons: [`Path is hidden by ignore policy: ${target}`] })
          }
          return yield* run({ kind: "allow" })
        }

        // File writes: visibility + delete protection for rm-equivalents is handled
        // by the delete tool's own permission flow; the gate enforces visibility.
        if (FILE_WRITE_TOOLS.has(input.tool)) {
          const target = field(input.input, "path")
          if (target !== undefined) {
            const visible = yield* isVisible(target, input.directory)
            if (!visible) return yield* run({ kind: "deny", reasons: [`Path is hidden by ignore policy: ${target}`] })
          }
          return yield* run({ kind: "allow" })
        }

        // MCP tools: server:tool allowlist.
        if (input.tool === "mcp") {
          const server = field(input.input, "server_identifier") ?? field(input.input, "server") ?? ""
          const tool = field(input.input, "tool_name") ?? field(input.input, "tool") ?? ""
          if (policy.mcpAllowlist !== undefined) {
            const ok = policy.mcpAllowlist.some((entry) => CommandMatcher.matchesMcpEntry(entry, server, tool))
            if (!ok) return yield* run({ kind: "deny", reasons: [`MCP tool not allowlisted: ${server}:${tool}`] })
          }
          return yield* run({ kind: "allow" })
        }

        // Everything else: allowed — the tool's own permission flow prompts as configured.
        // (The substrate records the sandbox policy for future enforcement underneath.)
        yield* Effect.sync(() => substrate.confine(sandboxPolicy, Effect.void))
        return yield* run({ kind: "allow" })
      }).pipe(
        Effect.mapError((error) =>
          error instanceof ToolFailure ? error : new ToolFailure({ message: "Policy engine failed", error }),
        ),
      )

    const reload: Interface["reload"] = (directory) =>
      Effect.sync(() => {
        cache.delete(directory)
      })

    return Service.of({ decide, isVisible, reload })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
