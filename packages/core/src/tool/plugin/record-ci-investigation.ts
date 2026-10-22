export * as RecordCiInvestigationTool from "./record-ci-investigation.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { KV } from "../../kv.js"
import { Permission } from "../../permission.js"

// record_ci_investigation: record the findings of a CI failure
// investigation (DEV-GAPS-78, handler-trap audit follow-up to
// DEV-GAPS-75).
//
// Wire contract — verified directly from the proto descriptors in the
// Cursor 3.25.9 bundles (protobuf-es makeMessageType in
// extensions/cursor-agent-worker/dist/main.js: Finding @471269,
// Overall @472149, Args @472491, Success @472716; identical proto3
// descriptor strings in extensions/cursor-agent-exec/dist/main.js
// @6685715+ and extensions/cursor-always-local/dist/main.js @762379+;
// scalar T:9 = string, T:8 = bool):
//   RecordCiInvestigationFinding{
//     1 check_name: string, 2 details_url?: string, 3 tldr: string,
//     4 root_cause?: string, 5 failing_signal?: string,
//     6 suggested_next_step?: string, 7 diff_relation?: string,
//     8 diff_relation_evidence?: string, 9 flake_assessment?: string,
//     10 flake_evidence?: string, 11 rerun_available?: bool,
//     12 rerun_evidence?: string, 13 recommended_action?: string,
//     14 recommended_action_evidence?: string, 15 confidence?: string}
//   RecordCiInvestigationOverall{
//     1 summary: string, 2 themes: string[], 3 recommended_action?: string,
//     4 recommended_action_evidence?: string, 5 check_keys: string[]}
//   RecordCiInvestigationFindingsArgs{
//     1 findings: Finding[], 2 overall?: Overall, 3 tool_call_id: string}
//     → RecordCiInvestigationFindingsSuccess{message} /
//       RecordCiInvestigationFindingsError{error}
// The earlier deep-agent-tools.md §3.10 note ("Args lists ONLY
// tool_call_id") was stale — the proto defines the full shape above.
// `tool_call_id` is wire plumbing supplied by the runtime invocation
// context (context.id), not a model-authored field, so — following the
// reflect.ts precedent, whose Args also carry tool_call_id — it is not
// part of the model Input schema; it is stored from the context.
// This was an alias-only trap: `aliases.ts` mapped
// RECORD_CI_INVESTIGATION_FINDINGS → "record_ci_investigation" but no
// tool plugin existed.
//
// HONEST DIVERGENCE: in Cursor this tool feeds the server-side CI
// investigation / Bugbot pipeline; that sink does not exist locally
// and its exact behavior is UNKNOWN from static evidence. The fork's
// minimal local executor records the findings per session in KV (the
// same durable pattern as summary.ts / reflect.ts / report-bug.ts)
// and returns a `message` string confirming what was recorded, matching
// the proto Success shape. No server submission is claimed.

export const name = "record_ci_investigation"

export const description = [
  "Record the findings of a CI failure investigation: one finding per failing check (what failed, root cause, flake assessment, recommended action), plus an optional overall summary.",
  "Use this after investigating CI failures so the conclusions are durable for the rest of the session instead of only appearing in prose.",
].join("\n")

export const Finding = Schema.Struct({
  check_name: Schema.String.annotate({ description: "Name of the failing CI check." }),
  details_url: Schema.optionalKey(Schema.String).annotate({
    description: "URL with details about the failing check (e.g. the CI run or log).",
  }),
  tldr: Schema.String.annotate({ description: "One-line summary of this finding." }),
  root_cause: Schema.optionalKey(Schema.String).annotate({
    description: "Root cause of the failure, if identified.",
  }),
  failing_signal: Schema.optionalKey(Schema.String).annotate({
    description: "The concrete failing signal (test name, error, assertion) observed.",
  }),
  suggested_next_step: Schema.optionalKey(Schema.String).annotate({
    description: "Suggested next step for this check.",
  }),
  diff_relation: Schema.optionalKey(Schema.String).annotate({
    description: "How the failure relates to the current diff (e.g. caused by it, unrelated, pre-existing).",
  }),
  diff_relation_evidence: Schema.optionalKey(Schema.String).annotate({
    description: "Evidence for the stated diff relation.",
  }),
  flake_assessment: Schema.optionalKey(Schema.String).annotate({
    description: "Assessment of whether the failure is flaky.",
  }),
  flake_evidence: Schema.optionalKey(Schema.String).annotate({
    description: "Evidence for the flake assessment.",
  }),
  rerun_available: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether a rerun of the check is available.",
  }),
  rerun_evidence: Schema.optionalKey(Schema.String).annotate({
    description: "Evidence about rerun availability or rerun results.",
  }),
  recommended_action: Schema.optionalKey(Schema.String).annotate({
    description: "Recommended action for this check.",
  }),
  recommended_action_evidence: Schema.optionalKey(Schema.String).annotate({
    description: "Evidence supporting the recommended action.",
  }),
  confidence: Schema.optionalKey(Schema.String).annotate({
    description: "Confidence in this finding (e.g. high, medium, low).",
  }),
})

export const Overall = Schema.Struct({
  summary: Schema.String.annotate({ description: "Overall summary of the CI investigation." }),
  themes: Schema.Array(Schema.String).annotate({ description: "Common themes across the findings." }),
  recommended_action: Schema.optionalKey(Schema.String).annotate({
    description: "Overall recommended action.",
  }),
  recommended_action_evidence: Schema.optionalKey(Schema.String).annotate({
    description: "Evidence supporting the overall recommended action.",
  }),
  check_keys: Schema.Array(Schema.String).annotate({
    description: "Keys/names of the checks covered by this investigation.",
  }),
})

