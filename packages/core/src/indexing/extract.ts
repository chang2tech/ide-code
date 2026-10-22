export * as IndexExtract from "./extract.js"

import { createHash } from "node:crypto"

/**
 * Per-file content extraction: content hash, trigram set (Instant Grep),
 * and heuristic symbol tables (definitions per language).
 *
 * Symbol extraction is regex-based and recall-oriented — it powers
 * @Codebase symbol search, not a compiler. Misses are acceptable;
 * false positives are cheap (they just rank lower).
 */

/** Files larger than this get a file row but no trigrams/symbols (index budget). */
export const MAX_CONTENT_BYTES = 2 * 1024 * 1024
/**
 * Cap on trigrams per file to bound the inverted index.
 *
 * Recall trade-off (P3, QA-INDEXING-X2): a file that hits the cap is indexed
 * with a TRUNCATED trigram set — queries matching only the dropped tail
 * return false negatives, with no per-query signal. The truncation is
 * surfaced instead at the workspace level: the service counts truncated
 * files per scan (`partialFiles` in `IndexStatus` / `indexing status`).
 */
const MAX_TRIGRAMS_PER_FILE = 50_000

export interface TrigramResult {
  readonly trigrams: string[]
  /** True when the file hit MAX_TRIGRAMS_PER_FILE and the set is incomplete. */
  readonly truncated: boolean
}

export const sha256hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex")

/** Null byte in the head sample => binary. */
export const isBinary = (head: Uint8Array): boolean => head.includes(0)

const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  cs: "csharp", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", hh: "cpp",
  php: "php", rb: "ruby", swift: "swift", scala: "scala", lua: "lua", sh: "shell",
  sql: "sql", md: "markdown", json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  css: "css", scss: "scss", html: "html", vue: "vue", svelte: "svelte",
}

export const detectLanguage = (relPath: string): string => {
  const i = relPath.lastIndexOf(".")
  if (i === -1) return ""
  return EXT_LANGUAGE[relPath.slice(i + 1).toLowerCase()] ?? ""
}

const WORD_RUN = /[a-z0-9_]+/g

/** Lowercase trigrams over word-character runs (length >= 3). */
export const extractTrigrams = (text: string): TrigramResult => {
  const out = new Set<string>()
  const runs = text.toLowerCase().match(WORD_RUN) ?? []
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]!
    if (run.length < 3) continue
    for (let i = 0; i + 3 <= run.length; i++) {
      out.add(run.slice(i, i + 3))
      if (out.size >= MAX_TRIGRAMS_PER_FILE) {
        // Only "truncated" when unprocessed content actually remains —
        // hitting the cap exactly on the final run is complete, not partial.
        const remaining = runs.slice(r + 1).some((x) => x.length >= 3) || i + 4 <= run.length
        return { trigrams: [...out], truncated: remaining }
      }
    }
  }
  return { trigrams: [...out], truncated: false }
}

/** Trigrams for a search pattern (same normalization as the index). */
export const patternTrigrams = (pattern: string): string[] => {
  const out = new Set<string>()
  for (const run of pattern.toLowerCase().match(WORD_RUN) ?? []) {
    if (run.length < 3) continue
    for (let i = 0; i + 3 <= run.length; i++) out.add(run.slice(i, i + 3))
  }
  return [...out]
}

export interface SymbolDef {
  readonly name: string
  readonly kind: string
  readonly line: number
  readonly signature: string
}

const sig = (line: string): string => line.trim().slice(0, 120)

interface LangRule {
  readonly re: RegExp
  readonly kind: string
  readonly nameGroup: number
}

