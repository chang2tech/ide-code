export * as IndexIgnore from "./ignore.js"

import path from "node:path"
import { readdir } from "node:fs/promises"
import { Effect } from "effect"
import { IgnorePolicy } from "../policy-engine/ignore.js"

/**
 * Ignore rules for the codebase index.
 *
 * Mirrors Cursor's `crates/cursorignore` + the watched ignore filenames from
 * `docs/rea/deep-retrieval.md` §7 (`.cursorignore`, `.cursorindexingignore`).
 *
 * ext-global-ignore (P1): Cursor's `cursor.general.globalCursorIgnoreList`
 * (AST evidence: dig-ast-ext-2026-10-19 §3; deep-env-config.md §"Global
 * ignore patterns") is mirrored as the `ide.general.globalCursorIgnoreList`
 * setting. The IDE workbench syncs the user's patterns to
 * `<workspace>/.ide-code/global-ignore` (one glob per line, `#` comments,
 * blank lines skipped, `!` negation allowed — same gitignore semantics as
 * the other files). It is SEPARATE from the per-project `.cursorignore`:
 * the same patterns behave as if appended to a `.cursorignore` in every
 * workspace, applied with the HIGHEST precedence ("always ignore").
 *
 * Precedence (later wins, gitignore semantics): defaults < .gitignore <
 * .cursorignore < .cursorindexingignore < .ideignore < global-ignore.
 *
 * The index's own directory (`.ide-code/`) is always excluded.
 *
 * Nested ignore files (DEV-GAPS-101, `index-cursorignore`): the four ignore
 * filenames are also honoured in subdirectories, each scoped to the
 * directory that contains it — the way git itself applies nested
 * `.gitignore` files. Cursor evidence: the 3.25.9 workbench
 * `CursorIgnoreService.loadIgnoreMapping` discovers ignore files with a
 * globstar file-search pattern for the filename (any depth) and compiles each one
 * keyed by its containing directory, testing paths relative to that
 * directory (`shouldIgnoreUriWithWorkspaceFolders`); the retrieval core
 * has a dedicated Rust `crates/cursorignore` in its snapshot walk
 * (`file_service.linux-x64-gnu.node` strings). A nested scope's last
 * matching pattern overrides shallower scopes for paths beneath it.
 */

const INDEX_DIR = ".ide-code/"

/**
 * Workspace-relative path of the synced global ignore file. This exact path
 * is a cross-process contract with the IDE workbench
 * (`src/vs/workbench/contrib/composer/electron-browser/globalIgnoreSync.ts`),
 * which rewrites the file whenever the setting changes.
 */
export const GLOBAL_IGNORE_REL = ".ide-code/global-ignore"

export const globalIgnorePath = (workspace: string): string => path.join(workspace, GLOBAL_IGNORE_REL)

const IGNORE_FILES = [".gitignore", ".cursorignore", ".cursorindexingignore", ".ideignore"] as const

/**
 * Secret-bearing filenames excluded from the index by default (P3-hardening,
 * QA-INDEXING-01: secrets in non-gitignored files were indexed verbatim).
 * Local-first means the bytes never leave the machine, but there is no
 * reason to keep credential material in a queryable SQLite DB either.
 * Users can re-include with a `!` negation in .gitignore/.ideignore
 * (later patterns win); .gitignore remains the primary control.
 */
const SECRET_DEFAULTS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_dsa*",
  "id_ed25519*",
  "*.p12",
  "*.pfx",
  "secrets.*",
  "credentials.*",
]

export interface Compiled {
  readonly isIgnored: (relativePath: string) => boolean
}

const readIfExists = (file: string): Effect.Effect<string | undefined, never> =>
  Effect.tryPromise({
    try: () => Bun.file(file).text(),
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))

/** One directory's ignore files, compiled: patterns apply to paths under `base`. */
interface ScopedIgnore {
  readonly base: string
  readonly patterns: ReadonlyArray<IgnorePolicy.Pattern>
}

/** Last matching pattern's verdict in one scope, or undefined when nothing matches. */
const scopeDecision = (patterns: ReadonlyArray<IgnorePolicy.Pattern>, rel: string): boolean | undefined => {
  let decision: boolean | undefined
  for (const pattern of patterns) if (pattern.re.test(rel)) decision = !pattern.include
  return decision
}

/**
 * Evaluate a workspace-relative path against the root pattern list plus the
 * nested scopes (ordered shallow → deep). A scope only governs paths
 * strictly beneath its directory — never the directory itself — and its
 * verdict, when it has a matching pattern, overrides shallower scopes.
 */
