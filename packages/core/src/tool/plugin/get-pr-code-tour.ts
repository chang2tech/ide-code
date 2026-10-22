export * as GetPrCodeTourTool from "./get-pr-code-tour.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { KV } from "../../kv.js"
import { Permission } from "../../permission.js"

// get_pr_code_tour: read the code tour shown on a pull request's page
// (TEAM-ENGINE-1/W1, handler-trap audit follow-up to DEV-GAPS-75/78).
//
// Wire contract — verified by slicing the protobuf-es descriptors in
// the Cursor 3.25.9 bundles (offsets are of the type-name string in
// extensions/cursor-agent-worker/dist/main.js; identical descriptors
// in cursor-agent-exec/dist/main.js @1765077+ and
// cursor-always-local/dist/main.js @841339+; scalar T:9 = string,
// T:3 = int64, T:8 = bool):
//   GetPrCodeTourArgs @507421{
//     no:1 tool_call_id:string, no:2 revision_id?:string,
//     no:3 section_id?:string, no:4 head_sha?:string,
//     no:5 pr_url?:string}
//   PrCodeTourRevisionSnapshot @507721{
//     no:1 revision_id:string, no:2 status:string, no:3 head_sha:string,
//     no:4 feedback:string, no:5 updated_at_ms:int64,
//     no:6 is_current:bool, no:7 markdown:string, no:8 source:string,
//     no:9 pr_url:string, no:10 edited_by_bc_id:string}
//     (all 10 fields non-optional in proto3 — ""/0/false defaults)
//   GetPrCodeTourSuccess @508212{
//     no:1 revisions:PrCodeTourRevisionSnapshot[] (repeated),
//     no:2 section_id?:string}
//   GetPrCodeTourError @508381{no:1 error:string}
//   GetPrCodeTourResult{oneof result: success, error}
// The older deep-agent-tools.md §3.10 note ("Success: only section_id")
// was STALE — the Success carries the revisions list above (corrected
// already by DEV-GAPS-78/W78A; re-verified here).
// `tool_call_id` is wire plumbing supplied by the runtime invocation
// context (context.id), not a model parameter (same pattern as
// reflect.ts / record-ci-investigation.ts), so it is not in Input.
//
// Model-facing parameters — cursor-agent-exec/dist/main.js, zod
// schema `cke` @4175702: ALL optional strings: sectionId ("Section to
// read in full: the 'Visible tour section id' from <pr_code_tour_view>,
// or a section heading. The other sections come back as a one-line
// outline."), headSha ("PR version to read… Defaults to the pull
// request's current head."), revisionId ("…The read fails if the tour
// has changed since."), prUrl ("Pull request whose tour to read, when
// this agent has more than one."). The fork's Input below uses the
// proto snake_case field names, per fork precedent (blame file_path,
// record-ci check_name). The ids come from the <pr_code_tour_view>
// context block the reviewer client injects (exec bundle @2494459:
// "Revision id", "Tour head SHA", "Visible tour section id").
//
// Executor semantics — OBSERVED from Cursor's client execute in the
// exec bundle (`fke` @4179235, description @4179371): inputs are
// trimmed and empty strings treated as unset; a host reader
// readTour({toolCallId, prUrl?, headSha?}) returns at most one tour —
//   reader returns nothing → Success{revisions: []} (NOT an error);
//   revisionId given and ≠ the returned revision → Error
//     "The tour changed after revision …; the PR page now shows
//     revision …. Read it again without revisionId.";
//   sectionId given → resolved against the tour markdown; no match →
//     Error "No tour section matches … Read the tour without
//     sectionId to see its sections."; match → Success{revisions:
//     [snapshot], section_id: <resolved section>}.
// Content rendering mirrors Cursor's render (`hke` @4177401, header
// `pke` @4176574, outline `mke` @4176887): an empty success renders
// "This pull request has no code tour yet for that version. Tell the
// reviewer so; do not compose a tour from the diff in its place.";
// otherwise header line + section outline + the full markdown, or
// `section ${JSON.stringify(section_id)}:` + only that section's
// markdown when a section was resolved.
// This was an alias-only trap: `aliases.ts` mapped GET_PR_CODE_TOUR →
// "get_pr_code_tour" but no tool plugin existed.
//
// HONEST DIVERGENCE: in Cursor the reader is backed by the Origin PR
// tour service — tours are server-generated artifacts fetched for the
// PR page open in the session (a missing host reader fails with
// PrCodeTourReadsUnavailableError, exec bundle @4167982). That service
// does not exist locally and its behavior beyond the client contract
// above is UNKNOWN from static evidence. The fork's local store is
// the engine's durable KV (the same pattern as reflect.ts /
// record-ci-investigation.ts / report-bug.ts): tour snapshots recorded
// under `pr_code_tour:<revision_id>` with the exact proto field names
// are read back here. The writer sibling `update_pr_code_tour` is
// implemented in update-pr-code-tour.ts (TEAM-FORK-WIRE-1/W4) and
// records revisions in exactly this format; until a tour is written
// the store is empty and this tool truthfully returns
// {revisions: []} with Cursor's own empty-tour message instead of
// composing a tour from the diff. Nothing is fabricated: git history
// is never dressed up as a tour. Selection among stored snapshots
// follows the contract: filter by pr_url / head_sha when given;
// otherwise the snapshot marked is_current (falling back to the
// latest updated_at_ms for that PR). Two rendering simplifications,
// stated plainly: the outline lists heading + level + description
// only (Cursor also extracts file anchors and media per section —
// those extraction rules are not fully recoverable statically), and a
// section selector matches a heading's exact text (case-insensitive)
// or its lowercase hyphen slug; Cursor's exact section-id format is
// UNKNOWN.

