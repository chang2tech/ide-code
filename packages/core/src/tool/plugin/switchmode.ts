export * as SwitchModeTool from "./switchmode.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"

export const name = "switchmode"

export const Input = Schema.Struct({
  agent: Schema.String.annotate({
    description: "The agent (mode) to switch the current session to, e.g. plan for read-only planning.",
  }),
  reason: Schema.optionalKey(Schema.String).annotate({
    description: "Why the switch is happening, shown to the user.",
  }),
})

export const Output = Schema.Struct({
  agent: Schema.String,
})

export const description = [
  "Switch the current session to a different agent (mode), e.g. from build to plan for read-only investigation.",
  "Use this to implement Cursor-style mode switching (agent/ask/plan) mid-task instead of asking the user to do it.",
  "Only primary agents can be switched to; subagent-only specialists are rejected.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.switchmode",
  effect: Effect.fn("SwitchModeTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
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
              const target = yield* agents.resolve(input.agent)
              if (target === undefined)
                return yield* new ToolFailure({ message: `Unknown agent: ${input.agent}` })
              if (target.mode !== "primary")
                return yield* new ToolFailure({
                  message: `Agent ${input.agent} is not a primary agent and cannot be switched to`,
                })
              yield* permission
                .assert({
                  action: name,
                  resources: [target.id],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Mode switch denied: ${target.id}`, error })))
              yield* sessions.switchAgent({ sessionID: context.sessionID, agent: target.id }).pipe(
                Effect.mapError(
                  (error) => new ToolFailure({ message: `Failed to switch to ${target.id}`, error }),
                ),
              )
              return {
                output: { agent: target.id },
                content: `Switched to ${target.name ?? target.id}${input.reason ? `: ${input.reason}` : ""}. ${target.description ?? ""}`.trim(),
                metadata: { agent: target.id },
              }
            }),
        }),
      )
      .pipe(Effect.orDie)

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        // P2 (QA-05): guard against re-appending on repeated hook invocations.
        if (tool.description.includes("Available modes:")) return
        const available = (yield* agents.list()).filter(
          (agent) => agent.mode === "primary" && !agent.hidden,
        )
        if (available.length === 0) return
        tool.description = [
          tool.description,
          "",
          "Available modes:",
          ...available.map((agent) => `- ${agent.id}: ${agent.description ?? ""}`.trim()),
        ].join("\n")
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
