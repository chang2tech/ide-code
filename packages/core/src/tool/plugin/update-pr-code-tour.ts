export * as UpdatePrCodeTourTool from "./update-pr-code-tour.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { KV } from "../../kv.js"
import { Permission } from "../../permission.js"

// update_pr_code_tour: edit the code tour shown on a pull request's
// page (TEAM-FORK-WIRE-1/W4, writer sibling of TEAM-ENGINE-1/W1's
// get_pr_code_tour reader).
//
// Wire contract — verified by slicing the protobuf-es descriptors in
// the Cursor 3.25.9 worker bundle
// (extensions/cursor-agent-worker/dist/main.js; scalar T:9 = string):
//   UpdatePrCodeTourExecutionMode enum @508800{
//     0 UNSPECIFIED, 1 SERVER_SCHEDULED, 2 CLIENT_REQUIRED,
//     3 SKIPPED, 4 EDITED}
//   UpdatePrCodeTourArgs @509291{
//     no:1 feedback:string (non-opt), no:2 tool_call_id:string,
//     no:3 base_sha?:string, no:4 head_sha?:string,
//     no:5 source_revision_id?:string, no:6 revision_id?:string,
//     no:7 markdown?:string, no:8 heading?:string,
//     no:9 artifact_path?:string, no:10 artifact_alt?:string,
//     no:11 scope_commit_hashes:string[] (repeated),
//     no:12 explicit_user_prompt?:string, no:13 pr_url?:string}
//   UpdatePrCodeTourSuccess @510196{
//     no:1 revision_id:string, no:2 message:string,
//     no:3 execution_mode:UpdatePrCodeTourExecutionMode}
//   UpdatePrCodeTourError @510408{no:1 error:string}
//   UpdatePrCodeTourResult{oneof result: success, error}
// `tool_call_id` is wire plumbing supplied by the runtime invocation
// context (context.id), not a model parameter (same pattern as
// get-pr-code-tour.ts), so it is not in Input.
//
// Model-facing parameters — cursor-agent-exec/dist/main.js, zod
// schema `rke` immediately before the tool definition `oke`
// (Vz("UPDATE_PR_CODE_TOUR", …) @4171173): only NINE fields are
// model-facing — feedback, revisionId, markdown, heading,
// artifactPath, artifactAlt, sourceRevisionId, explicitUserPrompt,
// prUrl (descriptions quoted verbatim in the Input annotations
// below). base_sha / head_sha / scope_commit_hashes exist in the
// proto but NOT in the model schema, and Cursor's client execute
// never sets them when building the wire Args — they are host-filled.
// The fork's Input still accepts them (proto-faithful, snake_case per
// fork precedent): head_sha seeds the new revision's head_sha;
// base_sha and scope_commit_hashes have no home in the 10-field
// snapshot and are accepted but not persisted (stated divergence).
//
// Executor semantics — OBSERVED from Cursor's client execute (`oke`):
// every input is trimmed and an empty string treated as unset
// (helper XSe); feedback combined with markdown or artifactPath
// throws "cannot mix feedback with markdown or artifactPath";
// markdown combined with artifactPath throws "cannot mix markdown
// with artifactPath"; the command is classified as
//   markdown + heading → patchSection{revisionId?, heading, markdown}
//   markdown alone     → replaceMarkdown{revisionId?, markdown}
//   artifactPath       → attachArtifact{revisionId?, artifact, heading?}
//     (artifact kind via `bSe`: a recording extension (.mp4/.webm)
//     classifies as "recording", anything else as "image")
//   feedback alone     → regenerate{feedback, sourceRevisionId?}
//   none of the above  → throws "provide feedback, markdown, or artifactPath"
// and dispatched to a host: regenerate goes to
// scheduleRegeneration(...), the rest to applyEdit(..., command);
// the host returns the Success{revision_id, message, execution_mode}
// verbatim. Rendering a success shows only `message`.
//
// HONEST DIVERGENCE: the host (applyEdit / scheduleRegeneration) is
// Cursor's server/session side — no implementation exists in any
// client bundle (the only occurrence in the shipped extensions is
// the call site above), so exactly how the server mints revisions is
// UNKNOWN from static evidence. This local writer implements the
// conservative reading of the client contract against the same KV
// store the reader uses (key `pr_code_tour:<revision_id>`, value =
// the exact 10-field PrCodeTourRevisionSnapshot — see
// get-pr-code-tour.ts):
//   - An edit NEVER mutates a stored revision in place. It writes a
//     NEW revision (fresh `rev_<uuid>` id, is_current=true,
//     updated_at_ms=now, the edited markdown) and demotes every
//     other revision for the same pr_url to is_current=false,
//     keeping them in the store — so get_pr_code_tour can still
//     read an old version by head_sha, while passing the old
//     revision_id now fails with Cursor's stale-revision error
//     (the reader compares against the selected current revision).
//     This matches the description's "Your edit is what the PR page
//     shows for this head until the pull request is pushed again."
//   - revision_id, when given, is a guard exactly as the model
//     description states ("the edit is refused if the tour changed
//     after you read it"): it must equal the currently selected
//     revision or the edit fails. The failure wording mirrors the
//     reader's stale message; the host's exact wording is UNKNOWN.
//   - patchSection treats `markdown` as the section's new BODY
//     (per the zod description) and preserves the original heading
//     line; sections split flat at ATX headings and a heading
//     resolves by exact text (case-insensitive) or slug — the same
//     rules as the reader. A missing section fails with the
//     reader's verbatim "No tour section matches …" message.
//   - attachArtifact appends a markdown media line
//     `![alt](artifact_path)` at the end of the target section —
//     the given heading, or the LAST section when no heading is
//     given. DIVERGENCE: Cursor defaults to the last FILE-ANCHORED
//     section; the writer does not reproduce the renderer's anchor
//     extraction, and how the host embeds a recording (vs. an
//     image) is UNKNOWN — both kinds use the markdown media line
//     locally and the reader surfaces the path either way.
//   - feedback-only regeneration writes NOTHING and returns
//     execution_mode "SKIPPED": in Cursor regeneration is
//     SERVER_SCHEDULED work performed by a server-side generator
//     that does not exist locally; composing a tour locally from
//     feedback prose would fabricate the artifact this tool exists
//     to keep truthful (cf. the reader's "do not compose a tour
//     from the diff"). The returned revision_id is the current
//     revision's (or "" when there is no tour) and the message says
//     plainly that nothing changed.
//   - edited_by_bc_id is always "": a background-composer id does
//     not exist locally and none is fabricated, so the reader does
//     not render `edited_by_agent=` for locally written revisions.
//   - A replaceMarkdown against a PR with no tour yet CREATES the
//     first revision (status "ready", source "local"); patch and
//     attach against a missing tour fail, since there is no
//     section to target. status / source / feedback are inherited
//     from the previous revision when one exists.
// execution_mode is returned as the enum's localName string
// ("EDITED" / "SKIPPED"), following the fork's enum-as-string
// precedent (search_conversations returns source "LOCAL").

