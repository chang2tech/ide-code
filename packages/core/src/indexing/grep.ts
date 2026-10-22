export * as InstantGrep from "./grep.js"

/**
 * Instant Grep — Cursor's custom search engine, local-first port.
 *
 * Evidence (cursor.com/docs/context/codebase-indexing, fetched 2026-10-19):
 * "Cursor ships with Instant Grep, a custom search engine that outperforms
 * ripgrep on large codebases. It runs automatically; no configuration needed."
 * "Instant Grep supports full regex and word-boundary matching, so Agent can
 * construct patterns like `import.*PaymentService` or `PaymentFailedError` to
 * trace references across files."
 * "Instant Grep builds and queries its index on your machine. Cursor does not
 * upload file paths or code to build a search index, and it does not store
 * embeddings of your codebase for search."
 *
 * Mechanism (no measured speedup is claimed — see the note on ranking
 * below): trigram pre-filter over the on-machine SQLite index narrows the
 * candidate file set, then the pattern (full regex) is verified line by line
 * on candidates only — an indexed search instead of a full ripgrep scan.
 *
 * DIVERGENCE (honest, do not remove): AST deep-retrieval notes describe
 * Cursor using PushRequestContextService (push-based, server-side grep).
 * The official docs above describe a local index ("builds and queries its
 * index on your machine", "does not upload file paths or code"), which is
 * also the authoritative behavior source for this product's local-first
 * principle. We implement the LOCAL index. If Cursor's server path is ever
 * confirmed as the real retrieval path for grep, this module needs a
 * revisit — until then, UNKNOWN which one Cursor actually serves.
 */

export interface InstantGrepOptions {
  /** Maximum matches to return (default 50). */
  readonly limit?: number
  /**
   * Treat the pattern as a regular expression (default true — grep
   * semantics). When false, the pattern is matched as literal text.
   */
  readonly regex?: boolean
  /**
   * Match only on word boundaries: the pattern is wrapped as
   * `\b(?:pattern)\b` (regex mode) or escaped then wrapped (literal mode).
   * `PaymentFailedError` matches the identifier but not `PaymentFailedErrors`.
   */
  readonly wordBoundary?: boolean
  /** Case-sensitive matching (default false — ripgrep parity needs explicit opt-in). */
  readonly caseSensitive?: boolean
  /** Glob filter on result paths, e.g. "*.ts". */
  readonly include?: string
  /** Glob exclusion on result paths, e.g. "*.test.ts". */
  readonly exclude?: string
}

/** Escape a literal string for use inside a RegExp. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Apply the word-boundary option. The wrapping happens BEFORE trigram
 * extraction: `\b`/`(?:` add no word characters, so the narrowed trigram
 * set is identical to the unwrapped pattern's — narrowing stays sound.
 */
export const applyWordBoundary = (pattern: string, regex: boolean): string =>
  // NOTE: `\\b` — a single backslash in the template literal would be the
  // backspace escape (U+0008), not a regex word boundary.
  `\\b(?:${regex ? pattern : escapeRegExp(pattern)})\\b`

/**
 * Glob (`*`/`?`) to anchored RegExp, shared by include/exclude filters.
 * Same semantics as the index service's existing include filter.
 */
export const globToRegExp = (glob: string | undefined): RegExp | undefined => {
  if (!glob) return undefined
  const src = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${src}$`)
}

/**
 * Ranking contract (mechanism only — no "% faster than ripgrep" claim is
 * made anywhere because none was measured): candidates come out of the
 * trigram pre-filter ordered by trigram overlap (files containing more of
 * the pattern's trigrams first), then line order within a file. That is the
 * entire ranking signal; matches are otherwise unweighted.
 */
export const RANKING_NOTE =
  "ranked by trigram overlap (candidate files with more pattern trigrams first), then line order"