const evaluate = (
  rootPatterns: ReadonlyArray<IgnorePolicy.Pattern>,
  scopes: ReadonlyArray<ScopedIgnore>,
  relativePath: string,
): boolean => {
  const rel = relativePath.replace(/^\.\//, "")
  let ignored = scopeDecision(rootPatterns, rel) ?? false
  for (const scope of scopes) {
    if (!rel.startsWith(`${scope.base}/`)) continue
    const sub = rel.slice(scope.base.length + 1)
    if (sub === "") continue
    const decision = scopeDecision(scope.patterns, sub)
    if (decision !== undefined) ignored = decision
  }
  return ignored
}

const readDirIgnoreFiles = async (dirAbs: string): Promise<IgnorePolicy.Compiled> => {
  const texts: string[] = []
  for (const f of IGNORE_FILES) {
    const text = await Bun.file(path.join(dirAbs, f))
      .text()
      .catch(() => undefined)
    if (text !== undefined) texts.push(text)
  }
  return IgnorePolicy.compile(texts.join("\n"))
}

/**
 * Discover nested ignore files below the workspace root. Mirrors `walk.ts`:
 * symlinks are never followed, and directories already ignored by the
 * patterns accumulated so far are pruned (their ignore files cannot
 * re-include anything, git-style). `.git/` is never descended into.
 * Discovery failures degrade to "no nested scopes", never to a failed load.
 */
const discoverNested = (
  workspace: string,
  rootPatterns: ReadonlyArray<IgnorePolicy.Pattern>,
): Effect.Effect<ScopedIgnore[], never> =>
  Effect.tryPromise({
    try: async () => {
      const scopes: ScopedIgnore[] = []
      const stack: Array<{ dir: string; inherited: ScopedIgnore[] }> = [{ dir: "", inherited: [] }]
      while (stack.length > 0) {
        const { dir, inherited } = stack.pop()!
        let chain = inherited
        if (dir !== "") {
          const compiled = await readDirIgnoreFiles(path.join(workspace, dir))
          if (compiled.patterns.length > 0) {
            const scope: ScopedIgnore = { base: dir, patterns: compiled.patterns }
            scopes.push(scope)
            chain = [...inherited, scope]
          }
        }
        const entries = await readdir(path.join(workspace, dir), { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          if (entry.isSymbolicLink() || !entry.isDirectory()) continue
          if (entry.name === ".git") continue
          const rel = dir === "" ? entry.name : `${dir}/${entry.name}`
          if (evaluate(rootPatterns, chain, `${rel}/`)) continue
          stack.push({ dir: rel, inherited: chain })
        }
      }
      // DFS order interleaves branches; evaluation needs shallow → deep.
      return scopes.toSorted((a, b) => a.base.split("/").length - b.base.split("/").length)
    },
    catch: () => [] as ScopedIgnore[],
  }).pipe(Effect.catch(() => Effect.succeed([] as ScopedIgnore[])))

export const load = (workspace: string): Effect.Effect<Compiled, never> =>
  Effect.gen(function* () {
    const texts = yield* Effect.all(IGNORE_FILES.map((f) => readIfExists(path.join(workspace, f))))
    const extra = IgnorePolicy.compile(texts.filter((t): t is string => t !== undefined).join("\n"))
    const base = IgnorePolicy.defaults()
    const secrets = IgnorePolicy.compile(SECRET_DEFAULTS.join("\n"))
    const self = IgnorePolicy.compile(INDEX_DIR)
    // ext-global-ignore: the global list behaves as if appended to a
    // `.cursorignore` in every workspace — highest precedence, "always
    // ignore". Read last so its patterns win over project-level negations.
    const global = yield* loadGlobalRaw(workspace)
    const patterns = [...base.patterns, ...secrets.patterns, ...extra.patterns, ...self.patterns, ...global.patterns]
    // DEV-GAPS-101: nested `.gitignore`/`.cursorignore`/`.cursorindexingignore`
    // files, each scoped to its own directory (see the header note).
    const nested = yield* discoverNested(workspace, patterns)
    return {
      isIgnored: (relativePath: string) =>
        nested.length === 0
          ? IgnorePolicy.isIgnored({ patterns }, relativePath)
          : evaluate(patterns, nested, relativePath),
    }
  })

const loadGlobalRaw = (workspace: string): Effect.Effect<IgnorePolicy.Compiled, never> =>
  Effect.gen(function* () {
    const text = yield* readIfExists(globalIgnorePath(workspace))
    return IgnorePolicy.compile(text ?? "")
  })

/**
 * ext-global-ignore: compile ONLY the synced global ignore file
 * (`<workspace>/.ide-code/global-ignore`). Used for query-time filtering of
 * stale index entries: a file ignored after it was indexed must never
 * surface in retrieval results, even before the next rescan purges it.
 * Missing file → empty (never throws).
 */
export const loadGlobal = (workspace: string): Effect.Effect<Compiled, never> =>
  Effect.map(loadGlobalRaw(workspace), (compiled) => ({
    isIgnored: (relativePath: string) => IgnorePolicy.isIgnored(compiled, relativePath),
  }))

/**
 * ext-global-ignore: synchronous compile of global-ignore file text, for the
 * long-lived file watcher's mtime-checked refresh (service.ts). Same
 * semantics as `loadGlobal`; no I/O here.
 */
export const compileGlobalText = (text: string): Compiled => {
  const compiled = IgnorePolicy.compile(text)
  return {
    isIgnored: (relativePath: string) => IgnorePolicy.isIgnored(compiled, relativePath),
  }
}