export const name = "update_pr_code_tour"

export const description = [
  "Edit the code tour shown on this pull request's page, for its current head. Replace the whole markdown, patch one section by heading or section id, attach an image or recording artifact into a section, or pass feedback alone to request regeneration.",
  "Read the tour first with get_pr_code_tour and pass its revision_id so a tour that changed in between is not overwritten. Your edit is what the PR page shows for this head until the pull request is pushed again.",
].join("\n")

export const Input = Schema.Struct({
  feedback: Schema.optionalKey(Schema.String).annotate({
    description:
      "Natural-language instructions for regenerating the whole tour, such as 'make it shorter' or 'focus on review risks'. The new tour replaces the one the PR page shows when it finishes. Do not combine with markdown or artifactPath.",
  }),
  revision_id: Schema.optionalKey(Schema.String).annotate({
    description:
      "Revision id from reading the tour. When set, the edit is refused if the tour changed after you read it; read it again and retry.",
  }),
  markdown: Schema.optionalKey(Schema.String).annotate({
    description: "Replacement markdown for the whole tour, or the new section body when heading is also set.",
  }),
  heading: Schema.optionalKey(Schema.String).annotate({
    description:
      "Heading text or section id of the target section. With markdown: replace that section only. With artifactPath: attach the media into that file-anchored section (defaults to the last file-anchored section).",
  }),
  artifact_path: Schema.optionalKey(Schema.String).annotate({
    description:
      "Media artifact to attach as visible, playable step media: an image (png/jpeg/gif/webp) or a recording (.mp4/.webm), given as a workspace artifact path (e.g. /opt/cursor/artifacts/demo.mp4) or an artifact URL this agent owns. The attach fails with an actionable error rather than storing media a reader cannot see.",
  }),
  artifact_alt: Schema.optionalKey(Schema.String).annotate({
    description: "Optional alt text for an attached artifact; rendered as the media's caption.",
  }),
  source_revision_id: Schema.optionalKey(Schema.String).annotate({
    description: "Revision id to seed regeneration from. Ignored for in-place edits.",
  }),
  explicit_user_prompt: Schema.optionalKey(Schema.String).annotate({
    description: "Verbatim user prompt that takes effect for tour regeneration, kept distinct from agent-authored feedback.",
  }),
  pr_url: Schema.optionalKey(Schema.String).annotate({
    description: "Pull request whose tour to edit, when this agent has more than one.",
  }),
  base_sha: Schema.optionalKey(Schema.String).annotate({
    description: "Proto field (not model-facing in Cursor): base SHA the tour was generated against. Accepted for wire compatibility; not persisted in the tour snapshot.",
  }),
  head_sha: Schema.optionalKey(Schema.String).annotate({
    description: "Proto field (not model-facing in Cursor): head SHA for the new revision. Defaults to the current tour's head SHA.",
  }),
  scope_commit_hashes: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Proto field (not model-facing in Cursor): commit hashes in the tour's scope. Accepted for wire compatibility; not persisted in the tour snapshot.",
  }),
})

