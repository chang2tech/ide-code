export * as HookEvents from "./events.js"

// 21 verified hook events (docs/rea/parity-rules-mcp.md §C1).
// The docs claim 22; the 22nd is unidentified — do not invent one.
export const ALL = [
  "sessionStart",
  "sessionEnd",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "beforeSubmitPrompt",
  "preCompact",
  "stop",
  "afterAgentResponse",
  "afterAgentThought",
  "beforeTabFileRead",
  "afterTabFileEdit",
  "workspaceOpen",
] as const

export type Event = (typeof ALL)[number]

export const isEvent = (value: string): value is Event =>
  (ALL as ReadonlyArray<string>).includes(value)

// Which payload field the `matcher` regex applies to (null = matchers not
// supported for this event; the hook always runs). Per spec §C2:
// subagentStart→subagent type; beforeShellExecution→command text;
// preToolUse→tool type incl. MCP:<tool>; beforeSubmitPrompt→UserPromptSubmit.
export const MATCHER_FIELD: Record<Event, string | null> = {
  sessionStart: null,
  sessionEnd: null,
  preToolUse: "tool",
  postToolUse: "tool",
  postToolUseFailure: "tool",
  subagentStart: "agent",
  subagentStop: "agent",
  beforeShellExecution: "command",
  afterShellExecution: "command",
  beforeMCPExecution: "tool",
  afterMCPExecution: "tool",
  beforeReadFile: "path",
  afterFileEdit: "path",
  beforeSubmitPrompt: "prompt",
  preCompact: null,
  stop: null,
  afterAgentResponse: null,
  afterAgentThought: null,
  beforeTabFileRead: "path",
  afterTabFileEdit: "path",
  workspaceOpen: null,
}

// Events where an exit-code-2 (or explicit deny) actually blocks the operation.
// Post-events and informational events can only observe.
export const BLOCKING: ReadonlySet<Event> = new Set([
  "preToolUse",
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "beforeSubmitPrompt",
  "subagentStart",
])
