export * as ToolAliases from "./aliases.js"

// Provider aliasing layer (docs/rea/deep-agent-tools.md §2): model-facing names
// (Cursor's wire aliases) resolve to one internal implementation. Mirrored so
// prompts authored against Cursor's tool names transfer; do NOT build separate
// tools per alias.

// Map of model-facing (provider-native) name → internal tool name.
export const Aliases: Readonly<Record<string, string>> = {
  // Computer use — all providers collapse to one internal tool.
  ANTHROPIC_COMPUTER_USE: "computer_use",
  GEMINI_COMPUTER_USE: "computer_use",
  OPENAI_COMPUTER_USE: "computer_use",
  // Edits collapse to the internal edit implementation.
  APPLY_PATCH: "edit",
  STR_REPLACE: "edit",
  MULTI_STR_REPLACE: "edit",
  WRITE: "edit",
  EDIT_NOTEBOOK: "edit",
  // Reads.
  READ: "read",
  READ_BUGBOT: "read",
  // Shell.
  SHELL: "shell",
  MINI_SWE_AGENT_BASH: "shell",
  // Search.
  GREP: "grep",
  GREP_BUGBOT: "grep",
  LS_BUGBOT: "ls",
  WEB_SEARCH: "websearch",
  WEB_FETCH: "webfetch",
  X_SEARCH: "x_search",
  FETCH: "webfetch",
  SEMANTIC_SEARCH: "sem_search",
  // Agent control.
  ASK_QUESTION: "question",
  AWAIT: "await",
  CREATE_PLAN: "plan",
  CREATE_PLAN_V2: "plan",
  CREATE_TASK: "subagent",
  TASK: "subagent",
  SEND_TO_TASK: "subagent",
  TODO_WRITE: "todo",
  SWITCH_MODE: "switchmode",
  SEND_FINAL_SUMMARY: "summary",
  SEND_MESSAGE: "communicate",
  SEND_TO_USER: "communicate",
  COMMUNICATE_UPDATE: "communicate",
  REFLECT: "reflect",
  REFLECT_GENERAL: "reflect",
  DELETE: "delete",
  // MCP family.
  MCP: "mcp",
  MCP_AUTH: "mcp_auth",
  GET_MCP_TOOLS: "get_mcp_tools",
  FETCH_MCP_RESOURCE: "mcp-resource",
  LIST_MCP_RESOURCES: "mcp-resource",
  // Cloud / VM.
  SETUP_VM_ENVIRONMENT: "setup_vm_environment",
  FETCH_CLOUD_AGENT_DATA: "fetch_cloud_agent_data",
  SET_ACTIVE_BRANCH: "set_active_branch",
  REPLACE_ENV: "replace_env",
  // SCM / PR.
  CONNECT_SCM: "connect_scm",
  PR_MANAGEMENT: "pr_management",
  BLAME_BY_FILE_PATH_BUGBOT: "blame",
  GET_PR_CODE_TOUR: "get_pr_code_tour",
  UPDATE_PR_CODE_TOUR: "update_pr_code_tour",
  REPORT_BUG: "report_bug",
  REPORT_BUGFIX_RESULTS: "report_bugfix_results",
  RECORD_CI_INVESTIGATION_FINDINGS: "record_ci_investigation",
  // Media.
  GENERATE_IMAGE: "generate_image",
  GENERATE_VIDEO: "generate_video",
  RECORD_SCREEN: "record_screen",
  // Misc.
  CODE_LINEAGE: "ai_attribution",
  MOCK_READ_LINTS: "read_lints",
  SEARCH_CONVERSATIONS: "search_conversations",
  // Tracked tasks.
  CREATE_TRACKED_TASKS: "trackedtask",
  LIST_TRACKED_TASKS: "trackedtask",
  UPDATE_TRACKED_TASKS: "trackedtask",
  DELETE_TRACKED_TASKS: "trackedtask",
  UPDATE_TRACKED_TASK_STATUSES: "trackedtask",
  // Goals.
  CREATE_GOAL: "goal",
  UPDATE_GOAL: "goal",
}

export const resolveAlias = (name: string): string => Aliases[name] ?? name

export const isAlias = (name: string): boolean => name in Aliases
