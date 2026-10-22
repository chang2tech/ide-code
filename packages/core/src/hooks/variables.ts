export * as HookVariables from "./variables.js"

import path from "path"

// Variable expansion for hook commands. The docs list these variables for MCP
// server configs; Cursor 3.25.6 does not expand them client-side at all (0
// hits), so we apply the same set to hooks as an improvement.
// Expanded in: command strings.
export interface ExpansionContext {
  readonly home: string
  readonly workspace: string
  readonly input: Record<string, unknown>
}

export const expand = (template: string, ctx: ExpansionContext): string =>
  template.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    if (name.startsWith("env:")) return process.env[name.slice(4)] ?? ""
    if (name === "userHome") return ctx.home
    if (name === "workspaceFolder") return ctx.workspace
    if (name === "workspaceFolderBasename") return path.basename(ctx.workspace)
    if (name === "pathSeparator" || name === "/") return path.sep
    if (name.startsWith("input:")) {
      const value = ctx.input[name.slice(6)]
      return value === undefined || value === null ? "" : String(value)
    }
    // Unknown variable: leave verbatim so shell-style ${VAR} still works
    // when the command runs through sh -c.
    return match
  })
