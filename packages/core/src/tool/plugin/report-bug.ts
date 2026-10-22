export * as ReportBugTool from "./report-bug.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { KV } from "../../kv.js"
import { Permission } from "../../permission.js"

// report_bug: record one concrete bug finding (DEV-GAPS-75,
// handler-trap audit).
//
// Wire contract (docs/rea/deep-agent-tools.md §3.10, report_bug_tool_call,
// model name REPORT_BUG; re-verified in the Cursor 3.25.9 bundle,
// extensions/cursor-agent-exec/dist/main.js @2807517):
//   ReportBugArgs{title, file, start_line, end_line, description,
//   severity, category, rationale} → ReportBugSuccess{output} /
//   ReportBugError{error_message}.
// This was an alias-only trap: `aliases.ts` mapped REPORT_BUG →
// "report_bug" but no tool plugin existed.
//
// HONEST DIVERGENCE: in Cursor this tool feeds the server-side Bugbot
// review pipeline; that sink does not exist locally and its exact
// behavior is UNKNOWN from static evidence. The fork's minimal local
// executor records the finding per session in KV (the same durable
// pattern as summary.ts / goal.ts) and returns a formatted `output`
// string confirming what was recorded. No server submission is claimed.
// The sibling wire tool report_bugfix_results_tool_call stays
// unimplemented for the same reason (see aliases.ts trap note).

export const name = "report_bug"

export const description = [
  "Report one concrete bug you found in the code: title, file and line range, description, severity, category, and the rationale for why it is a bug.",
  "Use this during review work to record a verified finding instead of only mentioning it in prose.",
].join("\n")

export const Input = Schema.Struct({
  title: Schema.String.annotate({ description: "Short title of the bug." }),
  file: Schema.String.annotate({ description: "Path of the file containing the bug." }),
  start_line: Schema.Int.annotate({ description: "First line of the buggy range (1-based)." }),
  end_line: Schema.Int.annotate({ description: "Last line of the buggy range (1-based)." }),
  description: Schema.String.annotate({ description: "What is wrong and what happens because of it." }),
  severity: Schema.String.annotate({ description: "Severity of the bug (e.g. critical, high, medium, low)." }),
  category: Schema.String.annotate({ description: "Bug category (e.g. correctness, security, performance)." }),
  rationale: Schema.String.annotate({ description: "Why this is a bug: the evidence and reasoning." }),
})

export const Output = Schema.Struct({
  output: Schema.String,
})

export const Plugin = {
  id: "opencode.tool.report_bug",
  effect: Effect.fn("ReportBugTool.Plugin")(function* (ctx: Context) {
    const kv = yield* KV.Service
    const permission = yield* Permission.Service
    const key = (sessionID: string, id: string) => `report_bug:${sessionID}:${id}`

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
                resources: [input.file],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              if (input.title.trim() === "" || input.description.trim() === "")
                return yield* new ToolFailure({ message: "Bug title and description cannot be empty." })
              if (input.start_line < 1 || input.end_line < input.start_line)
                return yield* new ToolFailure({
                  message: `Invalid line range ${input.start_line}-${input.end_line} for ${input.file}`,
                })
              yield* kv.set(key(context.sessionID, context.id), {
                title: input.title,
                file: input.file,
                startLine: input.start_line,
                endLine: input.end_line,
                description: input.description,
                severity: input.severity,
                category: input.category,
                rationale: input.rationale,
                recordedAt: Date.now(),
                messageID: context.messageID,
              })
              const output = `Bug recorded: ${input.title} (${input.file}:${input.start_line}-${input.end_line}, severity: ${input.severity}, category: ${input.category})`
              return {
                output: { output },
                content: output,
                metadata: {},
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Report bug tool failed", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
