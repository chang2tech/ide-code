export * as DeleteTool from "./delete.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Environment } from "../../environment/index.js"
import { FileAccess } from "../../file-access.js"
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

export const Plugin = {
  id: "opencode.tool.delete",
  effect: Effect.fn("DeleteTool.Plugin")(function* (ctx: Context) {
    const environment = yield* Environment.Service
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service

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
              yield* permission.assert({
                action: "edit",
                resources: [target.absolute],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              // Capture previous content (bounded) so the deletion stays recoverable.
              const prevContent = yield* Effect.tryPromise({
                try: () =>
                  Bun.file(target.absolute)
                    .text()
                    .then((text) => (text.length > 20000 ? `${text.slice(0, 20000)}\n…[truncated]` : text)),
                catch: () => undefined,
              }).pipe(Effect.catch(() => Effect.succeed(undefined as string | undefined)))
              yield* environment.files.remove(target.absolute).pipe(
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
