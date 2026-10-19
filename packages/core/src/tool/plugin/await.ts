export * as AwaitTool from "./await.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Job } from "../../job.js"
import { Permission } from "../../permission.js"

// await: wait for a background subagent job to finish
// (docs/rea/deep-agent-tools.md §3.4 await_tool_call).
// Blocks on the job instead of polling; prefer this over repeated status checks.

export const name = "await"

export const description = [
  "Wait for a background subagent (launched with subagent background=true) to finish.",
  "Blocks until the job completes or is backgrounded; do not poll in a loop.",
].join("\n")

export const Input = Schema.Struct({
  sessionID: Schema.String.annotate({
    description: "The sessionID of the background subagent to wait for.",
  }),
  timeout: Schema.optionalKey(Schema.Number).annotate({
    description: "Max seconds to wait for the job before failing. Defaults to 600 (10 minutes).",
  }),
})

const Output = Schema.Struct({
  status: Schema.String,
  sessionID: Schema.String,
})

export const Plugin = {
  id: "opencode.tool.await",
  effect: Effect.fn("AwaitTool.Plugin")(function* (ctx: Context) {
    const jobs = yield* Job.Service
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
              // P1 (QA-05): awaiting another session's job leaks lifecycle info
              // and needs authorization.
              yield* permission.assert({
                action: name,
                resources: [input.sessionID],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              // P2 (QA-04-VERIFY): fail fast on self-await — the caller's own
              // execution is suspended inside this tool call, so its own job
              // can never finish; without this the block deadlocks forever.
              if (input.sessionID === context.sessionID)
                return yield* new ToolFailure({ message: `Cannot await your own session: ${input.sessionID}` })
              // P2 (QA-04-VERIFY): bound the block with a timeout. jobs.block
              // used to race the job's Deferreds with no timeout, so a stuck
              // subagent hung the parent's tool call indefinitely.
              const timeoutMs = (input.timeout ?? 600) * 1000
              const maybe = yield* jobs.block({ id: input.sessionID, sessionID: context.sessionID }).pipe(
                Effect.timeoutOption(timeoutMs),
              )
              if (maybe._tag === "None")
                return yield* new ToolFailure({
                  message: `Timed out after ${input.timeout ?? 600}s waiting for background job ${input.sessionID}`,
                })
              const result = maybe.value
              if (result === undefined)
                return yield* new ToolFailure({ message: `No background job found for session: ${input.sessionID}` })
              const status = result.type === "finished" ? "finished" : "backgrounded"
              return {
                output: { status, sessionID: input.sessionID },
                content: `Background job ${input.sessionID} ${status}.`,
                metadata: {},
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Await tool failed", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
