#!/usr/bin/env bun
/**
 * Slim one-shot CLI for the local-first codebase index.
 *
 * The VS Code extension's @Codebase provider shells out per query. The full
 * `packages/cli` entry pays ~5s importing the whole command graph before a
 * search even starts (P1, QA-INDEXING-01) — this entry imports only the
 * indexing module graph (Effect + bun:sqlite), so a warm query completes in
 * about a second including bun startup.
 *
 * Usage:
 *   bun cli.ts search [--root DIR] [--json] [--limit N] [--regex] [--symbols]
 *                     [--include GLOB] -- <query>
 *   bun cli.ts grep   [--root DIR] [--json] [--limit N] [--regex|--literal]
 *                     [--word-boundary] [--case-sensitive]
 *                     [--include GLOB] [--exclude GLOB] -- <pattern>
 *   bun cli.ts status [--root DIR] [--json]
 *   bun cli.ts scan   [--root DIR]
 *
 * JSON shapes mirror the `indexing` commands of the full CLI so the
 * extension parses them identically. Exit 0 on success (even with zero
 * matches); non-zero with a stderr message on failure — the extension
 * treats any failure as an honest empty result.
 */

import { EOL } from "node:os"
import { Effect } from "effect"
import { cliLayer } from "./run.js"
import { CodebaseIndex } from "./service.js"

// One-shot processes must not fork the background file watcher.
process.env["IDE_CODE_INDEX_WATCH"] = "0"
if (!process.env["IDE_CODE_SPAWNED_BY"]) process.env["IDE_CODE_SPAWNED_BY"] = "indexing-cli"

const fail = (message: string): never => {
  process.stderr.write(`indexing: ${message}${EOL}`)
  process.exit(1)
}

interface CommonArgs {
  root: string
  json: boolean
}

/** Minimal argv parser: --flag value, --bool, and `--` separating the query. */
const parseArgs = (argv: string[]): { flags: Map<string, string | true>; rest: string[] } => {
  const flags = new Map<string, string | true>()
  const rest: string[] = []
  let sep = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (sep) {
      rest.push(a)
      continue
    }
    if (a === "--") {
      sep = true
      continue
    }
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next)
        i++
      } else {
        flags.set(key, true)
      }
      continue
    }
    rest.push(a)
  }
  return { flags, rest }
}

const commonArgs = (flags: Map<string, string | true>): CommonArgs => {
  const root = flags.get("root")
  return {
    root: typeof root === "string" ? root : process.cwd(),
    json: flags.get("json") === true,
  }
}

const runSearch = (flags: Map<string, string | true>, rest: string[]) =>
  Effect.gen(function* () {
    const { root, json } = commonArgs(flags)
    const query = rest.join(" ")
    if (!query) fail("search: missing query (put it after `--`)")
    const limitRaw = flags.get("limit")
    const limit = typeof limitRaw === "string" ? Number(limitRaw) : 50
    if (!Number.isInteger(limit) || limit < 1) fail("search: --limit must be a positive integer")
    const include = flags.get("include")
    const started = Date.now()
    const result = yield* Effect.gen(function* () {
      const index = yield* CodebaseIndex.Service
      if (flags.get("symbols") === true) {
        const hits = yield* index.searchSymbols(query, { limit })
        return { kind: "symbols" as const, hits, elapsedMs: Date.now() - started }
      }
      const matches = yield* index.searchInstant(query, {
        limit,
        regex: flags.get("regex") === true,
        include: typeof include === "string" ? include : undefined,
      })
      return { kind: "text" as const, matches, elapsedMs: Date.now() - started }
    }).pipe(Effect.provide(cliLayer(root)))

    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }
    if (result.kind === "symbols") {
      if (result.hits.length === 0) process.stdout.write(`No symbols found for "${query}"${EOL}`)
      for (const h of result.hits)
        process.stdout.write(`${h.path}:${h.line} ${h.kind} ${h.name}${h.signature ? ` — ${h.signature}` : ""}${EOL}`)
    } else {
      if (result.matches.length === 0) process.stdout.write(`No matches for "${query}"${EOL}`)
      for (const m of result.matches) process.stdout.write(`${m.path}:${m.line}: ${m.text}${EOL}`)
    }
    process.stderr.write(`(${result.elapsedMs}ms)${EOL}`)
  })