export const Output = Schema.Struct({
  revision_id: Schema.String,
  message: Schema.String,
  execution_mode: Schema.String,
})

const STORE_PREFIX = "pr_code_tour:"
// Same scan bound as the reader: KV.scan caps its page at 1000
// entries and a local tour store beyond that is not a real scenario.
const MAX_TOURS_SCANNED = 1000

interface SnapshotValue {
  readonly revision_id: string
  readonly status: string
  readonly head_sha: string
  readonly feedback: string
  readonly updated_at_ms: number
  readonly is_current: boolean
  readonly markdown: string
  readonly source: string
  readonly pr_url: string
  readonly edited_by_bc_id: string
}

// Stored values are untrusted Json from KV — the same acceptance
// rule as the reader (get-pr-code-tour.ts): only records with a
// revision_id count, absent fields default to the proto3 defaults.
const snapshotFromJson = (value: Schema.Json): SnapshotValue | undefined => {
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

// The revision an edit applies to: among the tours for the PR, the
// one marked is_current, falling back to the latest updated_at_ms —
// the reader's selection rule without the head_sha branch (an edit
// targets the current head by definition).
const selectCurrent = (tours: readonly SnapshotValue[], prUrl: string | undefined): SnapshotValue | undefined => {
  const forPr = prUrl === undefined ? tours : tours.filter((tour) => tour.pr_url === prUrl)
  const current = forPr.filter((tour) => tour.is_current)
  const pool = current.length > 0 ? current : forPr
  return pool.reduce<SnapshotValue | undefined>(
    (latest, tour) => (latest === undefined || tour.updated_at_ms > latest.updated_at_ms ? tour : latest),
    undefined,
  )
}

const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

interface SectionRange {
  readonly heading: string
  readonly headingLine: number
  readonly endLine: number
}

// Flat ATX-heading section ranges over markdown lines, skipping
// fenced code blocks — the same splitting the reader's outline
// parser applies, so a heading that resolves on read resolves here.
const sectionRanges = (lines: readonly string[]): SectionRange[] => {
  const ranges: SectionRange[] = []
  let fence: string | undefined
  lines.forEach((line, index) => {
    const fenceMatch = line.trimStart().match(/^(`{3,}|~{3,})/)
    if (fenceMatch?.[1] !== undefined) {
      const marker = fenceMatch[1]
      if (fence === undefined) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      return
    }
    if (fence !== undefined) return
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (headingMatch?.[2] === undefined) return
    const previous = ranges[ranges.length - 1]
    if (previous !== undefined)
      ranges[ranges.length - 1] = { heading: previous.heading, headingLine: previous.headingLine, endLine: index }
    ranges.push({ heading: headingMatch[2], headingLine: index, endLine: lines.length })
  })
  return ranges
}

const findSection = (ranges: readonly SectionRange[], selector: string): SectionRange | undefined =>
  ranges.find((range) => range.heading.toLowerCase() === selector.toLowerCase() || slug(range.heading) === selector)

export const Plugin = {
  id: "opencode.tool.update_pr_code_tour",
  effect: Effect.fn("UpdatePrCodeTourTool.Plugin")(function* (ctx: Context) {
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
              // empty string as unset (helper `XSe` in the exec
              // bundle). markdown is checked for presence by Cursor
              // without trimming its content; locally a whitespace-
              // only markdown counts as unset so an empty update
              // fails with Cursor's "provide …" error instead of
              // blanking a tour.
              const unset = (value: string | undefined): string | undefined => {
                const trimmed = value?.trim() ?? ""
                return trimmed.length > 0 ? trimmed : undefined
              }
              const feedback = unset(input.feedback)
              const revisionId = unset(input.revision_id)
              const markdown = input.markdown !== undefined && input.markdown.trim().length > 0 ? input.markdown : undefined
              const heading = unset(input.heading)
              const artifactPath = unset(input.artifact_path)
              const artifactAlt = unset(input.artifact_alt)
              const prUrl = unset(input.pr_url)
              const headSha = unset(input.head_sha)

              // Validation + command classification, mirroring
              // Cursor's client execute verbatim (error strings are
              // Cursor's own, thrown there as plain Errors and
              // surfaced as the tool's Error result).
              if (feedback !== undefined && (markdown !== undefined || artifactPath !== undefined))
                return yield* new ToolFailure({ message: "cannot mix feedback with markdown or artifactPath" })
              if (markdown !== undefined && artifactPath !== undefined)
                return yield* new ToolFailure({ message: "cannot mix markdown with artifactPath" })
              const kind =
                markdown !== undefined && heading !== undefined
                  ? "patchSection"
                  : markdown !== undefined
                    ? "replaceMarkdown"
                    : artifactPath !== undefined
                      ? "attachArtifact"
                      : feedback !== undefined
                        ? "regenerate"
                        : undefined
              if (kind === undefined)
                return yield* new ToolFailure({ message: "provide feedback, markdown, or artifactPath" })

              const scanned = yield* kv.scan({ prefix: STORE_PREFIX, limit: MAX_TOURS_SCANNED })
              const tours = scanned.entries.flatMap((entry) => {
                const snapshot = snapshotFromJson(entry.value)
                return snapshot === undefined ? [] : [snapshot]
              })
              const current = selectCurrent(tours, prUrl)

              if (kind === "regenerate") {
                // No local tour generator exists (see header):
                // report SKIPPED truthfully and write nothing.
                const message =
                  current === undefined
                    ? "Tour regeneration was skipped: this pull request has no code tour yet, and tour generation is a server-side service that is not available locally. The tour was left unchanged."
                    : `Tour regeneration was skipped: tour generation is a server-side service that is not available locally, so revision ${current.revision_id} was left unchanged. Provide markdown to edit the tour directly.`
                return {
                  output: { revision_id: current?.revision_id ?? "", message, execution_mode: "SKIPPED" },
                  content: message,
                  metadata: {},
                }
              }

              if (revisionId !== undefined && current !== undefined && revisionId !== current.revision_id)
                return yield* new ToolFailure({
                  message: `The tour changed after revision ${revisionId}; the PR page now shows revision ${current.revision_id}. Read it again without revisionId.`,
                })
              if (current === undefined && kind !== "replaceMarkdown")
                return yield* new ToolFailure({
                  message:
                    "This pull request has no code tour yet, so there is no section to edit. Provide markdown without a heading to create the tour.",
                })

              const base = current?.markdown ?? ""
              let nextMarkdown = base
              if (kind === "replaceMarkdown") nextMarkdown = markdown as string
              if (kind === "patchSection" || kind === "attachArtifact") {
                const lines = base.split("\n")
                const ranges = sectionRanges(lines)
                const target =
                  kind === "patchSection"
                    ? findSection(ranges, heading as string)
                    : heading !== undefined
                      ? findSection(ranges, heading)
                      : ranges[ranges.length - 1]
                if (target === undefined) {
                  // attachArtifact without a heading defaults to the
                  // last section; a tour whose markdown has no
                  // headings has no last section, so the generic
                  // no-match wording would misstate the cause (and
                  // JSON.stringify(undefined) interpolates as the
                  // literal text "undefined").
                  if (heading === undefined)
                    return yield* new ToolFailure({
                      message:
                        "This tour has no sections yet, so there is no section to attach the artifact to. Replace the tour markdown with markdown that includes a heading first, then attach the artifact again.",
                    })
                  return yield* new ToolFailure({
                    message: `No tour section matches ${JSON.stringify(heading)}. Read the tour without sectionId to see its sections.`,
                  })
                }
                if (kind === "patchSection") {
                  const before = lines.slice(0, target.headingLine + 1)
                  const after = lines.slice(target.endLine)
                  nextMarkdown = [...before, "", (markdown as string).trim(), ...(after.length > 0 ? ["", ...after] : [])].join("\n")
                } else {
                  const media = `![${artifactAlt ?? ""}](${artifactPath as string})`
                  const before = lines.slice(0, target.endLine)
                  const after = lines.slice(target.endLine)
                  const trimmedBefore = [...before]
                  while (trimmedBefore.length > 0 && (trimmedBefore[trimmedBefore.length - 1] ?? "").trim() === "")
                    trimmedBefore.pop()
                  nextMarkdown = [...trimmedBefore, "", media, ...(after.length > 0 ? ["", ...after] : [])].join("\n")
                }
              }

              const nextPrUrl = prUrl ?? current?.pr_url ?? ""
              const snapshot: SnapshotValue = {
                revision_id: `rev_${crypto.randomUUID()}`,
                status: current?.status !== undefined && current.status !== "" ? current.status : "ready",
                head_sha: headSha ?? current?.head_sha ?? "",
                feedback: current?.feedback ?? "",
                updated_at_ms: Date.now(),
                is_current: true,
                markdown: nextMarkdown,
                source: current?.source !== undefined && current.source !== "" ? current.source : "local",
                pr_url: nextPrUrl,
                edited_by_bc_id: "",
              }
              // Demote the previous current revision(s) for this PR
              // first, then write the new revision as current. Old
              // revisions stay in the store for head_sha reads.
              for (const tour of tours) {
                if (tour.pr_url === nextPrUrl && tour.is_current)
                  yield* kv.set(`${STORE_PREFIX}${tour.revision_id}`, { ...tour, is_current: false })
              }
              yield* kv.set(`${STORE_PREFIX}${snapshot.revision_id}`, { ...snapshot })

              const message =
                current === undefined
                  ? `Created PR code tour revision ${snapshot.revision_id} for head ${snapshot.head_sha || "unknown"}. It is now the current tour for this pull request.`
                  : kind === "patchSection"
                    ? `Updated section ${JSON.stringify(heading)} of the PR code tour: revision ${snapshot.revision_id} replaces revision ${current.revision_id} as the current tour.`
                    : kind === "attachArtifact"
                      ? `Attached artifact ${artifactPath} to the PR code tour: revision ${snapshot.revision_id} replaces revision ${current.revision_id} as the current tour.`
                      : `Replaced the PR code tour markdown: revision ${snapshot.revision_id} replaces revision ${current.revision_id} as the current tour.`
              return {
                output: { revision_id: snapshot.revision_id, message, execution_mode: "EDITED" },
                content: message,
                metadata: {},
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: "Update PR code tour tool failed", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
