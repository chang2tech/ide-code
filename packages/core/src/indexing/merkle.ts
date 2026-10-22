export * as IndexMerkle from "./merkle.js"

import { createHash } from "node:crypto"

/**
 * Merkle tree over the indexed file set — mirrors Cursor's `crates/merkle_tree`
 * (Merkle V2, `docs/rea/dig-native-2026-10-19.md` §3), local-first edition:
 * no server, no packfiles; the tree root is stored in the index DB (`meta`)
 * and used to detect workspace changes cheaply between scans.
 *
 * - leaf  = sha256("blob:" + relPath + ":" + contentHash)
 * - dir   = sha256("tree:" + concat(sorted(childName + childHash)))
 * - root  = hash of the top-level dir node
 */

const sha256 = (parts: string): string => createHash("sha256").update(parts, "utf8").digest("hex")

export const leafHash = (relPath: string, contentHash: string): string => sha256(`blob:${relPath}:${contentHash}`)

export interface FileEntry {
  readonly path: string
  readonly hash: string
}

export interface MerkleTree {
  /** Root hash of the whole tree. */
  readonly root: string
  /** Per-directory hashes, keyed by relative dir path ("" = root). */
  readonly dirs: ReadonlyMap<string, string>
}

/** Build the tree from the current file list. */
export function build(files: readonly FileEntry[]): MerkleTree {
  const dirs = new Map<string, Map<string, string>>()
  const dirOf = (p: string): string => {
    const i = p.lastIndexOf("/")
    return i === -1 ? "" : p.slice(0, i)
  }
  files.forEach((f) => {
    const d = dirOf(f.path)
    const name = d === "" ? f.path : f.path.slice(d.length + 1)
    if (!dirs.has(d)) dirs.set(d, new Map())
    dirs.get(d)!.set(name, leafHash(f.path, f.hash))
  })
  // Fold bottom-up: a dir's hash depends on its children's hashes; since we
  // only track one level of children per dir here, propagate child dir hashes
  // as pseudo-entries named "<child>/".
  const hashes = new Map<string, string>()
  const hashDir = (d: string): string => {
    const cached = hashes.get(d)
    if (cached) return cached
    const children = new Map(dirs.get(d) ?? [])
    dirs.forEach((_, child) => {
      if (child !== d && dirOf(child) === d) children.set(`${child.slice(d === "" ? 0 : d.length + 1)}/`, hashDir(child))
    })
    const body = [...children.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, h]) => `${name}${h}`)
      .join("")
    const h = sha256(`tree:${body}`)
    hashes.set(d, h)
    return h
  }
  // Ensure every ancestor dir exists in the map so nested trees fold correctly.
  files.forEach((f) => {
    let d = dirOf(f.path)
    while (d !== "") {
      if (!dirs.has(d)) dirs.set(d, new Map())
      d = dirOf(d)
    }
  })
  if (!dirs.has("")) dirs.set("", new Map())
  const root = hashDir("")
  return { root, dirs: hashes }
}

/** Diff two file lists by path: added / removed / modified (hash changed). */
export function diff(
  before: readonly FileEntry[],
  after: readonly FileEntry[],
): { added: FileEntry[]; removed: FileEntry[]; modified: FileEntry[] } {
  const prev = new Map(before.map((f) => [f.path, f.hash] as const))
  const next = new Map(after.map((f) => [f.path, f.hash] as const))
  const added = after.filter((f) => !prev.has(f.path))
  const removed = before.filter((f) => !next.has(f.path))
  const modified = after.filter((f) => {
    const h = prev.get(f.path)
    return h !== undefined && h !== f.hash
  })
  return { added, removed, modified }
}
