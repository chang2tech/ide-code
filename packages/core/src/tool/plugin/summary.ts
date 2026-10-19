export * as SummaryTool from "./summary.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { KV } from "../../kv.js"
import { Permission } from "../../permission.js"

// summary: record the agent's final summary for the session
// (docs/rea/deep-agent-tools.md §3.4 send_final_summary_tool_call).
// Persisted per session in KV so later turns and resume can retrieve it.

export const name = "summary"

export const description = [
  "Record the final summary of the completed work for this session.",
  "Call once when the task is done; the summary is stored and shown to the user.",
].join("\n")

export const Input = Schema.Struct({
  final_summary: Schema.String.annotate({ description: "The final summary of what was accomplished." }),
})

const Output = Schema.Struct({
  recorded: Schema.Boolean,
})

export const Plugin = {
  id: "opencode.tool.summary",
  effect: Effect.fn("SummaryTool.Plugin")(function* (ctx: Context) {
    const kv = yield* KV.Service
    const permission = yield* Permission.Service
    const key = (sessionID: string) => `summary:${sessionID}`

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
              // P1 (QA-05): the summary is shown to the user — overwriting it
              // needs authorization so a rogue subagent can't replace it.
              yield* permission.assert({
                action: name,
                resources: [context.sessionID],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              if (input.final_summary.trim() === "")
                return yield* new ToolFailure({ message: "Final summary cannot be empty." })
              yield* kv.set(key(context.sessionID), {
                summary: input.final_summary,
                recordedAt: Date.now(),
                messageID: context.messageID,
              })
              return {
                output: { recorded: true },
                content: input.final_summary,
                metadata: {},
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Summary tool failed", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
