export * as CommandMatcher from "./matcher.js"

import type { ParsedCommand } from "./schema.js"

// Structural shell matching (docs/rea/deep-sandbox.md §4.3):
// decompose into name/subcommandTokens/args, build progressive-prefix matchForms,
// test allowlist entries against every form. Redirects are evaluated separately.

// Minimal quote-aware tokenizer (good enough for allowlist matching, not a full shell parser).
// ANSI-C quoting ($'...') is unwrapped to its literal content so `$'rm'` is seen as `rm`.
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
    // ANSI-C quote: $'...' — the $ is syntax, not part of the word.
    if (ch === "$" && command[i + 1] === "'") {
      quote = "'"
      i++
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

// --- Security analysis ----------------------------------------------------

// Detects shell expansion constructs a naive tokenizer cannot see through:
// $(...), `...`, ${...}, <(...). Single-quoted regions are stripped first
// because no expansion occurs inside them; everything else is untrusted.
// NEVER auto-allow a command for which this returns true.
export const hasShellExpansion = (command: string): boolean => {
  const stripped = command.replace(/'[^']*'/g, "")
  return /\$\(|`|\$\{|<\(/.test(stripped)
}

// All tokens in original order (parse() splits them into name/subcommands/args
// but preserves left-to-right order).
const allTokens = (parsed: ParsedCommand): string[] => [
  parsed.name,
  ...parsed.subcommandTokens,
  ...parsed.args,
]

// Basename-normalized command name: /bin/rm → rm. The tokenizer already
// unwraps $'...' ANSI-C quoting; a stray leading $ is stripped defensively.
export const normalizedName = (parsed: ParsedCommand): string => {
  const base = parsed.name.split("/").pop() ?? parsed.name
  return base.startsWith("$") ? base.slice(1) : base
}

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"])
const SIMPLE_WRAPPERS = new Set(["command", "sudo", "doas"])

// Unwrap one level of command indirection: `sh -c 'inner'`, `command rm …`,
// `env FOO=bar rm …`, `sudo rm …`. Returns undefined when there is nothing
// to unwrap.
const unwrapOneLevel = (parsed: ParsedCommand): ParsedCommand | undefined => {
  const name = normalizedName(parsed)
  const tokens = allTokens(parsed)
  if (SHELL_WRAPPERS.has(name)) {
    const cIndex = tokens.findIndex((t, i) => i > 0 && (t === "-c" || t === "--command"))
    if (cIndex >= 0 && cIndex + 1 < tokens.length) return parse(tokens.slice(cIndex + 1).join(" "))
    return undefined
  }
  if (SIMPLE_WRAPPERS.has(name)) {
    const rest = tokens.slice(1)
    if (rest.length > 0) return parse(rest.join(" "))
    return undefined
  }
  if (name === "env") {
    const rest = tokens.slice(1)
    let i = 0
    while (i < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i])) i++
    const remaining = rest.slice(i)
    if (remaining.length > 0) return parse(remaining.join(" "))
    return undefined
  }
  return undefined
}

// True when the command deletes files, after normalizing path-qualified names
// (/bin/rm), unwrapping command/env/sudo/sh -c indirection, and recognizing
// `find … -delete` (which contains no rm token at all).
export const isDeleteOperation = (parsed: ParsedCommand): boolean => {
  const name = normalizedName(parsed)
  if (name === "rm") return true
  if (name === "find" && parsed.args.includes("-delete")) return true
  const inner = unwrapOneLevel(parsed)
  if (inner !== undefined) return isDeleteOperation(inner)
  return false
}

// Redirect safety: a command safe to run may not be safe to redirect.
// Returns unsafe when output redirect targets resolve outside the workspace
// or when pipes chain into a different command than the allowlisted one.
export interface RedirectSafety {
  readonly safe: boolean
  readonly reason?: string
}

export const redirectSafety = (command: string, workspace: string): RedirectSafety => {
  // Pipe into a file-writing program: tee, sponge, dd of=.
  const pipeWriter = /\|\s*&?\s*(tee|sponge)\b/.exec(command)
  if (pipeWriter) return { safe: false, reason: `pipe into file-writing program: ${pipeWriter[1]}` }
  if (/\|\s*&?\s*dd\b[^|]*\bof=/.test(command))
    return { safe: false, reason: "pipe into dd with of= (file write)" }
  // fd-prefixed and merged redirects: 2>, 1>>, &>, >&, |& target. The \d
  // alternative catches `2>` (a bare digit is an fd, not part of a word).
  const redirect = /(^|[\s;|&]|\d)(>{1,2}|&>|>&)\s*(\S+)/.exec(command)
  if (redirect) {
    const target = redirect[3]
    if (target.startsWith("/etc/") || target.startsWith("/usr/") || target.startsWith("/bin/"))
      return { safe: false, reason: `redirect target outside workspace: ${target}` }
    if (target === "/dev/null") return { safe: true }
    // >&2 / 2>&1 style fd targets are not file writes.
    if (/^\d+$/.test(target) || target === "-") return { safe: true }
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
