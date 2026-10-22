/**
 * Deceptive symlink escape guard for file-mutation tools (XQA-04 P0).
 *
 * A workspace symlink pointing outside (link -> /etc) makes a
 * lexically-internal path (link/cron.d/evil) resolve outside the workspace.
 * The permission check and the policy gate see only the innocent lexical
 * path while the operation lands outside. Such operations must be denied
 * outright: the lexical path is deceptive and the user never approved
 * anything outside the workspace for them.
 *
 * Explicit absolute paths outside the workspace are not deceptive and keep
 * the existing external_directory approval flow.
 *
 * This check is self-contained: it canonicalizes from the input path, so the
 * verdict holds regardless of how FileAccess.resolve spells its target.
 */
export * as CanonicalTarget from "./canonical-target.js"

import { realpathSync } from "node:fs"
import path from "path"
import { FSUtil } from "@opencode/util/fs-util"
import { FileAccess } from "../../file-access.js"
import type { Location } from "../../location.js"

/**
 * Canonicalize an absolute path with realpath.
 *
 * Plain realpath fails with ENOENT for not-yet-existing files, which would
 * let a workspace symlink smuggle a write past the containment check (the
 * write-new-file attack: link -> /etc + write link/cron.d/evil). Instead,
 * realpath the nearest existing ancestor and re-append the missing tail
 * lexically.
 */
export const canonicalizePath = (absolute: string): string => {
  let dir = absolute
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync(dir)
      return tail.length === 0 ? real : path.join(real, ...tail)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
      const parent = path.dirname(dir)
      if (parent === dir) return absolute
      tail.unshift(path.basename(dir))
      dir = parent
    }
  }
}

/**
 * Returns true when the input path is a deceptive symlink escape: it looks
 * workspace-internal (relative, or absolute under the workspace) but
 * canonicalizes outside the workspace. Callers must deny the operation
 * before any prompt or I/O.
 */
export const isDeceptiveEscape = (
  inputPath: string,
  location: Pick<Location.Interface, "directory" | "project">,
): boolean => {
  const lexical = FileAccess.resolvePath(location.directory, inputPath)
  if (!FSUtil.contains(location.directory, lexical)) return false
  const canonical = canonicalizePath(lexical)
  // The bases are canonicalized too (XQA-04 P2): a workspace opened via a
  // symlinked path (macOS /tmp -> /private/tmp) must not false-deny.
  const workspace = canonicalizePath(location.directory)
  const project = canonicalizePath(location.project.canonical)
  return !FSUtil.contains(workspace, canonical) && !FSUtil.contains(project, canonical)
}
