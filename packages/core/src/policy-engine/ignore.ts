export * as IgnorePolicy from "./ignore.js"

import { Effect } from "effect"
import path from "path"

// .ideignore / .cursorignore → compiled include/exclude patterns attached to the
// file-visibility policy at session start (docs/rea/deep-sandbox.md §6).
// Subset of gitignore semantics: blank lines, `#` comments, `*`/`?` wildcards,
// `**` recursion, trailing `/` = directory, leading `!` = negation.

export interface Compiled {
  readonly include: ReadonlyArray<RegExp>
  readonly exclude: ReadonlyArray<RegExp>
}

const patternToRegExp = (pattern: string): RegExp => {
  let p = pattern.trim()
  if (p === "" || p.startsWith("#")) throw new Error("skip")
  let dirOnly = false
  if (p.endsWith("/")) {
    dirOnly = true
    p = p.slice(0, -1)
  }
  const anchored = p.includes("/")
  let src = ""
  let i = 0
  while (i < p.length) {
    const c = p[i]
    if (c === "*") {
      if (p[i + 1] === "*") {
        src += ".*"
        i += 2
        if (p[i] === "/") i++
        continue
      }
      src += "[^/]*"
    } else if (c === "?") src += "[^/]"
    else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    i++
  }
  const body = anchored ? `^${src}${dirOnly ? "(/|$)" : "(/|$|/.*$)"}` : `(^|/)${src}${dirOnly ? "(/|$)" : "($|/.*$)"}`
  return new RegExp(body)
}

export const compile = (text: string): Compiled => {
  const include: RegExp[] = []
  const exclude: RegExp[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const negated = trimmed.startsWith("!")
    try {
      const re = patternToRegExp(negated ? trimmed.slice(1) : trimmed)
      if (negated) include.push(re)
      else exclude.push(re)
    } catch {
      continue
    }
  }
  return { include, exclude }
}

const DEFAULT_EXCLUDE = ["node_modules/", ".git/", "dist/", "build/", ".DS_Store", "*.log"]

export const defaults = (): Compiled => compile(DEFAULT_EXCLUDE.join("\n"))

// Last matching pattern wins (gitignore semantics).
export const isIgnored = (compiled: Compiled, relativePath: string): boolean => {
  const rel = relativePath.replace(/^\.\//, "")
  let ignored = false
  for (const re of compiled.exclude) if (re.test(rel)) ignored = true
  for (const re of compiled.include) if (re.test(rel)) ignored = false
  return ignored
}

export const isVisible = (compiled: Compiled, absolutePath: string, workspace: string): boolean => {
  const rel = path.relative(workspace, absolutePath)
  if (rel.startsWith("..")) return false
  return !isIgnored(compiled, rel)
}

// Load at session start: .ideignore wins, .cursorignore as compat fallback,
// merged over the defaults. Logs the compiled pattern count (never the values
// of credential-classified fields — patterns are PATH-classified).
export const load = (workspace: string): Effect.Effect<Compiled, never> =>
  Effect.gen(function* () {
    const read = (file: string): Effect.Effect<string | undefined, never> =>
      Effect.tryPromise({
        try: () => Bun.file(file).text(),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    const ours = yield* read(path.join(workspace, ".ideignore"))
    const compat = yield* read(path.join(workspace, ".cursorignore"))
    const base = defaults()
    const extra = compile([ours, compat].filter((t) => t !== undefined).join("\n"))
    return {
      include: [...base.include, ...extra.include],
      exclude: [...base.exclude, ...extra.exclude],
    }
  })