const runGrep = (flags: Map<string, string | true>, rest: string[]) =>
  Effect.gen(function* () {
    const { root, json } = commonArgs(flags)
    const pattern = rest.join(" ")
    if (!pattern) fail("grep: missing pattern (put it after `--`)")
    const limitRaw = flags.get("limit")
    const limit = typeof limitRaw === "string" ? Number(limitRaw) : 50
    if (!Number.isInteger(limit) || limit < 1) fail("grep: --limit must be a positive integer")
    const include = flags.get("include")
    const exclude = flags.get("exclude")
    const started = Date.now()
    const matches = yield* Effect.gen(function* () {
      const index = yield* CodebaseIndex.Service
      return yield* index.instantGrep(pattern, {
        limit,
        regex: flags.get("literal") !== true,
        wordBoundary: flags.get("word-boundary") === true,
        caseSensitive: flags.get("case-sensitive") === true,
        include: typeof include === "string" ? include : undefined,
        exclude: typeof exclude === "string" ? exclude : undefined,
      })
    }).pipe(Effect.provide(cliLayer(root)))

    if (json) {
      process.stdout.write(JSON.stringify({ kind: "grep", matches, elapsedMs: Date.now() - started }, null, 2) + EOL)
      return
    }
    if (matches.length === 0) process.stdout.write(`No matches for "${pattern}"${EOL}`)
    for (const m of matches) process.stdout.write(`${m.path}:${m.line}: ${m.text}${EOL}`)
    process.stderr.write(`(${Date.now() - started}ms)${EOL}`)
  })

const runStatus = (flags: Map<string, string | true>) =>
  Effect.gen(function* () {
    const { root, json } = commonArgs(flags)
    const st = yield* Effect.gen(function* () {
      const index = yield* CodebaseIndex.Service
      return yield* index.status()
    }).pipe(Effect.provide(cliLayer(root)))

    if (json) {
      process.stdout.write(JSON.stringify(st, null, 2) + EOL)
      return
    }
    process.stdout.write(
      [
        `Root: ${st.root}`,
        `Files: ${st.files} | Trigrams: ${st.trigrams} | Symbols: ${st.symbols}`,
        `DB: ${(st.dbBytes / 1024).toFixed(0)} KB`,
        `Merkle root: ${st.merkleRoot ?? "(not indexed)"}`,
        `Last indexed: ${st.lastIndexedAt ? new Date(st.lastIndexedAt).toISOString() : "(never)"}`,
        `Budget paused: ${st.budgetPaused}`,
        `Watching: ${st.watching}`,
        `Partially indexed files: ${st.partialFiles}`,
      ].join(EOL) + EOL,
    )
  })

const runScan = (flags: Map<string, string | true>) =>
  Effect.gen(function* () {
    const { root } = commonArgs(flags)
    const started = Date.now()
    const st = yield* Effect.gen(function* () {
      const index = yield* CodebaseIndex.Service
      yield* index.ensureIndexed()
      return yield* index.status()
    }).pipe(Effect.provide(cliLayer(root)))
    process.stdout.write(
      `Indexed ${st.files} files (${st.trigrams} trigrams, ${st.symbols} symbols) in ${Date.now() - started}ms${EOL}` +
        `Index: ${st.root}/.ide-code/index/codebase.db (${(st.dbBytes / 1024).toFixed(0)} KB)${EOL}` +
        (st.budgetPaused ? `Storage budget paused: heavy extraction skipped${EOL}` : "") +
        (st.partialFiles > 0 ? `Partially indexed files: ${st.partialFiles}${EOL}` : ""),
    )
  })

const main = Effect.gen(function* () {
  const [command, ...argv] = process.argv.slice(2)
  const { flags, rest } = parseArgs(argv)
  if (command === "search") yield* runSearch(flags, rest)
  else if (command === "grep") yield* runGrep(flags, rest)
  else if (command === "status") yield* runStatus(flags)
  else if (command === "scan") yield* runScan(flags)
  else fail(`unknown command "${command ?? ""}" (expected search|grep|status|scan)`)
})

Effect.runPromise(main).catch((e) => {
  fail(e instanceof Error ? e.message : String(e))
})
