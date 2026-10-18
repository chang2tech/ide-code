export * as CommunicateTool from "./communicate.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"

// communicate: progress updates to the user (docs/rea/deep-agent-tools.md §3.4 —
// communicate_update_tool_call, send_message_tool_call, send_to_user_tool_call).
// Posts the update through the tool-call progress channel and returns it as content.

export const name = "communicate"

export const description = [
  "Send a progress update or message to the user mid-task.",
  "Use for long-running work: report the current step, a completed milestone, or a final note.",
  "This does not end your turn; keep working after communicating.",
].join("\n")

export const Input = Schema.Struct({
  current_step: Schema.optionalKey(Schema.String).annotate({
    description: "What the agent is doing right now.",
  }),
  completed_subtitle: Schema.optionalKey(Schema.String).annotate({
    description: "A milestone that just completed.",
  }),
  final_summary: Schema.optionalKey(Schema.String).annotate({
    description: "A summary note for the user.",
  }),
  message: Schema.optionalKey(Schema.String).annotate({
    description: "Free-form message to the user.",
  }),
})

const Output = Schema.Struct({
  delivered: Schema.Boolean,
})

export const Plugin = {
  id: "opencode.tool.communicate",
  effect: Effect.fn("CommunicateTool.Plugin")(function* (ctx: Context) {
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
              const parts = [
                input.current_step !== undefined ? `Current step: ${input.current_step}` : undefined,
                input.completed_subtitle !== undefined ? `Completed: ${input.completed_subtitle}` : undefined,
                input.final_summary !== undefined ? input.final_summary : undefined,
                input.message !== undefined ? input.message : undefined,
              ].filter((part) => part !== undefined)
              const text = parts.join("\n")
              if (text === "")
                return { output: { delivered: false }, content: "Nothing to communicate: all fields were empty.", metadata: {} }
              yield* context.progress({ status: text })
              return { output: { delivered: true }, content: text, metadata: {} }
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
