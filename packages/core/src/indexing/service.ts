export * as CodebaseIndex from "./service.js"

import path from "node:path"
import { watch as fsWatch, statSync, readFileSync } from "node:fs"
import { mkdir, open, unlink } from "node:fs/promises"
import { Context, Effect, Layer, Option, Scope } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Location } from "../location.js"
import { Store } from "./store.js"
import { build as buildMerkle } from "./merkle.js"
import { load as loadIgnore, loadGlobal, compileGlobalText, globalIgnorePath } from "./ignore.js"
import { walk, walkSubtree } from "./walk.js"
import {
  sha256hex,
  isBinary,
  detectLanguage,
  extractTrigrams,
  patternTrigrams,
  extractSymbols,
  MAX_CONTENT_BYTES,
} from "./extract.js"
import { applyWordBoundary, globToRegExp, type InstantGrepOptions } from "./grep.js"

/**
 * Local-first codebase index service.
 *
 *  1. Maintains a SQLite trigram + symbol index of the workspace
 *     (`<root>/.ide-code/index/codebase.db`, WAL mode).
 *  2. Instant Grep: trigram candidate narrowing + verification, <100ms warm
 *     in-process (the one-shot `indexing` CLI used by the editor pays bun
 *     startup + module import on top — see `cli.ts`; claims elsewhere must
 *     state which path they measure).
 *  3. Incremental updates via a file watcher (stale-patch dropping) plus a
 *     cheap mtime-based sync before warm searches.
 *  4. Respects .gitignore/.cursorignore/.cursorindexingignore/.ideignore.
 *  5. Nothing ever leaves the machine — there is no upload path.
 *
 * Reference: Cursor's `file_service.node` retrieval core
 * (`docs/rea/dig-native-2026-10-19.md` §3): merkle_tree change detection,
 * parallel scan workers, SQLite WAL state DB, storage-budget pause, and
 * lock-contention handling. This is the local-first port of that shape.
 */

export interface TextMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

export interface SymbolHit {
  readonly path: string
  readonly name: string
  readonly kind: string
  readonly line: number
  readonly signature: string
}

export interface IndexStatus {
  readonly root: string
  readonly files: number
  readonly trigrams: number
  readonly symbols: number
  readonly dbBytes: number
  readonly merkleRoot: string | undefined
  readonly lastIndexedAt: number | undefined
  readonly budgetPaused: boolean
  readonly watching: boolean
  /**
   * Files indexed with incomplete content in the last scan: trigram set hit
   * MAX_TRIGRAMS_PER_FILE, or file exceeded MAX_CONTENT_BYTES. Queries
   * matching only the unindexed tail of these files return false negatives.
   */
  readonly partialFiles: number
}

export interface SearchOptions {
  readonly limit?: number
  /** Treat the pattern as a regular expression instead of literal text. */
  readonly regex?: boolean
  readonly caseSensitive?: boolean
  readonly include?: string
}

const DEFAULT_LIMIT = 50
/**
 * Cap on files read for queries too short for trigram narrowing (<3 chars).
 * Restored per user directive 2026-10-19 (refined): an uncapped no-match
 * short query reads the whole repo — the cap keeps @Codebase fast, and the
 * search warns honestly (sidecar log) instead of silently truncating.
 */
const CANDIDATE_FILE_CAP = 2000
const MAX_INDEX_BYTES = Number(process.env["IDE_CODE_INDEX_MAX_BYTES"] ?? 512 * 1024 * 1024)
const SYNC_STALE_MS = 30_000
const WATCH_DEBOUNCE_MS = 500
const INDEX_WORKERS = 8
/**
 * Candidate files read in parallel per window in searchCore (W3-PERF-03).
 * Windows are processed in candidate order and results are re-assembled
 * by candidate position before merging, so output order/ranking is
 * identical to the old sequential scan; a new window only starts while
 * fewer than `limit` matches have been collected (the old early stop, at
 * window granularity — at most SEARCH_READ_CONCURRENCY - 1 extra files
 * in the final window may be read past the limit).
 */
const SEARCH_READ_CONCURRENCY = 16

