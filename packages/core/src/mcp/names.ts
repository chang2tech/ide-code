export * as McpNames from "./names.js"

// Cursor-style MCP tool namespacing: mcp__<server>__<tool>.
// The parser splits on "__": parts[1] is the server, parts[2..] the tool.
// Sanitization guarantees neither part contains "__" so parsing is unambiguous.

const sanitize = (part: string): string => part.replace(/__/g, "_").replace(/[^a-zA-Z0-9_-]/g, "_")

export const toolName = (server: string, tool: string): string =>
  `mcp__${sanitize(server)}__${sanitize(tool)}`

export interface ParsedToolName {
  readonly server: string
  readonly tool: string
}

export const parseToolName = (name: string): ParsedToolName | undefined => {
  if (!name.startsWith("mcp__")) return undefined
  const parts = name.split("__")
  if (parts.length < 3 || parts[1] === "") return undefined
  return { server: parts[1], tool: parts.slice(2).join("__") }
}

export const isMcpToolName = (name: string): boolean => parseToolName(name) !== undefined

// Allowlist label for UI surfaces (Cursor renders "MCP:<tool>").
export const label = (server: string, tool: string): string => `MCP:${tool} (${server})`
