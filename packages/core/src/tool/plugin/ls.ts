export * as LsTool from "./ls.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { FileAccess } from "../../file-access.js"

// ls: list directory entries (docs/rea/deep-agent-tools.md §3.1 ls_tool_call).
// Thin, fast alternative to read for directory listings.

export const name = "ls"

export const description = [
  "List the entries of a directory, one per line with a type suffix (/ for directories).",
  "Prefer this over read when you only need to see what a directory contains.",
].join("\n")

export const Input = Schema.Struct({
  path: Schema.String.annotate({ description: "Directory to list, relative to the project." }),
})

export const Output = Schema.Struct({
  path: Schema.String,
  entries: Schema.Array(Schema.String),
})

export const Plugin = {
  id: "opencode.tool.ls",
  effect: Effect.fn("LsTool.Plugin")(function* (ctx: Context) {
    const fs = yield* FSUtil.Service
    const access = yield* FileAccess.Service

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
              const target = yield* access.resolve({ path: input.path }).pipe(
                Effect.mapError((error) => new ToolFailure({ message: `Cannot list: ${input.path}`, error })),
              )
              // P1 (QA-05): listing outside the workspace needs authorization,
              // mirroring read.ts which calls authorizeRead.
              yield* access.authorizeExternal([target], context).pipe(
                Effect.mapError((error) => new ToolFailure({ message: `Cannot list: ${input.path}`, error })),
              )
              const entries = yield* fs.readDirectoryEntries(target.absolute).pipe(
                Effect.mapError((error) => new ToolFailure({ message: `Cannot list directory: ${input.path}`, error })),
              )
              // P1: cap entries so a huge directory can't blow up memory/context.
              const MAX_ENTRIES = 5000
              const truncated = entries.length > MAX_ENTRIES
              const names = entries
                .slice(0, MAX_ENTRIES)
                .map((entry) => `${entry.name}${entry.type === "directory" ? "/" : ""}`)
                .sort()
              return {
                output: { path: input.path, entries: names },
                content:
                  names.length === 0
                    ? `Directory ${input.path} is empty.`
                    : names.join("\n") + (truncated ? `\n…[truncated, ${entries.length} total entries]` : ""),
                metadata: {},
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: `List failed: ${input.path}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
