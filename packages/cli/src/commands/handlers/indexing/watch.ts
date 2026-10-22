import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { CodebaseIndex } from "@opencode/core/indexing/service"
import { cliLayer } from "@opencode/core/indexing/run"

export default Runtime.handler(
  Commands.commands.indexing.commands.watch,
  Effect.fn("cli.indexing.watch")(function* (input) {
    process.env["IDE_CODE_SPAWNED_BY"] = "indexing-cli"
    const root = input.root.pipe(Option.getOrElse(() => process.cwd()))
    yield* Effect.scoped(
      Effect.gen(function* () {
        const index = yield* CodebaseIndex.Service
        yield* index.ensureIndexed()
        yield* index.watch()
      }).pipe(Effect.provide(cliLayer(root))),
    )
  }),
)
