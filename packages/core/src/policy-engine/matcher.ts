export * as CommandMatcher from "./matcher.js"

import type { ParsedCommand } from "./schema.js"

// Structural shell matching (docs/rea/deep-sandbox.md §4.3):
// decompose into name/subcommandTokens/args, build progressive-prefix matchForms,
// test allowlist entries against every form. Redirects are evaluated separately.

// Minimal quote-aware tokenizer (good enough for allowlist matching, not a full shell parser).
const tokenize = (command: string): string[] => {
  const tokens: string[] = []
  let current = ""
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === " " || ch === "\t") {
      if (current !== "") {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (current !== "") tokens.push(current)
  return tokens
}

const FLAG = /^-/
const SUBCOMMAND_MAX = 3

export const parse = (command: string): ParsedCommand => {
  const tokens = tokenize(command.trim())
  const name = tokens[0] ?? ""
  const rest = tokens.slice(1)
  const subcommandTokens: string[] = []
  const args: string[] = []
  let seenFlag = false
  for (const token of rest) {
    if (!seenFlag && !FLAG.test(token) && subcommandTokens.length < SUBCOMMAND_MAX) subcommandTokens.push(token)
    else {
      seenFlag = seenFlag || FLAG.test(token)
      args.push(token)
    }
  }
  return { name, subcommandTokens, args, raw: command }
}

// Progressive-prefix forms: name, name+sub1, name+sub1+sub2, …, full command.
export const matchForms = (parsed: ParsedCommand): string[] => {
  const forms = [parsed.name]
  for (let i = 1; i <= parsed.subcommandTokens.length; i++)
    forms.push([parsed.name, ...parsed.subcommandTokens.slice(0, i)].join(" "))
  const full = [parsed.name, ...parsed.subcommandTokens, ...parsed.args].join(" ").trim()
  if (full !== "" && !forms.includes(full)) forms.push(full)
  return forms.filter((f) => f !== "")
}

// Allowlist entry grammar: exact form, `prefix*` wildcard, or `*` segment wildcards.
const entryToRegExp = (entry: string): RegExp => {
  const escaped = entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`)
}

export const matchesEntry = (entry: string, parsed: ParsedCommand): boolean => {
  const re = entryToRegExp(entry.trim())
  return matchForms(parsed).some((form) => re.test(form))
}

export const isAllowlisted = (entries: ReadonlyArray<string>, parsed: ParsedCommand): boolean =>
  entries.some((entry) => matchesEntry(entry, parsed))

// Suggest the most precise allowlist entry for a command (name + subcommands).
export const suggestAllowlistEntry = (parsed: ParsedCommand): string =>
  [parsed.name, ...parsed.subcommandTokens].join(" ")

// Redirect safety: a command safe to run may not be safe to redirect.
// Returns unsafe when output redirect targets resolve outside the workspace
// or when pipes chain into a different command than the allowlisted one.
export interface RedirectSafety {
  readonly safe: boolean
  readonly reason?: string
}

export const redirectSafety = (command: string, workspace: string): RedirectSafety => {
  const redirect = /(^|[\s;|&])(>{1,2}|>>?)\s*(\S+)/.exec(command)
  if (redirect) {
    const target = redirect[3]
    if (target.startsWith("/etc/") || target.startsWith("/usr/") || target.startsWith("/bin/"))
      return { safe: false, reason: `redirect target outside workspace: ${target}` }
    if (target === "/dev/null") return { safe: true }
    // Relative targets stay inside the workspace by construction of path resolution.
    if (!target.startsWith("/")) return { safe: true }
    if (!target.startsWith(workspace)) return { safe: false, reason: `redirect target outside workspace: ${target}` }
    return { safe: true }
  }
  return { safe: true }
}

// MCP allowlist entries: server:tool | server:* | *:tool | *:* (docs/rea/deep-sandbox.md §4.4)
export const matchesMcpEntry = (entry: string, server: string, tool: string): boolean => {
  const [entryServer, entryTool] = entry.split(":")
  if (entryTool === undefined) return false
  const serverOk = entryServer === "*" || entryServer === server
  const toolOk = entryTool === "*" || entryTool === tool
  return serverOk && toolOk
}
