export * as CommunicateTool from "./communicate.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Permission } from "../../permission.js"

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

// P1/P2 (QA-05): bound message size so a huge message can't blow up the UI.
const MAX_MESSAGE_BYTES = 4_000
// P1 (QA-05): per-session rate limit — max messages per minute.
const MAX_MESSAGES_PER_MINUTE = 10
const messageTimestamps = new Map<string, Array<number>>()

const checkRateLimit = (sessionID: string): boolean => {
  const now = Date.now()
  const window = now - 60_000
  const timestamps = (messageTimestamps.get(sessionID) ?? []).filter((t) => t > window)
  if (timestamps.length >= MAX_MESSAGES_PER_MINUTE) return false
  timestamps.push(now)
  messageTimestamps.set(sessionID, timestamps)
  return true
}

export const Plugin = {
  id: "opencode.tool.communicate",
  effect: Effect.fn("CommunicateTool.Plugin")(function* (ctx: Context) {
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
              // P1: user-visible messages need authorization, like every other tool.
              yield* permission.assert({
                action: name,
                resources: [context.sessionID],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              const parts = [
                input.current_step !== undefined ? `Current step: ${input.current_step}` : undefined,
                input.completed_subtitle !== undefined ? `Completed: ${input.completed_subtitle}` : undefined,
                input.final_summary !== undefined ? input.final_summary : undefined,
                input.message !== undefined ? input.message : undefined,
              ].filter((part) => part !== undefined)
              let text = parts.join("\n")
              if (text === "")
                return { output: { delivered: false }, content: "Nothing to communicate: all fields were empty.", metadata: {} }
              // P2: truncate overlong messages with a notice.
              if (text.length > MAX_MESSAGE_BYTES) {
                text = `${text.slice(0, MAX_MESSAGE_BYTES)}\n…[truncated to ${MAX_MESSAGE_BYTES} chars]`
              }
              // P1: rate-limit to prevent flooding the user.
              if (!checkRateLimit(context.sessionID)) {
                return yield* new ToolFailure({
                  message: `Rate limited: at most ${MAX_MESSAGES_PER_MINUTE} messages per minute per session.`,
                })
              }
              yield* context.progress({ status: text })
              return { output: { delivered: true }, content: text, metadata: {} }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Communicate tool failed", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