const RULES: Record<string, LangRule[]> = {
  typescript: [
    { re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/, kind: "function", nameGroup: 1 },
    { re: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: "class", nameGroup: 1 },
    { re: /^(?:export\s+)?interface\s+(\w+)/, kind: "interface", nameGroup: 1 },
    { re: /^(?:export\s+)?type\s+(\w+)\s*=/, kind: "type", nameGroup: 1 },
    { re: /^(?:export\s+)?enum\s+(\w+)/, kind: "enum", nameGroup: 1 },
    { re: /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/, kind: "function", nameGroup: 1 },
    { re: /^\s{2,}(?:(?:public|private|protected|static|async|override|abstract|readonly)\s+)*(\w+)\s*\([^;{}]*\)\s*[{:]/, kind: "method", nameGroup: 1 },
  ],
  javascript: [
    { re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/, kind: "function", nameGroup: 1 },
    { re: /^(?:export\s+)?class\s+(\w+)/, kind: "class", nameGroup: 1 },
    { re: /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/, kind: "function", nameGroup: 1 },
    { re: /^\s{2,}(?:(?:static|async|get|set)\s+)*(\w+)\s*\([^;{}]*\)\s*\{/, kind: "method", nameGroup: 1 },
  ],
  python: [
    { re: /^class\s+(\w+)/, kind: "class", nameGroup: 1 },
    { re: /^(?:async\s+)?def\s+(\w+)/, kind: "function", nameGroup: 1 },
    { re: /^\s{4,}(?:async\s+)?def\s+(\w+)/, kind: "method", nameGroup: 1 },
  ],
  go: [
    { re: /^func\s+(?:\([^)]*\)\s+)?(\w+)/, kind: "function", nameGroup: 1 },
    { re: /^type\s+(\w+)\s+(?:struct|interface)/, kind: "type", nameGroup: 1 },
    { re: /^type\s+(\w+)\s*=/, kind: "type", nameGroup: 1 },
  ],
  rust: [
    { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, kind: "function", nameGroup: 1 },
    { re: /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait)\s+(\w+)/, kind: "type", nameGroup: 2 },
  ],
  java: [
    { re: /(?:class|interface|enum)\s+(\w+)/, kind: "class", nameGroup: 1 },
    { re: /^\s{2,}(?:(?:public|private|protected|static|final|synchronized|native)\s+)+[\w<>\[\]]+\s+(\w+)\s*\(/, kind: "method", nameGroup: 1 },
  ],
  kotlin: [
    { re: /^(?:open|data|sealed|abstract\s+)*(?:class|interface|object|enum\s+class)\s+(\w+)/, kind: "class", nameGroup: 1 },
    { re: /^\s*(?:fun\s+)(\w+)/, kind: "function", nameGroup: 1 },
  ],
  csharp: [
    { re: /(?:class|interface|enum|struct)\s+(\w+)/, kind: "class", nameGroup: 1 },
    { re: /^\s{2,}(?:(?:public|private|protected|internal|static|virtual|override|async)\s+)+[\w<>\[\]]+\s+(\w+)\s*\(/, kind: "method", nameGroup: 1 },
  ],
  c: [
    { re: /^(?:class|struct)\s+(\w+)/, kind: "class", nameGroup: 1 },
    { re: /^[a-zA-Z_][\w\s:*&<>]*?\s+(\w+)\s*\([^;]*\)\s*\{/, kind: "function", nameGroup: 1 },
  ],
  cpp: [
    { re: /^(?:class|struct)\s+(\w+)/, kind: "class", nameGroup: 1 },
    { re: /^[a-zA-Z_][\w\s:*&<>]*?\s+(\w+)\s*\([^;]*\)\s*\{/, kind: "function", nameGroup: 1 },
  ],
  php: [
    { re: /^(?:abstract\s+|final\s+)?class\s+(\w+)/, kind: "class", nameGroup: 1 },
    { re: /^\s*(?:public|private|protected|static|\s)*(?:function\s+)(\w+)/, kind: "function", nameGroup: 1 },
  ],
  ruby: [
    { re: /^\s*class\s+(\w+)/, kind: "class", nameGroup: 1 },
    { re: /^\s*def\s+(\w+)/, kind: "method", nameGroup: 1 },
  ],
  swift: [
    { re: /^(?:public|private|internal|open\s+)?(?:class|struct|enum|protocol)\s+(\w+)/, kind: "class", nameGroup: 1 },
    { re: /^\s*(?:func\s+)(\w+)/, kind: "function", nameGroup: 1 },
  ],
}

export const extractSymbols = (text: string, language: string): SymbolDef[] => {
  const rules = RULES[language]
  if (!rules) return []
  const out: SymbolDef[] = []
  const seen = new Set<string>()
  text.split("\n").forEach((line, i) => {
    for (const rule of rules) {
      const m = rule.re.exec(line)
      if (!m || rule.kind === "") continue
      const name = m[rule.nameGroup]
      if (!name) continue
      const key = `${i}:${name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name, kind: rule.kind, line: i + 1, signature: sig(line) })
      break
    }
  })
  return out
}
