export * as McpCursorConfig from "./cursor-config.js"

import { Schema } from "effect"
import type { ServerConfig } from "@opencode/schema/mcp"
import os from "os"
import path from "path"

// Cursor-format mcp.json (docs/rea/parity-rules-mcp.md §B1–B2):
// { "mcpServers": { "<name>": { command, args, env, cwd, url, headers, transportType } } }
// Discovery: <project>/.cursor/mcp.json, ~/.cursor/mcp.json, <project>/.vscode/mcp.json.
// Docs variables are expanded in command/args/env/url/headers:
//   ${env:NAME}, ${userHome}, ${workspaceFolder}, ${workspaceFolderBasename}, ${pathSeparator}, ${/}

const ServerEntry = Schema.Struct({
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  transportType: Schema.optional(Schema.Literal("stdio", "sse", "streamable_http")),
})
type ServerEntry = typeof ServerEntry.Type

const McpJsonFile = Schema.Struct({
  mcpServers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

interface ExpandContext {
  readonly workspaceFolder: string
}

const expandValue = (value: string, ctx: ExpandContext): string =>
  value
    .replace(/\$\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? "")
    .replace(/\$\{userHome\}/g, os.homedir())
    .replace(/\$\{workspaceFolder\}/g, ctx.workspaceFolder)
    .replace(/\$\{workspaceFolderBasename\}/g, path.basename(ctx.workspaceFolder))
    .replace(/\$\{pathSeparator\}/g, path.sep)
    .replace(/\$\{\/\}/g, path.sep)

const expandRecord = (
  record: Record<string, string> | undefined,
  ctx: ExpandContext,
): Record<string, string> | undefined => {
  if (record === undefined) return undefined
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expandValue(v, ctx)]))
}

const toServerConfig = (entry: ServerEntry, ctx: ExpandContext): ServerConfig | undefined => {
  if (entry.command !== undefined) {
    return {
      type: "local",
      command: [expandValue(entry.command, ctx), ...(entry.args ?? []).map((a) => expandValue(a, ctx))],
      cwd: entry.cwd === undefined ? undefined : expandValue(entry.cwd, ctx),
      environment: expandRecord(entry.env, ctx),
    }
  }
  if (entry.url !== undefined) {
    return {
      type: "remote",
      url: expandValue(entry.url, ctx),
      headers: expandRecord(entry.headers, ctx),
      // SSE is the legacy transport; the SDK negotiates the modern protocol by default.
      protocol: entry.transportType === "sse" ? "legacy" : undefined,
    }
  }
  return undefined
}

const readJsonFile = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await Bun.file(file).text())
  } catch {
    return undefined
  }
}

const decodeEntry = (value: unknown): ServerEntry | undefined => {
  const result = Schema.decodeUnknownEither(ServerEntry)(value)
  return result._tag === "Right" ? result.right : undefined
}

/**
 * Load Cursor-format MCP servers for a workspace. Later files override earlier
 * ones on name conflict: project .cursor/mcp.json > ~/.cursor/mcp.json > .vscode/mcp.json.
 * Invalid entries are skipped; a missing file is not an error.
 */
export const load = async (workspaceFolder: string): Promise<Record<string, ServerConfig>> => {
  const ctx: ExpandContext = { workspaceFolder }
  const files = [
    path.join(os.homedir(), ".cursor", "mcp.json"),
    path.join(workspaceFolder, ".vscode", "mcp.json"),
    path.join(workspaceFolder, ".cursor", "mcp.json"),
  ]
  const servers: Record<string, ServerConfig> = {}
  for (const file of files) {
    const raw = await readJsonFile(file)
    if (raw === undefined) continue
    const decoded = Schema.decodeUnknownEither(McpJsonFile)(raw)
    if (decoded._tag !== "Right" || decoded.right.mcpServers === undefined) continue
    for (const [name, value] of Object.entries(decoded.right.mcpServers)) {
      const entry = decodeEntry(value)
      if (entry === undefined) continue
      const config = toServerConfig(entry, ctx)
      if (config !== undefined) servers[name] = config
    }
  }
  return servers
}
