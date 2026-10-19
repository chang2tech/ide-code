export * as DeleteTool from "./delete.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Schema } from "effect"
import path from "path"
import { Environment } from "../../environment/index.js"
import { FileAccess } from "../../file-access.js"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"

export const name = "delete"

export const description = [
  "Delete a file or directory.",
  "Prefer patch with a delete hunk when removing a file as part of an edit; use this tool for standalone deletions.",
  "Deletion is permanent and requires the same approval as editing files.",
].join("\n")

export const Input = Schema.Struct({
  path: Schema.String.annotate({ description: "Path to the file or directory to delete, relative to the project." }),
})

export const Output = Schema.Struct({
  path: Schema.String,
  // Previous content for files (bounded), so a deletion is recoverable by the model.
  prev_content: Schema.optionalKey(Schema.String),
})

// Max bytes to read for prev_content (P2: avoid loading huge files into memory).
const MAX_PREV_CONTENT_BYTES = 20_000

export const Plugin = {
  id: "opencode.tool.delete",
  effect: Effect.fn("DeleteTool.Plugin")(function* (ctx: Context) {
    const environment = yield* Environment.Service
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, permission: "edit" },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.messageID,
                id: context.id,
              }
              const target = yield* access.resolve({ path: input.path }).pipe(
                Effect.mapError((error) => new ToolFailure({ message: `Cannot delete: ${input.path}`, error })),
              )
              // P0 (QA-05): resolve() is lexical and does not follow symlinks.
              // Canonicalize with realpath BEFORE the permission check so a
              // workspace symlink pointing outside (link -> /etc) cannot smuggle
              // a delete past the containment check.
              const canonical = yield* fs.resolve(target.absolute).pipe(
                Effect.mapError((error) => new ToolFailure({ message: `Cannot delete: ${input.path}`, error })),
              )
              const contained =
                FSUtil.contains(location.directory, canonical) ||
                FSUtil.contains(path.resolve(location.project.directory), canonical)
              if (!contained) {
                return yield* new ToolFailure({
                  message: `Cannot delete: ${input.path} resolves outside the workspace`,
                })
              }
              yield* permission.assert({
                action: "edit",
                resources: [canonical],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              // Capture previous content (bounded) so the deletion stays recoverable.
              // P2: stat first and read only the head — never load a huge file fully.
              const prevContent = yield* Effect.tryPromise({
                try: async () => {
                  const file = Bun.file(canonical)
                  const size = file.size
                  if (size > MAX_PREV_CONTENT_BYTES * 10) {
                    // Very large file: don't even stat-read the head via .text()
                    // on the whole file; slice first.
                    const head = await file.slice(0, MAX_PREV_CONTENT_BYTES).text()
                    return `${head}\n…[truncated, file was ${(size / 1024 / 1024).toFixed(1)}MB]`
                  }
                  const text = await file.slice(0, MAX_PREV_CONTENT_BYTES + 1).text()
                  return text.length > MAX_PREV_CONTENT_BYTES
                    ? `${text.slice(0, MAX_PREV_CONTENT_BYTES)}\n…[truncated]`
                    : text
                },
                catch: () => undefined,
              }).pipe(Effect.catch(() => Effect.succeed(undefined as string | undefined)))
              yield* environment.files.remove(canonical).pipe(
                Effect.mapError((error) => new ToolFailure({ message: `Failed to delete ${input.path}`, error })),
              )
              return {
                output: { path: input.path, ...(prevContent === undefined ? {} : { prev_content: prevContent }) },
                content: `Deleted ${input.path}`,
                metadata: {},
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: `Delete failed: ${input.path}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
