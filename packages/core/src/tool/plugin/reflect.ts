export * as ReflectTool from "./reflect.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { KV } from "../../kv.js"
import { Permission } from "../../permission.js"

// reflect: structured self-critique step in the agent loop
// (DEV-GAPS-75, handler-trap audit).
//
// Wire contract (docs/rea/deep-agent-tools.md §3.4, reflect_tool_call,
// model names REFLECT / REFLECT_GENERAL; re-verified by slicing the
// Cursor 3.25.9 bundles):
//   Alias-map ONLY (NOT a descriptor): extensions/cursor-agent-exec/
//   dist/main.js @2807450 slices to
//   `reflect_tool_call",REFLECT_GENERAL:"reflect_tool_call"` — the tail
//   of `REFLECT:"reflect_tool_call",REFLECT_GENERAL:"reflect_tool_call"`
//   in the model-name → tool-call-name alias map.
//   Descriptor (Args/Success): extensions/cursor-agent-worker/dist/
//   main.js @449417 slices to `ReflectArgs",(()=>[{no:1,name:
//   "unexpected_action_outcomes",…,no:6,name:"tool_call_id"}]))`,
//   followed in the same block by ReflectResult{oneof result:
//   success:ReflectSuccess, error:ReflectError},
//   ReflectSuccess (empty, see below) and ReflectError{error}; the
//   same descriptor in extensions/cursor-agent-exec/dist/main.js
//   @6692802 slices to `ReflectArgs|1 unexpected_action_outcomes 9|
//   2 relevant_instructions 9|3 scenario_analysis 9|
//   4 critical_synthesis 9|5 next_steps 9|6 tool_call_id 9`.
//   ReflectArgs{unexpected_action_outcomes, relevant_instructions,
//   scenario_analysis, critical_synthesis, next_steps, tool_call_id} →
//   ReflectError{error} on failure.
// This was an alias-only trap: `aliases.ts` mapped REFLECT → "reflect"
// but no tool plugin existed.
//
// HONEST DIVERGENCE: Cursor's ReflectSuccess is an EMPTY message —
// corrected DEV-GAPS-78/W78A, proto re-verified in the Cursor 3.25.9
// bundle extensions/cursor-agent-worker/dist/main.js @449915:
// `ReflectSuccess` = makeMessageType(..., []) (zero fields; an earlier
// version of this note wrongly called the shape "not recoverable").
// What remains unrecoverable is Cursor's executor behavior
// (deep-agent-tools.md marks the behavior INFERRED: a structured
// self-critique step inside Cursor's agent loop, whose runtime is
// server-side). The fork therefore follows the exact
// local pattern already established for the sibling loop tool
// send_final_summary (tool/plugin/summary.ts): the reflection is recorded
// per session in KV so later turns and resume can retrieve it, and the
// tool returns {recorded: true} — a LOCAL output shape only; Cursor's
// wire success carries no fields at all (see above). No Cursor-side
// effect beyond recording the critique is claimed.

export const name = "reflect"

export const description = [
  "Record a structured self-critique before continuing: what outcomes were unexpected, which instructions are relevant, scenario analysis, a critical synthesis, and the next steps.",
  "Use this after a surprising result or before a risky action, to make the reasoning explicit and durable for the rest of the session.",
].join("\n")

export const Input = Schema.Struct({
  unexpected_action_outcomes: Schema.String.annotate({
    description: "Action outcomes that were unexpected, and why.",
  }),
  relevant_instructions: Schema.String.annotate({
    description: "Instructions (user, project, or system) relevant to the current situation.",
  }),
  scenario_analysis: Schema.String.annotate({ description: "Analysis of the plausible scenarios ahead." }),
  critical_synthesis: Schema.String.annotate({
    description: "Critical synthesis: what the evidence actually supports.",
  }),
  next_steps: Schema.String.annotate({ description: "Concrete next steps that follow from the synthesis." }),
})

export const Output = Schema.Struct({
  recorded: Schema.Boolean,
})

// P2 (QA-05 pattern, cf. goal.ts): bound field length to prevent KV bloat.
const MAX_FIELD_CHARS = 20_000

export const Plugin = {
  id: "opencode.tool.reflect",
  effect: Effect.fn("ReflectTool.Plugin")(function* (ctx: Context) {
    const kv = yield* KV.Service
    const permission = yield* Permission.Service
    const key = (sessionID: string) => `reflect:${sessionID}`

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
              const fields = [
                input.unexpected_action_outcomes,
                input.relevant_instructions,
                input.scenario_analysis,
                input.critical_synthesis,
                input.next_steps,
              ]
              if (fields.some((field) => field.trim() === ""))
                return yield* new ToolFailure({ message: "Reflection fields cannot be empty." })
              if (fields.some((field) => field.length > MAX_FIELD_CHARS))
                return yield* new ToolFailure({
                  message: `Reflection fields are limited to ${MAX_FIELD_CHARS} characters each.`,
                })
              yield* kv.set(key(context.sessionID), {
                unexpectedActionOutcomes: input.unexpected_action_outcomes,
                relevantInstructions: input.relevant_instructions,
                scenarioAnalysis: input.scenario_analysis,
                criticalSynthesis: input.critical_synthesis,
                nextSteps: input.next_steps,
                recordedAt: Date.now(),
                messageID: context.messageID,
              })
              return {
                output: { recorded: true },
                content: input.critical_synthesis,
                metadata: {},
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Reflect tool failed", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
