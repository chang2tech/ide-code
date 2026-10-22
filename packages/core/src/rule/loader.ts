export * as RuleLoader from "./loader.js"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { ConfigMarkdown } from "../config/markdown.js"

export interface Rule {
  /** File name without extension, e.g. `typescript-standards`. */
  readonly name: string
  readonly description: string
  readonly globs: ReadonlyArray<string>
  readonly alwaysApply: boolean
  readonly body: string
  readonly path: string
}

const asStringArray = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return value.split(",").map((part) => part.trim()).filter((part) => part.length > 0)
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  return []
}

const asBoolean = (value: unknown): boolean => value === true

const parseRule = (name: string, file: string, content: string): Rule | undefined => {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return undefined
  const data = markdown.data as Record<string, unknown>
  const description = typeof data.description === "string" ? data.description : name
  return {
    name,
    description,
    globs: asStringArray(data.globs),
    alwaysApply: asBoolean(data.alwaysApply),
    body: markdown.content.trim(),
    path: file,
  }
}

// Same layering convention as the hooks loader: enterprise → user → project,
// and our `.ide/` namespace wins over the legacy `.cursor/` compat namespace
// on conflict within a layer.
const loadLayer = Effect.fn("RuleLoader.loadLayer")(function* (
  fs: FSUtil.Interface,
  dir: string,
  acc: Map<string, Rule>,
) {
  for (const namespace of [".ide", ".cursor"]) {
    const rulesDir = path.join(dir, namespace, "rules")
    const entries = yield* fs.readDirectoryEntries(rulesDir).pipe(Effect.orElseSucceed(() => []))
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (entry.type !== "file" || !entry.name.endsWith(".mdc")) continue
      const name = entry.name.slice(0, -".mdc".length)
      if (acc.has(name)) continue
      const file = path.join(rulesDir, entry.name)
      const content = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
      if (content === undefined) continue
      const rule = parseRule(name, file, content)
      if (rule) acc.set(name, rule)
    }
  }
})

/** Loads `.mdc` rules: project (`.ide/rules`, `.cursor/rules`) then user. Project wins on name conflict. */
export const load = Effect.fn("RuleLoader.load")(function* (input: { home: string; workspace: string }) {
  const fs = yield* FSUtil.Service
  const acc = new Map<string, Rule>()
  yield* loadLayer(fs, input.workspace, acc)
  yield* loadLayer(fs, input.home, acc)
  return [...acc.values()].toSorted((a, b) => a.name.localeCompare(b.name))
})