export const Input = Schema.Struct({
  findings: Schema.Array(Finding).annotate({ description: "One finding per investigated CI check." }),
  overall: Schema.optionalKey(Overall).annotate({
    description: "Optional overall summary across all findings.",
  }),
})

export const Output = Schema.Struct({
  message: Schema.String,
})

// P2 (QA-05 pattern, cf. reflect.ts): bound field length to prevent KV bloat.
const MAX_FIELD_CHARS = 20_000
const MAX_FINDINGS = 100

export const Plugin = {
  id: "opencode.tool.record_ci_investigation",
  effect: Effect.fn("RecordCiInvestigationTool.Plugin")(function* (ctx: Context) {
    const kv = yield* KV.Service
    const permission = yield* Permission.Service
    const key = (sessionID: string, id: string) => `record_ci_investigation:${sessionID}:${id}`
    // KV values must be valid Json: strip explicit undefineds before
    // writing (same pattern as trackedtask.ts toJson).
    const findingToJson = (finding: typeof Finding.Type): { [key: string]: Schema.Json } => {
      const out: { [key: string]: Schema.Json } = { check_name: finding.check_name, tldr: finding.tldr }
      if (finding.details_url !== undefined) out.details_url = finding.details_url
      if (finding.root_cause !== undefined) out.root_cause = finding.root_cause
      if (finding.failing_signal !== undefined) out.failing_signal = finding.failing_signal
      if (finding.suggested_next_step !== undefined) out.suggested_next_step = finding.suggested_next_step
      if (finding.diff_relation !== undefined) out.diff_relation = finding.diff_relation
      if (finding.diff_relation_evidence !== undefined)
        out.diff_relation_evidence = finding.diff_relation_evidence
      if (finding.flake_assessment !== undefined) out.flake_assessment = finding.flake_assessment
      if (finding.flake_evidence !== undefined) out.flake_evidence = finding.flake_evidence
      if (finding.rerun_available !== undefined) out.rerun_available = finding.rerun_available
      if (finding.rerun_evidence !== undefined) out.rerun_evidence = finding.rerun_evidence
      if (finding.recommended_action !== undefined) out.recommended_action = finding.recommended_action
      if (finding.recommended_action_evidence !== undefined)
        out.recommended_action_evidence = finding.recommended_action_evidence
      if (finding.confidence !== undefined) out.confidence = finding.confidence
      return out
    }
    const overallToJson = (overall: typeof Overall.Type): { [key: string]: Schema.Json } => {
      const out: { [key: string]: Schema.Json } = {
        summary: overall.summary,
        themes: [...overall.themes],
        check_keys: [...overall.check_keys],
      }
      if (overall.recommended_action !== undefined) out.recommended_action = overall.recommended_action
      if (overall.recommended_action_evidence !== undefined)
        out.recommended_action_evidence = overall.recommended_action_evidence
      return out
    }

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
                resources: [context.sessionID],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              if (input.findings.length === 0)
                return yield* new ToolFailure({
                  message: "At least one CI investigation finding is required.",
                })
              if (input.findings.length > MAX_FINDINGS)
                return yield* new ToolFailure({
                  message: `CI investigation findings are limited to ${MAX_FINDINGS} per call.`,
                })
              for (const finding of input.findings) {
                if (finding.check_name.trim() === "" || finding.tldr.trim() === "")
                  return yield* new ToolFailure({
                    message: "Every CI investigation finding needs a non-empty check_name and tldr.",
                  })
                const strings = [
                  finding.check_name,
                  finding.details_url,
                  finding.tldr,
                  finding.root_cause,
                  finding.failing_signal,
                  finding.suggested_next_step,
                  finding.diff_relation,
                  finding.diff_relation_evidence,
                  finding.flake_assessment,
                  finding.flake_evidence,
                  finding.rerun_evidence,
                  finding.recommended_action,
                  finding.recommended_action_evidence,
                  finding.confidence,
                ]
                if (strings.some((field) => field !== undefined && field.length > MAX_FIELD_CHARS))
                  return yield* new ToolFailure({
                    message: `Finding fields are limited to ${MAX_FIELD_CHARS} characters each.`,
                  })
              }
              if (input.overall !== undefined) {
                if (input.overall.summary.trim() === "")
                  return yield* new ToolFailure({ message: "Overall summary cannot be empty." })
                const strings = [
                  input.overall.summary,
                  input.overall.recommended_action,
                  input.overall.recommended_action_evidence,
                  ...input.overall.themes,
                  ...input.overall.check_keys,
                ]
                if (strings.some((field) => field !== undefined && field.length > MAX_FIELD_CHARS))
                  return yield* new ToolFailure({
                    message: `Overall fields are limited to ${MAX_FIELD_CHARS} characters each.`,
                  })
              }
              const stored: { [key: string]: Schema.Json } = {
                findings: input.findings.map(findingToJson),
                toolCallID: context.id,
                recordedAt: Date.now(),
                messageID: context.messageID,
              }
              if (input.overall !== undefined) stored.overall = overallToJson(input.overall)
              yield* kv.set(key(context.sessionID, context.id), stored)
              const checks = input.findings.map((finding) => finding.check_name).join(", ")
              const message =
                input.overall === undefined
                  ? `CI investigation recorded: ${input.findings.length} finding(s) (${checks})`
                  : `CI investigation recorded: ${input.findings.length} finding(s) (${checks}) — ${input.overall.summary}`
              return {
                output: { message },
                content: message,
                metadata: {},
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: "Record CI investigation tool failed", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
