export * as HookLoader from "./loader.js"

import { Effect, Option, Schema } from "effect"
import path from "path"
import { HooksFile, type HookEntry } from "./schema.js"
import { HookEvents } from "./events.js"

// Config locations, low → high precedence (docs/rea/parity-rules-mcp.md §C3):
// enterprise → user → project. Our `.ide/` namespace wins over `.cursor/`
// compat on conflict (same convention as the policy-engine loader).
// Hooks from all layers concatenate per event; per-source validation errors
// are collected and never kill the other sources.

export interface SourceError {
  readonly source: string
  readonly message: string
}

export interface LoadedHooks {
  readonly hooks: Partial<Record<HookEvents.Event, ReadonlyArray<HookEntry>>>
  readonly errors: ReadonlyArray<SourceError>
  readonly sources: ReadonlyArray<string>
}

type ReadResult =
  | { readonly status: "missing" }
  | { readonly status: "invalid-json" }
  | { readonly status: "ok"; readonly value: unknown }

const readJsonFile = (file: string): Effect.Effect<ReadResult, never> =>
  Effect.tryPromise({
    try: async (): Promise<ReadResult> => {
      const text = await Bun.file(file).text()
      return { status: "ok", value: JSON.parse(text) as unknown }
    },
    catch: (cause) => {
      // Bun.file().text() throws ENOENT for missing files.
      const message = cause instanceof Error ? cause.message : String(cause)
      return /ENOENT|no such file/i.test(message) ? { status: "missing" } : { status: "invalid-json" }
    },
  }).pipe(Effect.catch(() => Effect.succeed({ status: "missing" } as ReadResult)))

const decodeFile = (value: unknown): HooksFile | undefined => {
  const decoded = Schema.decodeUnknownOption(HooksFile)(value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

interface LayerResult {
  readonly file: HooksFile | undefined
  readonly path: string
  readonly invalid: boolean
}

// Our namespace wins on conflict: .ide/hooks.json beats .cursor/hooks.json.
const loadLayer = (dir: string, filename: string): Effect.Effect<LayerResult, never> =>
  Effect.gen(function* () {
    for (const namespace of [".ide", ".cursor"]) {
      const file = path.join(dir, namespace, filename)
      const read = yield* readJsonFile(file)
      if (read.status === "missing") continue
      if (read.status === "invalid-json") return { file: undefined, path: file, invalid: true }
      const decoded = decodeFile(read.value)
      if (decoded !== undefined) return { file: decoded, path: file, invalid: false }
      return { file: undefined, path: file, invalid: true }
    }
    return { file: undefined, path: "", invalid: false }
  })

const enterpriseDirs = (): ReadonlyArray<string> => {
  if (process.platform === "darwin")
    return ["/Library/Application Support/ide-code", "/Library/Application Support/Cursor"]
  if (process.platform === "win32") return ["C:\\ProgramData\\ide-code", "C:\\ProgramData\\Cursor"]
  return ["/etc/ide-code", "/etc/cursor"]
}

const loadEnterprise = (): Effect.Effect<LayerResult, never> =>
  Effect.gen(function* () {
    for (const dir of enterpriseDirs()) {
      const result = yield* loadLayer(dir, "hooks.json")
      if (result.path !== "") return result
    }
    return { file: undefined, path: "", invalid: false }
  })

const collectEntries = (
  acc: Partial<Record<HookEvents.Event, Array<HookEntry>>>,
  file: HooksFile,
  errors: Array<SourceError>,
  sourceLabel: string,
) => {
  const entries = file.hooks ?? {}
  for (const [eventName, list] of Object.entries(entries)) {
    if (!HookEvents.isEvent(eventName)) {
      errors.push({ source: sourceLabel, message: `unknown hook event "${eventName}" — ignored` })
      continue
    }
    const target = acc[eventName] ?? []
    for (const entry of list) {
      if ((entry.type ?? "command") === "prompt") {
        errors.push({
          source: sourceLabel,
          message: `prompt-type hook for "${eventName}" is parsed but not executable (needs a model call) — skipped`,
        })
        continue
      }
      if (entry.matcher !== undefined) {
        try {
          new RegExp(entry.matcher)
        } catch {
          errors.push({ source: sourceLabel, message: `invalid matcher regex "${entry.matcher}" — hook skipped` })
          continue
        }
      }
      target.push(entry)
    }
    acc[eventName] = target
  }
}

const ingest = (
  result: LayerResult,
  layerLabel: string,
  acc: Partial<Record<HookEvents.Event, Array<HookEntry>>>,
  errors: Array<SourceError>,
  sources: Array<string>,
) => {
  if (result.file !== undefined) {
    collectEntries(acc, result.file, errors, `${layerLabel}:${result.path}`)
    sources.push(`${layerLabel}:${result.path}`)
    return
  }
  if (result.invalid) errors.push({ source: `${layerLabel}:${result.path}`, message: "invalid JSON or schema — source ignored" })
}

export const load = (input: { home: string; workspace: string }): Effect.Effect<LoadedHooks, never> =>
  Effect.gen(function* () {
    const acc: Partial<Record<HookEvents.Event, Array<HookEntry>>> = {}
    const errors: Array<SourceError> = []
    const sources: Array<string> = []

    ingest(yield* loadEnterprise(), "enterprise", acc, errors, sources)
    ingest(yield* loadLayer(input.home, "hooks.json"), "user", acc, errors, sources)
    ingest(yield* loadLayer(input.workspace, "hooks.json"), "project", acc, errors, sources)

    return { hooks: acc, errors, sources }
  })
