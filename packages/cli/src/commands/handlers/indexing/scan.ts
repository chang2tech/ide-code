import { EOL } from "os"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { CodebaseIndex } from "@opencode/core/indexing/service"
import { cliLayer } from "@opencode/core/indexing/run"

export default Runtime.handler(
  Commands.commands.indexing.commands.scan,
  Effect.fn("cli.indexing.scan")(function* (input) {
    process.env["IDE_CODE_SPAWNED_BY"] = "indexing-cli"
    const root = input.root.pipe(Option.getOrElse(() => process.cwd()))
    const started = Date.now()
    yield* Effect.gen(function* () {
      const index = yield* CodebaseIndex.Service
      yield* index.ensureIndexed()
      const st = yield* index.status()
      process.stdout.write(
        `Indexed ${st.files} files (${st.trigrams} trigrams, ${st.symbols} symbols) in ${Date.now() - started}ms${EOL}` +
          `Index: ${st.root}/.ide-code/index/codebase.db (${(st.dbBytes / 1024).toFixed(0)} KB)${EOL}` +
          (st.budgetPaused ? `Storage budget paused: heavy extraction skipped${EOL}` : ""),
      )
    }).pipe(Effect.provide(cliLayer(root)))
  }),
)
