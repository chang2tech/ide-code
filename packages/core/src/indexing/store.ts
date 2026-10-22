export * as IndexStore from "./store.js"

import type { Database, SQLQueryBindings, Statement } from "bun:sqlite"

/**
 * SQLite state DB for the local-first codebase index.
 *
 * Reference architecture: Cursor's `file_service.node` retrieval core keeps
 * its snapshot state in a SQLite DB in WAL mode
 * (`docs/rea/dig-native-2026-10-19.md` §3). We mirror that: WAL mode for
 * concurrent readers (search) + one writer (indexer/watcher), busy_timeout
 * for lock contention, explicit checkpoints after bulk writes.
 *
 * Local-first: this DB never leaves the machine. No upload path exists.
 */

export interface FileRow {
  readonly id: number
  readonly path: string
  readonly hash: string
  readonly mtimeMs: number
  readonly size: number
  /** Inode change time — catches mtime-preserving rewrites (P2, QA-INDEXING-01). */
  readonly ctimeMs: number
  readonly language: string
  readonly indexedAt: number
}

export interface SymbolRow {
  readonly fileId: number
  readonly name: string
  readonly kind: string
  readonly line: number
  readonly signature: string
  readonly path: string
}

export interface SymbolInput {
  readonly name: string
  readonly kind: string
  readonly line: number
  readonly signature: string
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  ctime_ms INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT '',
  indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trigrams(
  trigram TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  PRIMARY KEY(trigram, file_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS symbols(
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  signature TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_file_idx ON symbols(file_id);
CREATE TABLE IF NOT EXISTS meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/**
 * Trigram rows per multi-values INSERT (W3-PERF-04). 500 rows = 1,000
 * bindings per statement, well under SQLite's variable limit (32,766),
 * and cuts a 50k-trigram file from 50,000 statement executions to 100,
 * all inside the file's single BEGIN IMMEDIATE … COMMIT (see upsertFile),
 * so the write transaction — and the lock other writers wait on — is held
 * for far less time. Symbol rows are batched the same way (100 × 5 = 500
 * bindings per statement).
 */
const TRIGRAM_INSERT_CHUNK = 500
const SYMBOL_INSERT_CHUNK = 100

export class Store {
  private readonly stmts = new Map<string, Statement<unknown, SQLQueryBindings[]>>()

  private constructor(private readonly db: Database) {}

  /**
   * Cached prepared statement. `Database.run`'s typings don't accept
   * variadic bindings in this bun-types version, while `Statement`
   * does — and caching the prepare also speeds up bulk indexing.
   */
  private stmt<T>(sql: string): Statement<T, SQLQueryBindings[]> {
    const cached = this.stmts.get(sql)
    if (cached) return cached as Statement<T, SQLQueryBindings[]>
    const created = this.db.query<T, SQLQueryBindings[]>(sql)
    this.stmts.set(sql, created as Statement<unknown, SQLQueryBindings[]>)
    return created
  }

  private run(sql: string, ...bindings: SQLQueryBindings[]): void {
    this.stmt(sql).run(...bindings)
  }

  /**
   * Batched trigram insert: multi-values INSERT OR IGNORE in chunks of
   * TRIGRAM_INSERT_CHUNK rows. OR IGNORE semantics are unchanged — a
   * trigram repeated inside the input (or inside one chunk) still lands
   * exactly once via the (trigram, file_id) primary key. Prepared
   * statements are cached per chunk length, so the cache holds at most
   * TRIGRAM_INSERT_CHUNK distinct shapes for this insert.
   */
  private insertTrigrams(fileId: number, trigrams: readonly string[]): void {
    for (let i = 0; i < trigrams.length; i += TRIGRAM_INSERT_CHUNK) {
      const chunk = trigrams.slice(i, i + TRIGRAM_INSERT_CHUNK)
      const placeholders = chunk.map(() => "(?, ?)").join(", ")
      this.run(
        `INSERT OR IGNORE INTO trigrams(trigram, file_id) VALUES${placeholders}`,
        ...chunk.flatMap((t) => [t, fileId] as SQLQueryBindings[]),
      )
    }
  }

  /** Batched symbol insert (same chunking idea as insertTrigrams). */
  private insertSymbols(fileId: number, symbols: readonly SymbolInput[]): void {
    for (let i = 0; i < symbols.length; i += SYMBOL_INSERT_CHUNK) {
      const chunk = symbols.slice(i, i + SYMBOL_INSERT_CHUNK)
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")
      this.run(
        `INSERT INTO symbols(file_id, name, kind, line, signature) VALUES${placeholders}`,
        ...chunk.flatMap((s) => [fileId, s.name, s.kind, s.line, s.signature] as SQLQueryBindings[]),
      )
    }
  }

  static async open(path: string): Promise<Store> {
    const { Database: BunDatabase } = await import("bun:sqlite").catch(() => {
      throw new Error(
        "CodebaseIndex.Store requires the bun runtime (bun:sqlite). " + "The indexing service only runs inside the bun sidecar.",
      )
    })
    const db = new BunDatabase(path, { create: true, readwrite: true })
    db.exec(SCHEMA)
    // Lightweight migration for DBs created before ctime_ms existed:
    // old rows get ctime_ms = 0, which forces one re-index pass.
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(files)").all() as { name: string }[]
    if (!cols.some((c) => c.name === "ctime_ms")) {
      db.exec("ALTER TABLE files ADD COLUMN ctime_ms INTEGER NOT NULL DEFAULT 0")
    }
    return new Store(db)
  }

  close(): void {
    this.db.close()
  }

  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);")
  }

  getFile(path: string): FileRow | undefined {
    return (
      this.stmt<FileRow>(
        "SELECT id, path, hash, mtime_ms AS mtimeMs, size, ctime_ms AS ctimeMs, language, indexed_at AS indexedAt FROM files WHERE path = ?",
      ).get(path) ?? undefined
    )
  }

  listFiles(): Pick<FileRow, "path" | "hash" | "mtimeMs" | "size" | "ctimeMs">[] {
    return this.stmt<Pick<FileRow, "path" | "hash" | "mtimeMs" | "size" | "ctimeMs">>(
      "SELECT path, hash, mtime_ms AS mtimeMs, size, ctime_ms AS ctimeMs FROM files",
    ).all()
  }

  /**
   * Replace a file's index entries atomically (file row + trigrams + symbols)
   * in a single transaction so readers never see a half-indexed file.
   */
  upsertFile(input: {
    path: string
    hash: string
    mtimeMs: number
    size: number
    ctimeMs: number
    language: string
    trigrams: readonly string[]
    symbols: readonly SymbolInput[]
  }): void {
    const run = () => {
      this.run(
        `INSERT INTO files(path, hash, mtime_ms, size, ctime_ms, language, indexed_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, mtime_ms=excluded.mtime_ms,
           size=excluded.size, ctime_ms=excluded.ctime_ms, language=excluded.language, indexed_at=excluded.indexed_at`,
        input.path,
        input.hash,
        input.mtimeMs,
        input.size,
        input.ctimeMs,
        input.language,
        Date.now(),
      )
      const row = this.stmt<{ id: number }>("SELECT id FROM files WHERE path = ?").get(input.path)
      if (!row) throw new Error(`upsertFile: missing row for ${input.path}`)
      this.run("DELETE FROM trigrams WHERE file_id = ?", row.id)
      this.run("DELETE FROM symbols WHERE file_id = ?", row.id)
      // W3-PERF-04: batched multi-values inserts instead of one prepared-
      // statement run per trigram/symbol — still inside this one
      // transaction, so readers see the same atomic replace as before.
      this.insertTrigrams(row.id, input.trigrams)
      this.insertSymbols(row.id, input.symbols)
    }
    this.db.exec("BEGIN IMMEDIATE;")
    try {
      run()
      this.db.exec("COMMIT;")
    } catch (e) {
      this.db.exec("ROLLBACK;")
      throw e
    }
  }

  deleteFile(path: string): void {
    // Deleting a directory drops its whole subtree — nested rows must go
    // too, not just the (absent) directory row itself.
    const match = "path = ? OR path LIKE ? || '/%'"
    const run = () => {
      this.run(`DELETE FROM trigrams WHERE file_id IN (SELECT id FROM files WHERE ${match})`, path, path)
      this.run(`DELETE FROM symbols WHERE file_id IN (SELECT id FROM files WHERE ${match})`, path, path)
      this.run(`DELETE FROM files WHERE ${match}`, path, path)
    }
    this.db.exec("BEGIN IMMEDIATE;")
    try {
      run()
      this.db.exec("COMMIT;")
    } catch (e) {
      this.db.exec("ROLLBACK;")
      throw e
    }
  }

  /**
   * Trigram candidate narrowing for Instant Grep: files containing ALL of the
   * query trigrams.
   */
  searchTrigrams(trigrams: readonly string[], limit: number): { fileId: number; path: string }[] {
    if (trigrams.length === 0) return []
    const placeholders = trigrams.map(() => "?").join(",")
    return this.stmt<{ fileId: number; path: string }>(
      `SELECT t.file_id AS fileId, f.path AS path
         FROM trigrams t JOIN files f ON f.id = t.file_id
         WHERE t.trigram IN (${placeholders})
         GROUP BY t.file_id
         HAVING COUNT(*) >= ${trigrams.length}
         ORDER BY COUNT(*) DESC
         LIMIT ${limit}`,
    ).all(...trigrams)
  }

  searchSymbols(query: string, limit: number): SymbolRow[] {
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`)
    return this.stmt<SymbolRow>(
      `SELECT s.file_id AS fileId, s.name AS name, s.kind AS kind, s.line AS line,
                s.signature AS signature, f.path AS path
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.name LIKE ? ESCAPE '\\'
         ORDER BY
           CASE WHEN s.name = ? THEN 0 WHEN s.name LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
           LENGTH(s.name), s.line
         LIMIT ?`,
    ).all(`%${escaped}%`, query, `${escaped}%`, limit)
  }

  stats(): { files: number; trigrams: number; symbols: number } {
    const one = (sql: string) => this.stmt<{ c: number }>(sql).get()?.c ?? 0
    return {
      files: one("SELECT COUNT(*) AS c FROM files"),
      trigrams: one("SELECT COUNT(*) AS c FROM trigrams"),
      symbols: one("SELECT COUNT(*) AS c FROM symbols"),
    }
  }

  getMeta(key: string): string | undefined {
    return this.stmt<{ value: string }>("SELECT value FROM meta WHERE key = ?").get(key)?.value
  }

  setMeta(key: string, value: string): void {
    this.run("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value)
  }
}