export const name = "get_pr_code_tour"

export const description = [
  "Read the code tour shown on this pull request's page. Returns the tour's revision id, head SHA and source, an outline of its sections, and the full markdown, or just one section when section_id is set.",
  "When the reviewer asks about the tour or 'this section', pass the ids from <pr_code_tour_view>. This is the only way to see the tour the reviewer is reading: read it here rather than rebuilding a tour from the diff.",
].join("\n")

export const Input = Schema.Struct({
  revision_id: Schema.optionalKey(Schema.String).annotate({
    description:
      "Revision id from <pr_code_tour_view> or an earlier read of this tour. The read fails if the tour has changed since.",
  }),
  section_id: Schema.optionalKey(Schema.String).annotate({
    description:
      "Section to read in full: the 'Visible tour section id' from <pr_code_tour_view>, or a section heading. The other sections come back as a one-line outline.",
  }),
  head_sha: Schema.optionalKey(Schema.String).annotate({
    description: "PR version to read, such as the 'Tour head SHA' from <pr_code_tour_view>. Defaults to the pull request's current head.",
  }),
  pr_url: Schema.optionalKey(Schema.String).annotate({
    description: "Pull request whose tour to read, when this agent has more than one.",
  }),
})

export const Snapshot = Schema.Struct({
  revision_id: Schema.String,
  status: Schema.String,
  head_sha: Schema.String,
  feedback: Schema.String,
  updated_at_ms: Schema.Number,
  is_current: Schema.Boolean,
  markdown: Schema.String,
  source: Schema.String,
  pr_url: Schema.String,
  edited_by_bc_id: Schema.String,
})

export const Output = Schema.Struct({
  revisions: Schema.Array(Snapshot),
  section_id: Schema.optionalKey(Schema.String),
})

const STORE_PREFIX = "pr_code_tour:"
// KV.scan caps its page at 1000 entries; a local tour store beyond
// that is not a real scenario, and selection stays deterministic
// (current / latest) over whatever was scanned.
const MAX_TOURS_SCANNED = 1000
const MAX_OUTLINE_DESCRIPTION_CHARS = 160

