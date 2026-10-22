export * as IndexRun from "./run.js"

import path from "node:path"
import { Layer } from "effect"
import { AbsolutePath } from "@opencode/core/schema"
import { Location } from "../location.js"
import { Project } from "../project.js"
import { rawLayer as IndexLayer } from "./service.js"

/**
 * Minimal one-shot layer for the `indexing` CLI: provides a stub
 * Location.Service rooted at the given directory so the CodebaseIndex
 * service can run without the full application stack (no DB, no project
 * resolution). Used by one-shot CLI commands and the extension's
 * @Codebase bridge, which shells out to those commands.
 */
export const cliLayer = (root: string) => {
  const absolute = AbsolutePath.make(path.resolve(root))
  const info = {
    directory: absolute,
    project: { id: Project.ID.global, directory: absolute, canonical: absolute },
  } satisfies Location.Interface
  return Layer.provide(IndexLayer, Layer.succeed(Location.Service, Location.Service.of(info)))
}
