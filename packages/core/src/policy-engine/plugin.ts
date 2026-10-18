export * as PolicyEnginePlugin from "./plugin.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Tool } from "@opencode/schema/tool"
import { Location } from "../location.js"
import { PolicyEngine } from "./service.js"

// Policy-engine plugin: installs the single approval-gate choke point.
// EVERY tool call passes through ctx.tool.hook("execute.before") before execution:
//   deny       → fail with Tool.Error, the call never runs (no prompt)
//   approvable → allowed through; the tool's own permission flow prompts the user
//                per configuration (this is the wire-level smart_mode_approval
//                + allowlist precheck pipeline, combined with the gate)
//   allow      → runs
// The sandbox substrate plugs in underneath the service later.

export const Plugin = {
  id: "opencode.policy-engine",
  effect: Effect.fn("PolicyEngine.Plugin")(function* (ctx: Context) {
    // Services are captured once at registration; the hook callback itself must
    // be service-free (hook callbacks run with R = never).
    const engine = yield* PolicyEngine.Service
    const location = yield* Location.Service

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        const verdict = yield* engine
          .decide({
            tool: event.tool,
            input: event.input,
            sessionID: event.sessionID,
            agent: event.agent,
            directory: location.directory,
          })
          .pipe(
            Effect.mapError(
              (error) => new Tool.Error({ message: error.message ?? "Policy engine denied the tool call" }),
            ),
          )
        if (verdict.kind === "deny")
          return yield* new Tool.Error({
            message: `Denied by policy: ${verdict.reasons.join("; ")}`,
          })
        // approvable/allow: proceed; permission flow handles prompting.
      }),
    )
  }),
}
