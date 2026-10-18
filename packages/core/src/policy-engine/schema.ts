export * as PolicySchema from "./schema.js"

import { Schema } from "effect"

// Mirrors the recovered .cursor/permissions.json structure (docs/rea/deep-sandbox.md §2.1),
// namespaced-neutral so .ide/permissions.json and .cursor/permissions.json share it.
export const ApprovalMode = Schema.Literals(["allowlist", "unrestricted", "manual"])
export type ApprovalMode = typeof ApprovalMode.Type

const AutoControls = Schema.Struct({
  allow_instructions: Schema.optionalKey(Schema.Array(Schema.String)),
  block_instructions: Schema.optionalKey(Schema.Array(Schema.String)),
})

export const PermissionsFile = Schema.Struct({
  mcpAllowlist: Schema.optionalKey(Schema.Array(Schema.String)),
  terminalAllowlist: Schema.optionalKey(Schema.Array(Schema.String)),
  approvalMode: Schema.optionalKey(ApprovalMode),
  autoRun: Schema.optionalKey(AutoControls),
  autoReview: Schema.optionalKey(AutoControls),
  deleteFileProtection: Schema.optionalKey(Schema.Boolean),
  adminCommandDenylist: Schema.optionalKey(Schema.Array(Schema.String)),
  isAdminControlled: Schema.optionalKey(Schema.Boolean),
  sandboxPolicyType: Schema.optionalKey(
    Schema.Literals(["insecure_none", "workspace_readwrite", "workspace_readonly"]),
  ),
  // Our-namespace extension: patterns (matchForms grammar) that always force a user
  // prompt, the local equivalent of Cursor's hook FORCE_PROMPT override.
  forcePrompt: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type PermissionsFile = typeof PermissionsFile.Type

// Per-command decision states (docs/rea/deep-sandbox.md §4.1)
export const DecisionState = Schema.Literals(["denied", "approvable", "auto"])
export type DecisionState = typeof DecisionState.Type

export const CommandDecision = Schema.Struct({
  command: Schema.String,
  state: DecisionState,
  reasons: Schema.Array(Schema.String),
  proposedAllowRule: Schema.optionalKey(Schema.String),
})
export type CommandDecision = typeof CommandDecision.Type

// Field classification for logging hygiene (docs/rea/deep-sandbox.md §7)
export const FieldClassification = Schema.Literals(["SAFE", "CODE", "PATH", "CREDENTIALS"])
export type FieldClassification = typeof FieldClassification.Type

// Parsed shell command for structural matching (docs/rea/deep-sandbox.md §4.3)
export const ParsedCommand = Schema.Struct({
  name: Schema.String,
  subcommandTokens: Schema.Array(Schema.String),
  args: Schema.Array(Schema.String),
  raw: Schema.String,
})
export type ParsedCommand = typeof ParsedCommand.Type