type SnapshotValue = typeof Snapshot.Type

// Stored values are untrusted Json from KV: accept only records whose
// fields carry the proto types, defaulting absent fields to the
// proto3 defaults instead of failing the whole read.
const snapshotFromJson = (value: Schema.Json): SnapshotValue | undefined => {
  // Schema.Json is a union whose array branch (JsonArray) has no string
  // index signature, and Array.isArray cannot narrow a readonly JsonArray
  // out of it, so indexing the union fails typecheck (TS7053). JsonObject
  // is the union's object branch ({ readonly [x: string]: Json }): its
  // guard rejects arrays, null and primitives at runtime — exactly the
  // check it replaces — and narrows `value` to a string-indexable record
  // for the field reads below.
  if (!Schema.is(Schema.JsonObject)(value)) return undefined
  const text = (field: string) => {
    const fieldValue = value[field]
    return typeof fieldValue === "string" ? fieldValue : ""
  }
  const revision_id = text("revision_id")
  if (revision_id === "") return undefined
  const updated = value["updated_at_ms"]
  const current = value["is_current"]
  return {
    revision_id,
    status: text("status"),
    head_sha: text("head_sha"),
    feedback: text("feedback"),
    updated_at_ms: typeof updated === "number" && Number.isFinite(updated) ? updated : 0,
    is_current: typeof current === "boolean" ? current : false,
    markdown: text("markdown"),
    source: text("source"),
    pr_url: text("pr_url"),
    edited_by_bc_id: text("edited_by_bc_id"),
  }
}

const selectTour = (
  tours: readonly SnapshotValue[],
  prUrl: string | undefined,
  headSha: string | undefined,
): SnapshotValue | undefined => {
  const forPr = prUrl === undefined ? tours : tours.filter((tour) => tour.pr_url === prUrl)
  if (headSha !== undefined) return forPr.find((tour) => tour.head_sha === headSha)
  const current = forPr.filter((tour) => tour.is_current)
  const pool = current.length > 0 ? current : forPr
  return pool.reduce<SnapshotValue | undefined>(
    (latest, tour) => (latest === undefined || tour.updated_at_ms > latest.updated_at_ms ? tour : latest),
    undefined,
  )
}

interface Section {
  readonly heading: string
  readonly level: number
  readonly description: string
  readonly markdown: string
}

