export * as IndexWalk from "./walk.js"

import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"

/**
 * Parallel workspace scanner — mirrors the parallel scan workers in Cursor's
 * `crates/gix-snapshot` (`docs/rea/dig-native-2026-10-19.md` §3), minus the
 * git packfile machinery (local-first: we scan the working tree directly).
 *
 * Symlinks are never followed (avoids cycles and double-indexing).
 */

export interface WalkEntry {
  readonly relPath: string
  readonly size: number
  readonly mtimeMs: number
  /**
   * Inode change time. Unlike mtime, ctime cannot be preserved by
   * `cp -p`/`rsync -a`/tar extraction — any rewrite bumps it. The index
   * treats a file as changed when mtime, size, OR ctime differ, so
   * mtime-preserving rewrites are still re-indexed (P2, QA-INDEXING-01).
   */
  readonly ctimeMs: number
}

const STAT_CONCURRENCY = 32

const collectFiles = (
  root: string,
  startDir: string,
  isIgnoredDir: (relPath: string) => boolean,
): Promise<string[]> => {
  const files: string[] = []
  const stack = [startDir]
  const collect = async (): Promise<void> => {
    while (stack.length > 0) {
      const dir = stack.pop()!
      if (isIgnoredDir(dir)) continue
      const entries = await readdir(path.join(root, dir), { withFileTypes: true })
      for (const e of entries) {
        if (e.isSymbolicLink()) continue
        const rel = dir === "" ? e.name : `${dir}/${e.name}`
        if (e.isDirectory()) {
          if (!isIgnoredDir(`${rel}/`)) stack.push(rel)
        } else if (e.isFile()) {
          files.push(rel)
        }
      }
    }
  }
  return collect().then(() => files)
}

const walkFrom = (
  root: string,
  startDir: string,
  isIgnored: (relPath: string) => boolean,
): Effect.Effect<WalkEntry[], Error> =>
  Effect.gen(function* () {
    const rels = yield* Effect.tryPromise({
      try: () => collectFiles(root, startDir, (dir) => isIgnored(dir === "" ? "" : `${dir}/`)),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    })
    const visible = rels.filter((rel) => !isIgnored(rel))
    return yield* Effect.forEach(
      visible,
      (relPath) =>
        Effect.tryPromise({
          try: async () => {
            const st = await stat(path.join(root, relPath))
            const out: WalkEntry = { relPath, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs }
            return out
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          // A file that vanishes between listing and stat is skipped, not a failure.
        }).pipe(Effect.catch(() => Effect.succeed(undefined))),
      { concurrency: STAT_CONCURRENCY },
    ).pipe(Effect.map((rows) => rows.filter((r): r is WalkEntry => r !== undefined)))
  })

/** Walk the workspace, pruning ignored directories and skipping ignored files. */
export const walk = (root: string, isIgnored: (relPath: string) => boolean): Effect.Effect<WalkEntry[], Error> =>
  walkFrom(root, "", isIgnored)

/**
 * Walk a single subtree (used by the watcher when a new directory appears:
 * index its files and seed watchers without re-walking the whole tree).
 */
export const walkSubtree = (
  root: string,
  dirRel: string,
  isIgnored: (relPath: string) => boolean,
): Effect.Effect<WalkEntry[], Error> => walkFrom(root, dirRel, isIgnored)
