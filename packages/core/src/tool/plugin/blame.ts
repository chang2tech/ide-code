export * as BlameTool from "./blame.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { FileAccess } from "../../file-access.js"
import { Git } from "../../git.js"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"
import { RelativePath } from "../../schema.js"

// blame: git blame for one file (DEV-GAPS-75, handler-trap audit).
//
// Wire contract (docs/rea/deep-agent-tools.md §3.10,
// blame_by_file_path_tool_call, model name BLAME_BY_FILE_PATH_BUGBOT;
// proto re-verified DEV-GAPS-78/W78A in the Cursor 3.25.9 bundle
// extensions/cursor-agent-worker/dist/main.js, BlameByFilePathArgs
// makeMessageType @464923):
//   BlameByFilePathArgs{file_path, start_line? (int32), end_line?
//   (int32)} → BlameByFilePathSuccess{content} /
//   BlameByFilePathError{error_message}.
// The optional range is implemented for real (DEV-GAPS-78): the
// executor forwards it to Git.history.blame, which runs
// `git blame -L …`; a lone bound stays open on the other side.
// This was an alias-only trap: `aliases.ts` mapped BLAME_BY_FILE_PATH_BUGBOT
// → "blame" but no tool plugin existed, so the name resolved to nothing.
// The executor is plain `git blame` (Git.history.blame) over the resolved
// workspace file — the only locally-determined behavior the contract
// implies. Cursor's exact content formatting is UNKNOWN (the descriptor
// only types it as a code string), so the fork returns git's standard
// blame output verbatim instead of inventing a format.

export const name = "blame"

export const description = [
  "Show git blame for a file, optionally only for a start_line/end_line range: every line annotated with the commit, author, and date that last changed it.",
  "Use this to find who changed a line and in which commit, e.g. before asking why code looks the way it does.",
].join("\n")

export const Input = Schema.Struct({
  file_path: Schema.String.annotate({ description: "Path to the file, relative to the project." }),
  start_line: Schema.optionalKey(Schema.Int).annotate({
    description: "Optional first line (1-based) of the range to blame; omit to start at line 1.",
  }),
  end_line: Schema.optionalKey(Schema.Int).annotate({
    description: "Optional last line (1-based) of the range to blame; omit to blame through end of file.",
  }),
})

export const Output = Schema.Struct({
  content: Schema.String,
})

// Cap blame output so a huge file cannot blow up the model context
// (same protective pattern as read.ts rule caps / ls entry cap).
const MAX_BLAME_CHARS = 100_000

export const Plugin = {
  id: "opencode.tool.blame",
  effect: Effect.fn("BlameTool.Plugin")(function* (ctx: Context) {
    const access = yield* FileAccess.Service
    const git = yield* Git.Service
    const location = yield* Location.Service
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
              const target = yield* access.resolve({ path: input.file_path }).pipe(
                Effect.mapError((error) => new ToolFailure({ message: `Cannot blame: ${input.file_path}`, error })),
              )
              yield* access.authorizeExternal([target], context).pipe(
                Effect.mapError((error) => new ToolFailure({ message: `Cannot blame: ${input.file_path}`, error })),
              )
              yield* permission.assert({
                action: name,
                resources: [input.file_path],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              const repository = yield* git.repo.discover(location.directory)
              if (!repository)
                return yield* new ToolFailure({
                  message: `Cannot blame ${input.file_path}: not inside a git repository`,
                })
              if (
                (input.start_line !== undefined && input.start_line < 1) ||
                (input.end_line !== undefined && input.end_line < 1) ||
                (input.start_line !== undefined && input.end_line !== undefined && input.end_line < input.start_line)
              )
                return yield* new ToolFailure({
                  message: `Cannot blame ${input.file_path}: invalid line range ${input.start_line ?? 1}-${input.end_line ?? "end"}`,
                })
              const raw = yield* git.history.blame(repository, RelativePath.make(target.resource), {
                startLine: input.start_line,
                endLine: input.end_line,
              })
              if (raw === undefined)
                return yield* new ToolFailure({
                  message: `Cannot blame ${input.file_path}: git blame failed (file may be untracked, uncommitted, or outside the repository)`,
                })
              const content =
                raw.length > MAX_BLAME_CHARS ? `${raw.slice(0, MAX_BLAME_CHARS)}\n…[blame truncated]` : raw
              return {
                output: { content },
                content,
                metadata: {},
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: `Blame failed: ${input.file_path}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