export interface Interface {
  readonly ensureIndexed: () => Effect.Effect<void, Error>
  readonly searchInstant: (pattern: string, opts?: SearchOptions) => Effect.Effect<TextMatch[], Error>
  /**
   * Instant Grep: the agent's grep engine. Trigram pre-filter + full-regex
   * verification over the local index (see `./grep.ts` for the evidence and
   * the ranking contract). `regex` defaults to true (grep semantics);
   * `wordBoundary` wraps the pattern as `\b(?:…)\b`. Ranked
   * {path, line, text} — trigram overlap first, then line order.
   */
  readonly instantGrep: (pattern: string, opts?: InstantGrepOptions) => Effect.Effect<TextMatch[], Error>
  readonly searchSymbols: (query: string, opts?: { limit?: number }) => Effect.Effect<SymbolHit[], Error>
  readonly status: () => Effect.Effect<IndexStatus, Error>
  /** Runs the file watcher until the enclosing scope closes. */
  readonly watch: () => Effect.Effect<void, Error, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodebaseIndex") {}

/**
 * True when a regex pattern contains a top-level alternation (`|` outside
 * character classes and escapes).
 *
 * P2 (QA-INDEXING-01): trigram narrowing requires ALL pattern trigrams
 * (`HAVING COUNT(*) >= n`), but an alternation's branches each contribute
 * their own trigrams — requiring all of them drops every branch (false
 * negatives). Such patterns skip trigram narrowing and scan candidates
 * directly, letting the regex itself verify.
 */
const hasTopLevelAlternation = (pattern: string): boolean => {
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === "\\") {
      i++
      continue
    }
    if (c === "[") inClass = true
    else if (c === "]") inClass = false
    else if (c === "|" && !inClass) return true
  }
  return false
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const root = location.directory
    const indexDir = path.join(root, ".ide-code", "index")
    const dbPath = path.join(indexDir, "codebase.db")
    const lockPath = path.join(indexDir, ".watch.lock")

    let store: Store | undefined
    let watching = false
    let lastSyncAt = 0

    const getStore = Effect.gen(function* () {
      if (store) return store
      yield* Effect.tryPromise({
        try: () => mkdir(indexDir, { recursive: true }),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      })
      store = yield* Effect.tryPromise({
        try: () => Store.open(dbPath),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      })
      return store
    })

    // Bun.file(...).size is synchronous; tryPromise would die on the
    // non-promise return, so use the sync variant and fall back to 0.
    const dbBytes = Effect.try(() => Bun.file(dbPath).size).pipe(Effect.orElseSucceed(() => 0))

    /** Storage-budget pause (mirrors `repack.skipped_storage_budget_pause`). */
    const budgetPaused = Effect.gen(function* () {
      const s = yield* getStore
      const over = (yield* dbBytes) > MAX_INDEX_BYTES
      // P3 (QA-INDEXING-01): the flag used to be sticky forever once set.
      // Re-check the actual size so the pause lifts if the DB shrinks back
      // under budget (e.g. after files were deleted and vacuumed).
      if (s.getMeta("budgetPaused") === "1") {
        if (!over) s.setMeta("budgetPaused", "0")
        return over
      }
      if (over) {
        s.setMeta("budgetPaused", "1")
        return true
      }
      return false
    })

    /**
     * Index (or refresh) a single file's content.
     * Returns whether the file was indexed partially (budget mechanisms).
     */
    const indexContent = (
      s: Store,
      entry: { relPath: string; size: number; mtimeMs: number; ctimeMs: number },
      skipHeavy: boolean,
    ): Effect.Effect<boolean, Error> =>
      Effect.gen(function* () {
        const { relPath, size, mtimeMs, ctimeMs } = entry
        if (size > MAX_CONTENT_BYTES) {
          yield* Effect.try({
            try: () => {
              s.upsertFile({ path: relPath, hash: `size:${size}`, mtimeMs, size, ctimeMs, language: "", trigrams: [], symbols: [] })
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          })
          return true
        }
        // A file that vanishes mid-scan is skipped (None), not a failure.
        const maybeBuf = yield* Effect.tryPromise({
          try: () => Bun.file(path.join(root, relPath)).bytes(),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }).pipe(Effect.option)
        if (Option.isNone(maybeBuf)) return false
        const buf = maybeBuf.value
        const binary = isBinary(buf.subarray(0, 8192))
        const text = binary ? undefined : new TextDecoder().decode(buf)
        const language = binary ? "" : detectLanguage(relPath)
        const heavy = !binary && !skipHeavy && text !== undefined
        const extracted = heavy && text !== undefined ? extractTrigrams(text) : { trigrams: [], truncated: false }
        yield* Effect.try({
          try: () => {
            s.upsertFile({
              path: relPath,
              hash: binary ? `bin:${size}` : sha256hex(buf),
              mtimeMs,
              size,
              ctimeMs,
              language,
              trigrams: extracted.trigrams,
              symbols: text !== undefined && heavy ? extractSymbols(text, language) : [],
            })
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        })
        return extracted.truncated
      })

    const ensureIndexed = Effect.fn("CodebaseIndex.ensureIndexed")(function* () {
      const s = yield* getStore
      const ignore = yield* loadIgnore(root)
      const entries = yield* walk(root, ignore.isIgnored)
      const prev = new Map(
        (yield* Effect.try({
          try: () => s.listFiles(),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        })).map((f) => [f.path, f] as const),
      )
      const next = new Map(entries.map((e) => [e.relPath, e] as const))
      const skipHeavy = yield* budgetPaused
      // P2 (QA-INDEXING-01): mtime/size alone miss mtime-preserving rewrites
      // (cp -p, rsync -a). ctime cannot be preserved by those tools — any
      // rewrite bumps it — so it closes the gap without reading file bodies.
      const changed = entries.filter((e) => {
        const p = prev.get(e.relPath)
        return !p || p.mtimeMs !== e.mtimeMs || p.size !== e.size || p.ctimeMs !== e.ctimeMs
      })
      let partialFiles = 0
      yield* Effect.forEach(
        changed,
        (e) =>
          Effect.gen(function* () {
            if (yield* indexContent(s, e, skipHeavy)) partialFiles++
          }),
        { concurrency: INDEX_WORKERS },
      )
      yield* Effect.forEach([...prev.keys()].filter((p) => !next.has(p)), (p) =>
        Effect.try({
          try: () => s.deleteFile(p),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),
      )
      // P3 (QA-INDEXING-01): the Merkle tree must be built from content
      // hashes (per merkle.ts leaf scheme), not mtimeMs:size — otherwise a
      // mtime-preserving rewrite keeps the same root.
      const indexed = yield* Effect.try({
        try: () => s.listFiles(),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      })
      const tree = buildMerkle(indexed.map((f) => ({ path: f.path, hash: f.hash })))
      yield* Effect.try({
        try: () => {
          s.setMeta("merkleRoot", tree.root)
          s.setMeta("lastIndexedAt", String(Date.now()))
          s.setMeta("partialFiles", String(partialFiles))
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      })
      if ((yield* dbBytes) > MAX_INDEX_BYTES)
        yield* Effect.try({
          try: () => s.setMeta("budgetPaused", "1"),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        })
      yield* Effect.try({
        try: () => s.checkpoint(),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      })
      lastSyncAt = Date.now()
    })

    /**
     * Cheap freshness check: re-index only when the last sync is stale.
     *
     * P1 (QA-INDEXING-01): one-shot CLI invocations are separate processes,
     * so the in-memory lastSyncAt is always 0 and every query paid a full
     * walk. The DB already persists lastIndexedAt — consult it so repeated
     * CLI queries within SYNC_STALE_MS skip the walk (same staleness
     * contract as the in-process path).
     */
    const syncIfStale = Effect.gen(function* () {
      if (Date.now() - lastSyncAt <= SYNC_STALE_MS) return
      const s = yield* getStore
      const persisted = yield* Effect.try({
        try: () => s.getMeta("lastIndexedAt"),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      })
      if (persisted !== undefined && Date.now() - Number(persisted) <= SYNC_STALE_MS) {
        lastSyncAt = Date.now()
        return
      }
      yield* ensureIndexed()
    })

    /**
     * Shared search core: trigram candidate narrowing + line verification.
     * Candidates arrive ranked by trigram overlap (see `Store.searchTrigrams`
     * `ORDER BY COUNT(*) DESC` and `RANKING_NOTE` in `./grep.ts`); lines keep
     * file order. That ordering is the entire ranking signal.
     */
    const searchCore = (input: {
      pattern: string
      regex: boolean
      caseSensitive: boolean
      include?: string
      exclude?: string
      limit: number
    }) =>
      Effect.gen(function* () {
        const { pattern, regex, caseSensitive, limit } = input
        yield* syncIfStale
        const s = yield* getStore
        const include = globToRegExp(input.include)
        const exclude = globToRegExp(input.exclude)
        // P2 (QA-INDEXING-01): regex alternations skip trigram narrowing —
        // requiring ALL branch trigrams would drop every branch.
        const trigrams = regex && hasTopLevelAlternation(pattern) ? [] : patternTrigrams(pattern)
        const flags = caseSensitive ? "" : "i"
        const matcher = (() => {
          if (!regex) return undefined
          try {
            return new RegExp(pattern, flags)
          } catch {
            return null
          }
        })()
        if (matcher === null) return yield* Effect.fail(new Error(`Invalid regular expression: ${pattern}`))
        const needle = caseSensitive ? pattern : pattern.toLowerCase()
        const testLine = (line: string): boolean =>
          matcher ? matcher.test(line) : caseSensitive ? line.includes(pattern) : line.toLowerCase().includes(needle)

        // Trigram narrowing. Patterns too short for trigrams — or regex
        // alternations, where ALL-trigram semantics would drop branches —
        // scan the file list directly, bounded by CANDIDATE_FILE_CAP.
        const narrowed = yield* Effect.try({
          try: () => (trigrams.length > 0 ? s.searchTrigrams(trigrams, 500).map((c) => c.path) : s.listFiles().map((f) => f.path)),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        })
        let candidates = narrowed
        if (trigrams.length === 0 && candidates.length > CANDIDATE_FILE_CAP) {
          yield* Effect.logWarning(
            `CodebaseIndex.search: query too broad (${candidates.length} candidate files); ` +
              `scanning first ${CANDIDATE_FILE_CAP} — refine the query for complete results`,
          )
          candidates = candidates.slice(0, CANDIDATE_FILE_CAP)
        }
        const out: TextMatch[] = []
        // ext-global-ignore: the index may hold entries for files that were
        // ignored after indexing (the next rescan purges them). Never let
        // them surface in retrieval — filter at query time, fresh per query.
        const global = yield* loadGlobal(root)
        // W3-PERF-03: candidate reads used to be a sequential
        // one-file-at-a-time loop. They now run in parallel windows of
        // SEARCH_READ_CONCURRENCY. Effect.forEach returns each window's
        // per-file matches in candidate order (not completion order) and
        // the merge below walks that order, truncating at `limit` exactly
        // where the sequential scan did — same result set, same ranking.
        for (let start = 0; start < candidates.length && out.length < limit; start += SEARCH_READ_CONCURRENCY) {
          const window = candidates.slice(start, start + SEARCH_READ_CONCURRENCY)
          const perFile = yield* Effect.forEach(
            window,
            (rel) =>
              Effect.gen(function* () {
                if (include && !include.test(rel)) return [] as TextMatch[]
                if (exclude && exclude.test(rel)) return [] as TextMatch[]
                if (global.isIgnored(rel)) return [] as TextMatch[]
                // A file that vanishes between narrowing and read is skipped.
                const maybeContent = yield* Effect.tryPromise({
                  try: () => Bun.file(path.join(root, rel)).text(),
                  catch: (e) => (e instanceof Error ? e : new Error(String(e))),
                }).pipe(Effect.option)
                if (Option.isNone(maybeContent)) return [] as TextMatch[]
                const matches: TextMatch[] = []
                maybeContent.value.split("\n").forEach((text, i) => {
                  if (testLine(text)) matches.push({ path: rel, line: i + 1, text: text.trim().slice(0, 200) })
                })
                return matches
              }),
            { concurrency: SEARCH_READ_CONCURRENCY },
          )
          for (const matches of perFile) {
            for (const match of matches) {
              if (out.length >= limit) break
              out.push(match)
            }
            if (out.length >= limit) break
          }
        }
        return out
      })

    const searchInstant = Effect.fn("CodebaseIndex.searchInstant")(function* (pattern: string, opts: SearchOptions = {}) {
      if (pattern.length === 0) return []
      return yield* searchCore({
        pattern,
        regex: opts.regex ?? false,
        caseSensitive: opts.caseSensitive ?? false,
        include: opts.include,
        limit: opts.limit ?? DEFAULT_LIMIT,
      })
    })

    const instantGrep = Effect.fn("CodebaseIndex.instantGrep")(function* (pattern: string, opts: InstantGrepOptions = {}) {
      if (pattern.length === 0) return []
      const regex = opts.regex ?? true
      // Word-boundary wrapping happens before trigram extraction (see
      // `applyWordBoundary`): `\b`/`(?:` add no word characters, so the
      // narrowed trigram set is identical to the unwrapped pattern's.
      const effective = opts.wordBoundary === true ? applyWordBoundary(pattern, regex) : pattern
      return yield* searchCore({
        pattern: effective,
        regex,
        caseSensitive: opts.caseSensitive ?? false,
        include: opts.include,
        exclude: opts.exclude,
        limit: opts.limit ?? DEFAULT_LIMIT,
      })
    })

    const searchSymbols = Effect.fn("CodebaseIndex.searchSymbols")(function* (query: string, opts: { limit?: number } = {}) {
      if (query.length === 0) return []
      yield* syncIfStale
      const s = yield* getStore
      // ext-global-ignore: same stale-entry filtering as searchCore.
      const global = yield* loadGlobal(root)
      return yield* Effect.try({
        try: () =>
          s.searchSymbols(query, opts.limit ?? DEFAULT_LIMIT).map((row) => ({
            path: row.path,
            name: row.name,
            kind: row.kind,
            line: row.line,
            signature: row.signature,
          })).filter((hit) => !global.isIgnored(hit.path)),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      })
    })

    const status = Effect.fn("CodebaseIndex.status")(function* () {
      const s = yield* getStore
      const readStore = <A>(fn: () => A): Effect.Effect<A, Error> =>
        Effect.try({ try: fn, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })
      const st = yield* readStore(() => s.stats())
      const lastIndexed = yield* readStore(() => s.getMeta("lastIndexedAt"))
      const merkleRoot = yield* readStore(() => s.getMeta("merkleRoot"))
      const partialFiles = yield* readStore(() => s.getMeta("partialFiles"))
      return {
        root,
        files: st.files,
        trigrams: st.trigrams,
        symbols: st.symbols,
        dbBytes: yield* dbBytes,
        merkleRoot,
        lastIndexedAt: lastIndexed ? Number(lastIndexed) : undefined,
        budgetPaused: yield* budgetPaused,
        watching,
        partialFiles: partialFiles ? Number(partialFiles) : 0,
      } satisfies IndexStatus
    })

    /** True when the lock file's PID is dead or unreadable (crash recovery). */
    const lockIsStale = Effect.gen(function* () {
      // tryPromise (not promise): an unreadable lock must be None, not a defect.
      const text = yield* Effect.tryPromise({
        try: () => Bun.file(lockPath).text(),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(Effect.option)
      if (Option.isNone(text)) return true
      const pid = Number(text.value.trim())
      if (!Number.isInteger(pid) || pid <= 0) return true
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
      // Known edge (P3-hardening, QA-INDEXING-X3 N1): if the OS recycles the
      // dead watcher's PID for an unrelated process, the lock looks alive
      // forever and no new watcher starts. Impact is degraded freshness
      // only (the 30s stale sync still runs); not worth a start-time check.
    })

    /**
     * Recursive file watcher with stale-patch dropping.
     *
     * Mirrors Cursor's `codebase_snapshot.client.scan.stale_patch_dropped`:
     * if a file changes again while its re-index is in flight, the in-flight
     * result is dropped and the file is re-indexed once more afterwards.
     *
     * Lock contention (`maintenance.lock_contention` analogue): one watcher
     * per workspace via an exclusive lock file holding the owner's PID; a
     * stale lock from a crashed process is reclaimed.
     */
    const watch = (): Effect.Effect<void, Error, Scope.Scope> =>
      Effect.gen(function* () {
        const s = yield* getStore
        const ignore = yield* loadIgnore(root)

        // ext-global-ignore: the IDE rewrites `.ide-code/global-ignore`
        // whenever the `ide.general.globalCursorIgnoreList` setting changes,
        // possibly while this watcher runs. Re-read the file when its mtime
        // moves (one statSync per check — cheap) so new patterns take effect
        // without a sidecar restart. Combines with the load-once project
        // ignore files; the global list wins ("always ignore").
        const globalIgnoreFile = globalIgnorePath(root)
        let globalIgnore = yield* loadGlobal(root)
        let globalIgnoreMtime = -2
        const refreshGlobalIgnore = (): void => {
          let mtime = -1
          try {
            mtime = statSync(globalIgnoreFile).mtimeMs
          } catch {
            // Missing file: treat as empty (mtime -1).
          }
          if (mtime === globalIgnoreMtime) return
          globalIgnoreMtime = mtime
          let text = ""
          try {
            text = readFileSync(globalIgnoreFile, "utf8")
          } catch {
            // Vanished between stat and read: empty.
          }
          globalIgnore = compileGlobalText(text)
        }
        const isIgnoredNow = (rel: string): boolean => {
          refreshGlobalIgnore()
          return globalIgnore.isIgnored(rel) || ignore.isIgnored(rel)
        }

        const tryOpen = (file: string) =>
          Effect.tryPromise({
            try: () => open(file, "wx"),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }).pipe(Effect.option)
        const acquire = Effect.gen(function* () {
          const first = yield* tryOpen(lockPath)
          if (Option.isSome(first)) return first
          if (!(yield* lockIsStale)) return Option.none()
          yield* Effect.tryPromise({
            try: () => unlink(lockPath),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }).pipe(Effect.ignore)
          return yield* tryOpen(lockPath)
        })
        const lock = yield* Effect.acquireRelease(acquire, (fh) =>
          Option.isSome(fh)
            ? Effect.tryPromise({
                try: () => fh.value.close(),
                catch: (e) => (e instanceof Error ? e : new Error(String(e))),
              }).pipe(Effect.ignore)
            : Effect.void,
        )
        if (Option.isNone(lock)) {
          yield* Effect.logInfo("CodebaseIndex.watch: another watcher holds the lock; skipping (lock contention)")
          return
        }
        yield* Effect.tryPromise({
          try: () => Bun.file(lockPath).write(String(process.pid)),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        })
  
        // Process attribution for sandbox/audit, mirroring Cursor's
        // CURSOR_CONVERSATION_ID / CURSOR_REQUEST_ID / CURSOR_SPAWNED_BY_EXTENSION_ID.
        process.env["IDE_CODE_SPAWNED_BY"] = "indexing-watch"
        process.env["IDE_CODE_INDEX_ROOT"] = root
  
        const inFlight = new Set<string>()
        const dirty = new Set<string>()
        const timers = new Map<string, ReturnType<typeof setTimeout>>()
        const watchers = new Map<string, ReturnType<typeof fsWatch>>()
  
        const reindex = (rel: string): void => {
          if (inFlight.has(rel)) {
            dirty.add(rel)
            return
          }
          inFlight.add(rel)
          const finish = () => {
            inFlight.delete(rel)
            if (dirty.delete(rel)) reindex(rel)
          }
          Effect.runPromise(
            Effect.gen(function* () {
              // tryPromise (not promise): a deleted file must be None, not a defect.
              const st = yield* Effect.tryPromise({
                try: () => Bun.file(path.join(root, rel)).stat(),
                catch: (e) => (e instanceof Error ? e : new Error(String(e))),
              }).pipe(Effect.option)
              if (Option.isNone(st)) {
                yield* Effect.try({
                  try: () => s.deleteFile(rel),
                  catch: (e) => (e instanceof Error ? e : new Error(String(e))),
                })
              } else {
                yield* indexContent(
                  s,
                  { relPath: rel, size: st.value.size, mtimeMs: st.value.mtime.getTime(), ctimeMs: st.value.ctime.getTime() },
                  yield* budgetPaused,
                )
              }
            }).pipe(
              Effect.catch((e) => Effect.logWarning(`CodebaseIndex.watch: reindex failed for ${rel}: ${String(e)}`)),
              Effect.ensuring(Effect.sync(finish)),
            ),
          ).catch(() => {})
        }
  
        const schedule = (rel: string): void => {
          if (isIgnoredNow(rel)) return
          const prev = timers.get(rel)
          if (prev) clearTimeout(prev)
          timers.set(rel, setTimeout(() => reindex(rel), WATCH_DEBOUNCE_MS))
        }
  
        const watchDir = (dirRel: string): void => {
          if (watchers.has(dirRel) || isIgnoredNow(dirRel === "" ? "" : `${dirRel}/`)) return
          try {
            const w = fsWatch(path.join(root, dirRel), { persistent: false }, (eventType, filename) => {
              if (!filename) return
              const rel = dirRel === "" ? filename.toString() : `${dirRel}/${filename.toString()}`
              // P3 (QA-INDEXING-01/X3): "rename" fires for creates/deletes.
              // A newly created directory needs its own watcher plus an
              // initial index of its subtree — without this it would only
              // ever be indexed (never watched) via the 30s stale sync.
              if (eventType === "rename") handleRename(rel)
              else schedule(rel)
            })
            w.on("error", () => watchers.delete(dirRel))
            watchers.set(dirRel, w)
          } catch {
            // Directory vanished between walk and watch; ignore.
          }
        }
  
        /**
         * Best-effort handling of created/deleted paths ("rename" events).
         * New directories get watchers (themselves + nested) and an initial
         * subtree index; deleted paths are dropped from the index.
         */
        const handleRename = (rel: string): void => {
          Effect.runPromise(
            Effect.gen(function* () {
              // tryPromise (not promise): a deleted path must be None, not a defect.
              const st = yield* Effect.tryPromise({
                try: () => Bun.file(path.join(root, rel)).stat(),
                catch: (e) => (e instanceof Error ? e : new Error(String(e))),
              }).pipe(Effect.option)
              if (Option.isNone(st)) {
                // Deleted: drop from index, drop watcher if it was a dir.
                yield* Effect.try({
                  try: () => {
                    s.deleteFile(rel)
                    const w = watchers.get(rel)
                    if (w) {
                      w.close()
                      watchers.delete(rel)
                    }
                  },
                  catch: (e) => (e instanceof Error ? e : new Error(String(e))),
                })
                return
              }
              if (st.value.isDirectory()) {
                if (watchers.has(rel) || isIgnoredNow(`${rel}/`)) return
                // Seed watchers for the new dir and any nested dirs, then
                // index the subtree's files.
                const sub = yield* walkSubtree(root, rel, isIgnoredNow).pipe(
                  Effect.catch(() => Effect.succeed([])),
                )
                const dirs = new Set(
                  sub.map((e) => e.relPath.slice(0, e.relPath.lastIndexOf("/"))).filter((d) => d !== ""),
                )
                dirs.add(rel)
                dirs.forEach(watchDir)
                const heavy = yield* budgetPaused
                yield* Effect.forEach(sub, (e) => indexContent(s, e, heavy), { concurrency: INDEX_WORKERS })
                return
              }
              schedule(rel)
            }).pipe(
              Effect.catch((e) => Effect.logWarning(`CodebaseIndex.watch: handleRename failed for ${rel}: ${String(e)}`)),
            ),
          ).catch(() => {})
        }

        // Seed watchers from the current tree. Directories created later are
        // handled by handleRename above (watchers seeded on creation, subtree
        // indexed immediately); anything missed is still picked up by the
        // periodic stale sync (syncIfStale) within SYNC_STALE_MS.
        const entries = yield* walk(root, isIgnoredNow)
        const dirs = new Set(
          entries.map((e) => e.relPath.slice(0, e.relPath.lastIndexOf("/"))).filter((d) => d !== ""),
        )
        dirs.add("")
        dirs.forEach(watchDir)
        watching = true
        yield* Effect.logInfo(`CodebaseIndex.watch: watching ${watchers.size} directories under ${root}`)
  
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            timers.forEach((t) => clearTimeout(t))
            timers.clear()
            watchers.forEach((w) => w.close())
            watchers.clear()
            watching = false
          }),
        )
        yield* Effect.never
      })

    const svc = Service.of({ ensureIndexed, searchInstant, instantGrep, searchSymbols, status, watch })

    // Auto-start the incremental watcher when the service is first built
    // (i.e. when a session in this workspace first needs the index). The
    // watcher lives as long as the sidecar process; the lock file keeps it
    // to one watcher per workspace across processes.
    if (process.env["IDE_CODE_INDEX_WATCH"] !== "0") {
      yield* Effect.forkDetach(
        Effect.scoped(
          Effect.gen(function* () {
            yield* svc.ensureIndexed()
            yield* svc.watch()
          }),
        ).pipe(Effect.catch((e) => Effect.logWarning(`CodebaseIndex auto-watch failed: ${String(e)}`))),
      )
      yield* Effect.logInfo(`CodebaseIndex: auto-watch started for ${root} (IDE_CODE_INDEX_WATCH=0 to disable)`)
    }

    return svc
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node] })

/** Raw layer (without the location-node wrapper) for one-shot CLI/test use. */
export { layer as rawLayer }
