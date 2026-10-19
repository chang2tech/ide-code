export * as PolicyLoader from "./loader.js"

import { Effect, Option, Schema } from "effect"
import path from "path"
import { PermissionsFile, type ApprovalMode } from "./schema.js"

// Layered policy sources, low → high precedence (docs/rea/deep-sandbox.md §5):
// user (~/.ide, ~/.cursor compat) → project (.ide/, .cursor/ compat) → team → admin.
// Within a layer our .ide/ namespace wins over .cursor/ on conflict.
// Merge is per-key `??`: the highest layer defining a key wins it.

const readJsonFile = (file: string): Effect.Effect<unknown, never> =>
  Effect.tryPromise({
    try: async () => JSON.parse(await Bun.file(file).text()) as unknown,
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))

const decodeFile = (value: unknown): PermissionsFile | undefined => {
  const decoded = Schema.decodeUnknownOption(PermissionsFile)(value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

const loadLayer = (dir: string): Effect.Effect<PermissionsFile | undefined, never> =>
  Effect.gen(function* () {
    // Our namespace wins on conflict.
    const ours = decodeFile(yield* readJsonFile(path.join(dir, ".ide", "permissions.json")))
    if (ours !== undefined) return ours
    return decodeFile(yield* readJsonFile(path.join(dir, ".cursor", "permissions.json")))
  })

export interface EffectivePolicy {
  readonly mcpAllowlist: ReadonlyArray<string> | undefined
  readonly terminalAllowlist: ReadonlyArray<string> | undefined
  readonly approvalMode: ApprovalMode | undefined
  readonly allowInstructions: ReadonlyArray<string>
  readonly blockInstructions: ReadonlyArray<string>
  readonly deleteFileProtection: boolean
  readonly adminCommandDenylist: ReadonlyArray<string>
  readonly isAdminControlled: boolean
  readonly sandboxPolicyType: "insecure_none" | "workspace_readwrite" | "workspace_readonly" | undefined
  readonly forcePrompt: ReadonlyArray<string> | undefined
  // Which layers contributed, for diagnostics (never log values classified CREDENTIALS).
  readonly layers: ReadonlyArray<string>
}

const pick = <T>(...layers: Array<T | undefined>): T | undefined => {
  for (const layer of layers) if (layer !== undefined) return layer
  return undefined
}

export const load = (input: { home: string; workspace: string }): Effect.Effect<EffectivePolicy> =>
  Effect.gen(function* () {
    const user = yield* loadLayer(input.home)
    const project = yield* loadLayer(input.workspace)
    // Team distribution needs a server (UNKNOWN per dissection); local stand-in via env path.
    const teamPath = process.env.IDE_TEAM_PERMISSIONS
    const team = teamPath === undefined ? undefined : decodeFile(yield* readJsonFile(teamPath))
    const adminPath = process.env.IDE_ADMIN_PERMISSIONS
    const admin = adminPath === undefined ? undefined : decodeFile(yield* readJsonFile(adminPath))

    const allowInstructions =
      pick(team?.autoRun?.allow_instructions, team?.autoReview?.allow_instructions, project?.autoRun?.allow_instructions, project?.autoReview?.allow_instructions, user?.autoRun?.allow_instructions, user?.autoReview?.allow_instructions) ?? []
    const blockInstructions =
      pick(team?.autoRun?.block_instructions, team?.autoReview?.block_instructions, project?.autoRun?.block_instructions, project?.autoReview?.block_instructions, user?.autoRun?.block_instructions, user?.autoReview?.block_instructions) ?? []

    const layers: string[] = []
    if (user) layers.push("user")
    if (project) layers.push("project")
    if (team) layers.push("team")
    if (admin) layers.push("admin")

    return {
      mcpAllowlist: pick(team?.mcpAllowlist, project?.mcpAllowlist, user?.mcpAllowlist),
      terminalAllowlist: pick(team?.terminalAllowlist, project?.terminalAllowlist, user?.terminalAllowlist),
      approvalMode: pick(team?.approvalMode, project?.approvalMode, user?.approvalMode),
      allowInstructions,
      blockInstructions,
      // Secure default: delete-file protection is ON unless explicitly opted out.
      deleteFileProtection: pick(team?.deleteFileProtection, project?.deleteFileProtection, user?.deleteFileProtection) ?? true,
      adminCommandDenylist: admin?.adminCommandDenylist ?? [],
      isAdminControlled: admin?.isAdminControlled ?? false,
      // Secure default: workspace_readonly unless explicitly opted out.
      // (gate.ts's escalation guard and service.ts's substrate default both
      // assume this; leaving it undefined here made the guard silently skip.)
      sandboxPolicyType: pick(team?.sandboxPolicyType, project?.sandboxPolicyType, user?.sandboxPolicyType) ?? "workspace_readonly",
      forcePrompt: pick(team?.forcePrompt, project?.forcePrompt, user?.forcePrompt),
      layers,
    }
  })
