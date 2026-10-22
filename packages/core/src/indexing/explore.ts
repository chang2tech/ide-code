export * as ExploreAgent from "./explore.js"

import { Agent } from "../agent.js"

/**
 * Built-in Explore subagent.
 *
 * Cursor semantics (`docs/rea/deepdig-runtime-subagent-2026-10-19.md` + the
 * `context-explore-subagent` matrix entry): the agent spawns an Explore
 * subagent with its own context window for broad codebase search; the child
 * returns only summarized findings.
 *
 * Dispatch mapping (observed `SubagentDispatchTool`): our subagent tool call
 * is the TASK dispatch; `backgrounded` is derived from the result status
 * (RUNNING/BACKGROUNDED vs SUCCESS/ERROR/ABORTED, cf. `SubagentRunStatus`).
 * `TargetMachine`: local-first engine supports `same_machine` only — other
 * variants fail honestly instead of pretending to provision.
 */

export const EXPLORE_AGENT_ID = "explore"

/**
 * Tool-name segments (the <tool> part of `mcp__<server>__<tool>`) that are
 * strictly read-only. Grounded in the canonical MCP servers (filesystem,
 * git, fetch, memory, playwright): observation-only tools whose names cannot
 * perform writes, deletes, or command execution. Mirrors the extension's
 * READ_ONLY_MCP_TOOL_NAMES (extensions/ide-agent/src/services/modeService.ts).
 *
 * Fail-closed: the explore agent denies EVERY `mcp__*` tool except these
 * (see the permissions ruleset below — the `mcp__*` deny comes first, the
 * allowlist entries come last so findLast evaluation lets them win). Any
 * unknown or future MCP tool is denied by default; this is the deliberate
 * trade-off the Round B verdicts mandated (deny-by-default beats a
 * name-matching arms race, since real MCP tool names are compound like
 * `write_file` and exact-segment denies can never enumerate them all).
 */
const READ_ONLY_MCP_TOOL_NAMES = [
  // file/content observation (filesystem server)
  "read",
  "read_file",
  "read_text_file",
  "read_media_file",
  "read_multiple_files",
  "read_resource",
  "list_directory",
  "list_directory_with_sizes",
  "list_allowed_directories",
  "list_resources",
  "list_resource_templates",
  "directory_tree",
  "search",
  "search_files",
  "get_file_info",
  // knowledge observation (memory server)
  "read_graph",
  "search_nodes",
  "open_nodes",
  // browser observation (playwright/browser server)
  "screenshot",
  "snapshot",
  "browser_screenshot",
  "browser_snapshot",
  // web content (fetch server)
  "fetch",
  // version-control observation (git server)
  "git_status",
  "git_log",
  "git_diff",
  "git_diff_unstaged",
  "git_diff_staged",
  "git_show",
] as const

/**
 * Read-only MCP tool-name prefixes (`get_*` per the Round B remediation).
 * A tool named `get_<anything>` is observation-shaped; combined with the
 * fail-closed default, the residual risk is a server deliberately
 * misnaming a mutating tool — accepted and documented.
 */
const READ_ONLY_MCP_TOOL_PREFIXES = ["get_"] as const

const SYSTEM_PROMPT = [
  "You are the Explore subagent: a read-only codebase investigation specialist.",
  "You run with your own context window. Answer the exploration question thoroughly, then return ONLY a concise summary of findings.",
  "",
  "Rules:",
  "- NEVER modify files. You have no write/edit/patch/delete/shell access. Investigate with read, grep, glob, ls, and codebase_search.",
  "- Be broad: check multiple candidate locations, follow imports and call chains, search for related symbols.",
  "- Return a summary, not raw dumps: for each finding give the file path, line number, and a one-line explanation of why it matters.",
  "- If the answer is not found, say so explicitly and list where you looked.",
  "- Keep the summary under ~40 lines. The parent agent asks follow-ups when it needs more detail.",
].join("\n")

/**
 * The builtin explore agent definition. A user-configured agent named
 * "explore" always wins over this builtin (see subagent tool fallback).
 *
 * Permissions are read-only: findLast evaluation means the deny rules below
 * must come AFTER the allow-all rule, and the read-only MCP allowlist must
 * come after the `mcp__*` deny so it wins for those names. MCP actions are
 * Cursor-namespaced (`mcp__<server>__<tool>`) with real compound tool names
 * (`write_file`, `edit_file`, ...) — exact-segment denies can never
 * enumerate them all, so the ruleset is fail-closed on `mcp__*`.
 */
export const builtin = (): Agent.Info =>
  Agent.Info.make({
    id: Agent.ID.make(EXPLORE_AGENT_ID),
    name: Agent.Name.make("Explore"),
    request: { settings: {}, headers: {}, body: {} },
    system: SYSTEM_PROMPT,
    description: "Codebase exploration specialist: broad read-only search, returns summarized findings.",
    mode: "subagent",
    hidden: true,
    steps: 50,
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "write", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "patch", resource: "*", effect: "deny" },
      { action: "delete", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      // Explore is a leaf investigator: it must not spawn subagents either
      // (a child could do anything, breaking the read-only guarantee).
      { action: "subagent", resource: "*", effect: "deny" },
      // P2 residual (Round B QA-INDEXING + QA-PLANMODE): fail-closed for MCP
      // tools. The old deny rules matched exact tool segments
      // (`^mcp__.*__write$`) while real MCP tool names are compound
      // (`mcp__filesystem__write_file`) → bypass. Deny every `mcp__*` tool,
      // then re-allow only the read-only names/prefixes below.
      { action: "mcp__*", resource: "*", effect: "deny" },
      ...READ_ONLY_MCP_TOOL_NAMES.map((tool) => ({
        action: `mcp__*__${tool}`,
        resource: "*",
        effect: "allow" as const,
      })),
      ...READ_ONLY_MCP_TOOL_PREFIXES.map((prefix) => ({
        action: `mcp__*__${prefix}*`,
        resource: "*",
        effect: "allow" as const,
      })),
    ],
  })
