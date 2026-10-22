import { EOL } from "os"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { CodebaseIndex } from "@opencode/core/indexing/service"
import { cliLayer } from "@opencode/core/indexing/run"

export default Runtime.handler(
  Commands.commands.indexing.commands.status,
  Effect.fn("cli.indexing.status")(function* (input) {
    process.env["IDE_CODE_SPAWNED_BY"] = "indexing-cli"
    const root = input.root.pipe(Option.getOrElse(() => process.cwd()))
    const st = yield* Effect.gen(function* () {
      const index = yield* CodebaseIndex.Service
      return yield* index.status()
    }).pipe(Effect.provide(cliLayer(root)))

    if (input.json) {
      process.stdout.write(JSON.stringify(st, null, 2) + EOL)
      return
    }
    process.stdout.write(
      [
        `Root: ${st.root}`,
        `Files: ${st.files} | Trigrams: ${st.trigrams} | Symbols: ${st.symbols}`,
        `DB: ${(st.dbBytes / 1024).toFixed(0)} KB`,
        `Merkle root: ${st.merkleRoot ?? "(not indexed)"}`,
        `Last indexed: ${st.lastIndexedAt ? new Date(st.lastIndexedAt).toISOString() : "(never)"}`,
        `Budget paused: ${st.budgetPaused}`,
        `Watching: ${st.watching}`,
        `Partially indexed files: ${st.partialFiles}`,
      ].join(EOL) + EOL,
    )
  }),
)
