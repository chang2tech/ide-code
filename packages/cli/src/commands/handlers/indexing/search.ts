import { EOL } from "os"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { CodebaseIndex } from "@opencode/core/indexing/service"
import { cliLayer } from "@opencode/core/indexing/run"

export default Runtime.handler(
  Commands.commands.indexing.commands.search,
  Effect.fn("cli.indexing.search")(function* (input) {
    process.env["IDE_CODE_SPAWNED_BY"] = "indexing-cli"
    const root = input.root.pipe(Option.getOrElse(() => process.cwd()))
    const limit = input.limit.pipe(Option.getOrElse(() => 50))
    const include = input.include.pipe(Option.getOrUndefined)
    const started = Date.now()
    const result = yield* Effect.gen(function* () {
      const index = yield* CodebaseIndex.Service
      if (input.symbols) {
        const hits = yield* index.searchSymbols(input.query, { limit })
        return { kind: "symbols" as const, hits, elapsedMs: Date.now() - started }
      }
      const matches = yield* index.searchInstant(input.query, {
        limit,
        regex: input.regex,
        include,
      })
      return { kind: "text" as const, matches, elapsedMs: Date.now() - started }
    }).pipe(Effect.provide(cliLayer(root)))

    if (input.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }
    if (result.kind === "symbols") {
      if (result.hits.length === 0) process.stdout.write(`No symbols found for "${input.query}"${EOL}`)
      for (const h of result.hits)
        process.stdout.write(`${h.path}:${h.line} ${h.kind} ${h.name}${h.signature ? ` — ${h.signature}` : ""}${EOL}`)
    } else {
      if (result.matches.length === 0) process.stdout.write(`No matches for "${input.query}"${EOL}`)
      for (const m of result.matches) process.stdout.write(`${m.path}:${m.line}: ${m.text}${EOL}`)
    }
    process.stderr.write(`(${result.elapsedMs}ms)${EOL}`)
  }),
)
