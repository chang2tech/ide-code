export * as ApprovalGate from "./gate.js"

import { Effect } from "effect"
import { PolicyLoader, type EffectivePolicy } from "./loader.js"
import { CommandMatcher } from "./matcher.js"
import type { CommandDecision, DecisionState, ParsedCommand } from "./schema.js"

// Approval gate — the single choke point every tool call passes through before
// execution (docs/rea/deep-sandbox.md §4). Check order is verbatim from Cursor's
// agent-exec: admin denylist → delete-file protection → workspace_readonly guard →
// shell allowlist (structural matchForms) → team allow/block → hook FORCE_PROMPT →
// classifier (rules-based here; ML later).

export interface ClassifierResult {
  readonly decision: "ALLOW" | "BLOCK" | "UNSPECIFIED"
  readonly blockReason?: string
  readonly proposedAllowRule?: string
}

// Rules-based classifier standing in for Cursor's SmartModeClassifier (ML).
// Same interface: ALLOW/BLOCK + proposes new allowlist rules from usage.
const DANGEROUS = [
  /^(rm|dd|mkfs|shutdown|reboot|halt|poweroff)\b/,
  /:\(\)\s*\{/, // fork bomb
  /\bmv\b.*\s\/$/,
  /chmod\s+-R\s+777/,
  /curl.*\|\s*(sh|bash)/,
  /wget.*\|\s*(sh|bash)/,
]

const READONLY_SAFE = /^(ls|pwd|echo|cat|head|tail|wc|date|whoami|which|git\s+(status|log|diff|branch))\b/

export const classify = (parsed: ParsedCommand): ClassifierResult => {
  if (DANGEROUS.some((re) => re.test(parsed.raw)))
    return {
      decision: "BLOCK",
      blockReason: `Dangerous command pattern: ${parsed.name}`,
      proposedAllowRule: undefined,
    }
  if (READONLY_SAFE.test(parsed.raw))
    return { decision: "ALLOW", proposedAllowRule: CommandMatcher.suggestAllowlistEntry(parsed) }
  return { decision: "UNSPECIFIED", proposedAllowRule: CommandMatcher.suggestAllowlistEntry(parsed) }
}

export interface GateInput {
  readonly commands: ReadonlyArray<string>
  readonly workspace: string
  readonly requestedSandbox?: "workspace_readonly" | "workspace_readwrite"
}

export const buildDecisionFacts = (
  input: GateInput,
  policy: EffectivePolicy,
): Effect.Effect<ReadonlyArray<CommandDecision>> =>
  Effect.sync(() => {
    // Split shell invocations on command separators for per-command decisions.
    const split = input.commands.flatMap((cmd) =>
      cmd
        .split(/&&|\|\||;/)
        .map((c) => c.trim())
        .filter((c) => c !== ""),
    )
    return split.map((command) => decideOne(command, input, policy))
  })

const decideOne = (command: string, input: GateInput, policy: EffectivePolicy): CommandDecision => {
  const parsed = CommandMatcher.parse(command)
  const deny = (reasons: string[], proposedAllowRule?: string): CommandDecision => ({
    command,
    state: "denied",
    reasons,
    proposedAllowRule,
  })
  const approvable = (reasons: string[], proposedAllowRule?: string): CommandDecision => ({
    command,
    state: "approvable",
    reasons,
    proposedAllowRule,
  })

  // 1. Admin denylist — highest precedence, cannot be overridden.
  if (policy.adminCommandDenylist.some((entry) => CommandMatcher.matchesEntry(entry, parsed)))
    return deny([`Blocked by admin denylist`])

  // 2. Delete-file protection: hard-deny rm.
  if (policy.deleteFileProtection && parsed.name === "rm")
    return deny(["Delete-file protection is on: rm is denied; use the delete tool"])

  // 3. Sandbox read-only guard: never escalate to read-write mid-session.
  if (policy.sandboxPolicyType === "workspace_readonly" && input.requestedSandbox === "workspace_readwrite")
    return deny(["workspace_readonly sandbox cannot escalate to read-write"])

  // 4. Shell allowlist via structural matchForms.
  if (policy.terminalAllowlist !== undefined) {
    if (CommandMatcher.isAllowlisted(policy.terminalAllowlist, parsed)) {
      const redirect = CommandMatcher.redirectSafety(command, input.workspace)
      if (!redirect.safe) return approvable([`Redirect needs review: ${redirect.reason}`])
      return { command, state: "auto", reasons: ["Terminal allowlist match"] }
    }
    // Not allowlisted → fall through to team controls, then prompt.
  }

  // 5. Team allow/block instructions.
  if (policy.blockInstructions.some((entry) => CommandMatcher.matchesEntry(entry, parsed)))
    return deny(["Blocked by team block instructions"])
  if (policy.allowInstructions.some((entry) => CommandMatcher.matchesEntry(entry, parsed)))
    return { command, state: "auto", reasons: ["Team allow instruction match"] }

  // 6. Hook FORCE_PROMPT override (local: forcePrompt patterns).
  if (policy.forcePrompt?.some((entry) => CommandMatcher.matchesEntry(entry, parsed)))
    return approvable(["Forced prompt by policy"])

  // 7. Classifier.
  const result = classify(parsed)
  if (result.decision === "BLOCK")
    return deny(
      [result.blockReason ?? "Blocked by command classifier"],
      result.proposedAllowRule,
    )
  if (result.decision === "ALLOW") return { command, state: "auto", reasons: ["Classifier allow"] }

  // Default: approvable (prompt the user), proposing a precise allow rule.
  const suggested = CommandMatcher.suggestAllowlistEntry(parsed)
  return approvable([`No allowlist match for "${parsed.name}"`], suggested || undefined)
}

// Approval modes gate the approvable state.
export const resolveApprovable = (
  decision: CommandDecision,
  mode: EffectivePolicy["approvalMode"],
): DecisionState => {
  if (decision.state !== "approvable") return decision.state
  if (mode === "unrestricted") return "auto"
  return "approvable" // allowlist + manual both prompt
}

export { PolicyLoader }