// Splits a tour markdown into ATX-heading sections, skipping fenced
// code blocks, mirroring the outline parser in Cursor's render: each
// section's description is its first prose text, whitespace-collapsed
// and truncated at 160 chars. Lines before the first heading form no
// section (Cursor's parser likewise only outlines headed sections).
const parseSections = (markdown: string): Section[] => {
  const lines = markdown.split("\n")
  const sections: Array<{ heading: string; level: number; description: string; body: string[] }> = []
  let current: (typeof sections)[number] | undefined
  let fence: string | undefined
  for (const line of lines) {
    const trimmedStart = line.trimStart()
    const fenceMatch = trimmedStart.match(/^(`{3,}|~{3,})/)
    if (fenceMatch?.[1] !== undefined) {
      const marker = fenceMatch[1]
      if (fence === undefined) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      current?.body.push(line)
      continue
    }
    if (fence !== undefined) {
      current?.body.push(line)
      continue
    }
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (headingMatch?.[1] !== undefined && headingMatch[2] !== undefined) {
      current = { heading: headingMatch[2], level: headingMatch[1].length, description: "", body: [line] }
      sections.push(current)
      continue
    }
    if (current === undefined) continue
    current.body.push(line)
    if (current.description.length < MAX_OUTLINE_DESCRIPTION_CHARS) {
      const prose = line.replace(/\s+/g, " ").trim()
      if (prose !== "") {
        const joined = current.description === "" ? prose : `${current.description} ${prose}`
        current.description =
          joined.length > MAX_OUTLINE_DESCRIPTION_CHARS ? `${joined.slice(0, MAX_OUTLINE_DESCRIPTION_CHARS)}…` : joined
      }
    }
  }
  return sections.map((section) => ({
    heading: section.heading,
    level: section.level,
    description: section.description,
    markdown: section.body.join("\n").trim(),
  }))
}

const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const renderHeader = (tour: SnapshotValue): string =>
  [
    `revision_id=${tour.revision_id}`,
    `head_sha=${tour.head_sha.length > 0 ? tour.head_sha : "unknown"}`,
    `is_current_head=${tour.is_current}`,
    `source=${tour.source}`,
    ...(tour.edited_by_bc_id.length > 0 ? [`edited_by_agent=${tour.edited_by_bc_id}`] : []),
    `updated_at_ms=${tour.updated_at_ms}`,
    ...(tour.pr_url.length > 0 ? [`pr=${tour.pr_url}`] : []),
  ].join(" ")

const renderOutline = (sections: readonly Section[]): string | undefined => {
  if (sections.length === 0) return undefined
  return [
    "sections:",
    ...sections.map((section) => {
      const parts = [`${JSON.stringify(section.heading)} [h${section.level}]`]
      if (section.description.length > 0) parts.push(`— ${section.description}`)
      return `- ${parts.join(" ")}`
    }),
  ].join("\n")
}

const EMPTY_CONTENT =
  "This pull request has no code tour yet for that version. Tell the reviewer so; do not compose a tour from the diff in its place."

export const Plugin = {
  id: "opencode.tool.get_pr_code_tour",
  effect: Effect.fn("GetPrCodeTourTool.Plugin")(function* (ctx: Context) {
    const kv = yield* KV.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.pr_url ?? context.sessionID],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              // Cursor's execute trims every input and treats an
              // empty string as unset (helper `dke` in the exec
              // bundle).
              const unset = (value: string | undefined): string | undefined => {
                const trimmed = value?.trim() ?? ""
                return trimmed.length > 0 ? trimmed : undefined
              }
              const revisionId = unset(input.revision_id)
              const sectionId = unset(input.section_id)
              const headSha = unset(input.head_sha)
              const prUrl = unset(input.pr_url)

              const scanned = yield* kv.scan({ prefix: STORE_PREFIX, limit: MAX_TOURS_SCANNED })
              const tours = scanned.entries.flatMap((entry) => {
                const snapshot = snapshotFromJson(entry.value)
                return snapshot === undefined ? [] : [snapshot]
              })
              const tour = selectTour(tours, prUrl, headSha)
              if (tour === undefined) return { output: { revisions: [] }, content: EMPTY_CONTENT, metadata: {} }
              if (revisionId !== undefined && revisionId !== tour.revision_id)
                return yield* new ToolFailure({
                  message: `The tour changed after revision ${revisionId}; the PR page now shows revision ${tour.revision_id}. Read it again without revisionId.`,
                })

              const sections = parseSections(tour.markdown)
              const header = renderHeader(tour)
              const outline = renderOutline(sections)
              if (sectionId === undefined) {
                const content = [header, outline, tour.markdown].filter((part) => part !== undefined).join("\n\n")
                return { output: { revisions: [tour] }, content, metadata: {} }
              }
              const section = sections.find(
                (candidate) =>
                  candidate.heading.toLowerCase() === sectionId.toLowerCase() || slug(candidate.heading) === sectionId,
              )
              if (section === undefined)
                return yield* new ToolFailure({
                  message: `No tour section matches ${JSON.stringify(sectionId)}. Read the tour without sectionId to see its sections.`,
                })
              const content = [header, outline, `section ${JSON.stringify(section.heading)}:\n\n${section.markdown}`]
                .filter((part) => part !== undefined)
                .join("\n\n")
              return {
                output: { revisions: [tour], section_id: section.heading },
                content,
                metadata: {},
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: "Get PR code tour tool failed", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
