export * as CodebaseSearchTool from "./tool.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { FileAccess } from "../file-access.js"
import { Permission } from "../permission.js"
import { RelativePath } from "../schema.js"
import { Service as IndexService } from "./service.js"

/**
 * Agent-facing search over the local-first codebase index.
 *
 * This is the tool the agent calls for @Codebase-style questions; the
 * extension's @Codebase mention provider resolves through the same index
 * via the `indexing search` CLI. Read-only: no file access beyond the
 * index DB and snippet reads.
 */

export const name = "codebase_search"

export const Input = Schema.Struct({
  query: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1, { message: "Query must not be empty" })),
  ).annotate({ description: "Text to find in file contents, or a symbol name when kind is \"symbol\"." }),
  kind: Schema.Literals(["text", "symbol", "auto"]).pipe(
    Schema.optional,
  ).annotate({ description: "Search file contents (text), definitions (symbol), or pick automatically (auto, default)." }),
  path: Schema.optionalKey(RelativePath).annotate({
    description: "Restrict results to this file or directory, relative to the workspace root.",
  }),
  include: Schema.optionalKey(Schema.String).annotate({
    description: 'Glob filter on result paths (for example, "*.ts").',
  }),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))).annotate({
    description: "Maximum number of results (default 20).",
  }),
})

const Match = Schema.Struct({
  path: Schema.String,
  line: Schema.optionalKey(Schema.Number),
  kind: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  signature: Schema.optionalKey(Schema.String),
})
export const Output = Schema.Array(Match)
type EncodedOutput = typeof Output.Encoded

const looksLikeSymbol = (q: string): boolean => /^[A-Za-z_$][\w$]*$/.test(q)

/** Format matches into concise model content. */
export const toModelContent = (matches: EncodedOutput) => {
  if (matches.length === 0) return "No matches found in the codebase index."
  const lines = [`Found ${matches.length} matches in the codebase index`]
  for (const m of matches) {
    if (m.kind === "symbol" || m.name !== undefined) {
      lines.push(`- ${m.path}:${m.line ?? "?"} ${m.kind ?? "symbol"} ${m.name ?? ""}${m.signature ? ` — ${m.signature}` : ""}`)
    } else {
      lines.push(`- ${m.path}:${m.line ?? "?"}: ${m.text ?? ""}`)
    }
  }
  return lines.join("\n")
}

export const Plugin = {
  id: "ide.tool.codebase_search",
  effect: Effect.fn("CodebaseSearchTool.Plugin")(function* (ctx: Context) {
    const index = yield* IndexService
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Search the workspace's local codebase index: file contents (Instant Grep, <100ms warm in-process) and symbol definitions. " +
            "Use for @Codebase-style questions like \"where is X defined\" or \"find usages of Y\". " +
            "The index is built on-machine and updated incrementally; nothing is uploaded. " +
            "Note: the <100ms figure is the in-process search cost — the editor's one-shot CLI path pays process startup on top.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
              const target = yield* access.resolve({ path: input.path ?? "." })
              yield* access.authorizeExternal([target], context)
              yield* permission.assert({
                action: name,
                resources: [input.query],
                save: ["*"],
                metadata: { query: input.query, kind: input.kind ?? "auto", path: input.path, include: input.include },
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const limit = input.limit ?? 20
              const scope = input.path && input.path !== "." ? input.path : undefined
              const inScope = (p: string) => !scope || p === scope || p.startsWith(`${scope}/`)
              const kind = input.kind ?? "auto"

              const symbolHits =
                kind === "symbol" || (kind === "auto" && looksLikeSymbol(input.query))
                  ? (yield* index.searchSymbols(input.query, { limit })).filter((s) => inScope(s.path))
                  : []
              const output =
                symbolHits.length > 0 || kind === "symbol"
                  ? symbolHits
                      .slice(0, limit)
                      .map((s) =>
                        Match.make({ path: s.path, line: s.line, kind: s.kind, name: s.name, signature: s.signature }),
                      )
                  : (yield* index.searchInstant(input.query, { limit, include: input.include }))
                      .filter((m) => inScope(m.path))
                      .slice(0, limit)
                      .map((m) => Match.make({ path: m.path, line: m.line, text: m.text }))
              return { output, content: toModelContent(output) }
            }).pipe(
              Effect.mapError((e) => (e instanceof ToolFailure ? e : new ToolFailure({ message: String(e) }))),
            ),
        })
      )
  }),
}
