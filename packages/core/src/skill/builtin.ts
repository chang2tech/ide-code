export * as BuiltinSkills from "./builtin.js"

import { promises as fs } from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { Effect } from "effect"
import { Global } from "@opencode/util/global"
import { AbsolutePath } from "../schema.js"
import { Skill } from "../skill.js"

/**
 * Built-in skills shipped with the product (the six content skills: automate,
 * canvas, create-hook, create-rule, create-subagent, visualize).
 *
 * How Cursor does it: the app provisions its built-in skill bundles into a
 * managed directory (`~/.cursor/skills-cursor/`) and the agent runtime
 * discovers them at startup alongside user/project skills. We do the same:
 * bundles live in `packages/core/builtin-skills/`, and `provision` copies
 * them into `<config>/skills-cursor/` (version-gated, so bundle updates
 * propagate on the next start without clobbering user edits — the managed
 * copies are overwritten wholesale on version change).
 *
 * Precedence: the managed directory is registered as a skill source with the
 * LOWEST precedence, so a user or project skill with the same name wins
 * (the config skill plugin loads sources in order and later IDs overwrite).
 */
export const NAMES = ["automate", "canvas", "create-hook", "create-rule", "create-subagent", "visualize"] as const
export type Name = (typeof NAMES)[number]

/** Bump when bundled skill content changes so managed copies refresh. */
export const VERSION = 1

const MANIFEST = ".ide-version"

/** Managed directory mirroring Cursor's `~/.cursor/skills-cursor/`. */
export const managedDir = (configDir: string) => path.join(configDir, "skills-cursor")

const sourceDir = () =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "builtin-skills")

const readManifest = (dir: string) =>
  Effect.promise(() => fs.readFile(path.join(dir, MANIFEST), "utf8")).pipe(
    Effect.map((text) => {
      const parsed: unknown = JSON.parse(text)
      return typeof parsed === "object" && parsed !== null && (parsed as { version?: unknown }).version === VERSION
    }),
    Effect.orElseSucceed(() => false),
  )

const writeManifest = (dir: string) =>
  Effect.promise(() => fs.writeFile(path.join(dir, MANIFEST), JSON.stringify({ version: VERSION, skills: NAMES }), "utf8"))

const copySkill = (name: Name, from: string, to: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => fs.rm(to, { recursive: true, force: true }))
    yield* Effect.promise(() => fs.mkdir(path.dirname(to), { recursive: true }))
    yield* Effect.promise(() => fs.cp(from, to, { recursive: true }))
  })

/**
 * Provision built-in skill bundles into the managed directory. Idempotent:
 * skips when the manifest version matches. Never touches user/project skill
 * directories — only the managed `skills-cursor/` tree.
 */
export const provision = Effect.fn("BuiltinSkills.provision")(function* (global: Global.Interface) {
  const from = sourceDir()
  const fromExists = yield* Effect.promise(() => fs.stat(from).then((st) => st.isDirectory()).catch(() => false))
  if (!fromExists) {
    yield* Effect.logWarning("built-in skills source missing, skipping provisioning", { from })
    return
  }
  const to = managedDir(global.config)
  if (yield* readManifest(to)) return
  yield* Effect.logInfo("provisioning built-in skills", { to })
  yield* Effect.forEach(NAMES, (name) => copySkill(name, path.join(from, name), path.join(to, name)), {
    concurrency: 2,
  })
  yield* writeManifest(to)
})

/** DirectorySource for the managed built-ins, for the config skill plugin. */
export const source = (global: Global.Interface) =>
  Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(managedDir(global.config)) })
