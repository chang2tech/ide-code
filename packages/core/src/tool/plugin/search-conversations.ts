export * as SearchConversationsTool from "./search-conversations.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { DateTime, Effect, Schema } from "effect"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import type { SessionMessage } from "../../session/message.js"

// search_conversations: search past conversations by keyword
// (DEV-GAPS-78, handler-trap audit follow-up to DEV-GAPS-75).
//
// Wire contract — verified by slicing the protobuf-es descriptors in the
// Cursor 3.25.9 bundle
// extensions/cursor-agent-worker/dist/main.js (NOT the older dissection
// doc, which missed both `limit` and the result list):
//   @485532 agent.v1.ConversationSearchArgs{
//     no:1 query:string, no:2 tool_call_id:string,
//     no:3 limit:int32 (opt)}
//   @485725 agent.v1.ConversationSearchResult{oneof result:
//     success:ConversationSearchSuccess, error:ConversationSearchError}
//   @485904 agent.v1.ConversationSearchSuccess{
//     no:1 hits:ConversationSearchHit[] (repeated),
//     no:2 truncated:bool, no:3 partial:bool, no:4 rebuilding:bool}
//   ConversationSearchHit{
//     no:1 conversation_id:string, no:2 title:string,
//     no:3 source:enum ConversationSearchSource,
//     no:4 updated_at_ms:int64, no:5 snippet:string (opt)}
//   ConversationSearchSource{0:UNSPECIFIED, 1:LOCAL, 2:CLOUD_CACHE}
//   ConversationSearchError{no:1 error:string}
// Model-facing parameters (cursor-agent-exec/dist/main.js @4271083):
// query is a required non-empty string and limit is an optional int
// 1-100 defaulting to 20; tool_call_id is injected by the framework, not
// a model parameter (same pattern as reflect/report_bug in wave 75), so
// it is not part of the tool Input below. The model-visible rendering in
// Cursor (same offset) lists "[local] \"title\" (id: …, updated: …)" plus
// an optional snippet line, then flags for truncated/rebuilding/partial;
// the `content` string below mirrors that rendering.
// This was an alias-only trap: `aliases.ts` mapped SEARCH_CONVERSATIONS
// → "search_conversations" but no tool plugin existed, and its trap note
// wrongly claimed the result shape was UNKNOWN.
//
// HONEST DIVERGENCE: Cursor searches a dedicated local FTS index
// (conversationSearchMain.js: SQLite FTS over local + cached cloud
// conversations, with a rebuild state). This engine has NO such index
// and NO cloud-agent cache; the real, queryable conversation store that
// exists here is SessionStore (src/session/store.ts, global
// Database-backed): list() reads the `session_v2` table and messages()
// reads projected `session_message` rows. The executor therefore scans
// that store (title + visible message text), reached through the
// Session service facade — Session.list/messages delegate to
// SessionStore.list/messages (src/session.ts) but not 1:1: list
// parses any cursor, defaults the limit (50) and wraps the store
// result as {data, cursor}; messages first checks the session
// exists (Session.get, failing NotFoundError) before delegating.
// Session is the
// session service the internal plugin host actually provides to tool
// plugins (plugin/internal.ts Requirements; precedent: switchmode.ts,
// subagent.ts yield Session.Service, never SessionStore directly).
// Consequences, stated rather than hidden:
// - source is always "LOCAL" — there are no CLOUD_CACHE conversations.
// - rebuilding is always false — truthfully: there is no index to
//   rebuild; every search reads the live store.
// - partial is true exactly when a scan cap below stopped the search
//   early, mirroring Cursor's "search stopped early" flag.
// - No relevance ranking: hits keep SessionStore's order (updated desc).
// - Scan scope is the WHOLE global store (DEV-GAPS-79/W79C): the
//   executor below calls Session.list with only a limit — no
//   workspaceID, directory, or project filter (SessionStore's
//   ListInput supports all three; none is passed) — so hits can come
//   from any workspace/project recorded in the store. The tool
//   description below states this plainly; do not re-add a
//   "this workspace" claim unless a real filter is wired in.

export const name = "search_conversations"

export const description = [
  "Search past conversations in the local session store by keyword. The store is global, so results are not limited to this workspace. Every unquoted keyword must match the same conversation, so queries with many keywords often return no results; run several searches with 1–2 keywords each instead. Use quotes only for a short exact phrase.",
  "Returns conversation IDs, titles, and short snippets — not full transcripts.",
].join("\n")

export const Input = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "One or two keywords, or a short exact phrase in quotes, to search for in conversation titles and visible user/assistant message text. Every unquoted keyword must match the same conversation; use separate searches for additional keywords.",
  }),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))).annotate({
    description: "Maximum number of conversation results to return (1-100). Defaults to 20.",
  }),
})

const Hit = Schema.Struct({
  conversation_id: Schema.String,
  title: Schema.String,
  source: Schema.Literals(["UNSPECIFIED", "LOCAL", "CLOUD_CACHE"]),
  updated_at_ms: Schema.Number,
  snippet: Schema.optionalKey(Schema.String),
})

export const Output = Schema.Struct({
  hits: Schema.Array(Hit),
  truncated: Schema.Boolean,
  partial: Schema.Boolean,
  rebuilding: Schema.Boolean,
})

const DEFAULT_LIMIT = 20
// Scan caps: without an FTS index a search is O(sessions × messages).
// Exceeding either cap sets `partial` (the search genuinely stopped
// early for the unscanned remainder) instead of silently pretending the
// whole store was searched.
const MAX_SESSIONS_SCANNED = 500
const MAX_MESSAGES_PER_SESSION = 200
const MAX_SNIPPET_CHARS = 160

// Visible text of one stored message, following Cursor's contract of
// searching "visible user/assistant message text": user/synthetic/system
// text, assistant text parts (reasoning and tool internals excluded),
// shell commands, and compaction summaries.
const messageText = (message: SessionMessage.Info): string => {
  switch (message.type) {
    case "user":
    case "synthetic":
    case "system":
    case "skill":
      return message.text
    case "shell":
      return message.command
    case "assistant":
      return message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    case "compaction":
      return message.status === "failed" ? "" : `${message.summary}\n${message.recent}`
    default:
      return ""
  }
}

const parseQuery = (raw: string): { readonly phrase?: string; readonly terms: readonly string[] } => {
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"'))
    return { phrase: trimmed.slice(1, -1).trim().toLowerCase(), terms: [] }
  return { terms: trimmed.toLowerCase().split(/\s+/).filter(Boolean) }
}

const makeSnippet = (texts: readonly string[], needle: string): string | undefined => {
  const text = texts.find((candidate) => candidate.toLowerCase().includes(needle))
  if (text === undefined) return undefined
  const flat = text.replace(/\s+/g, " ").trim()
  const index = flat.toLowerCase().indexOf(needle)
  const start = Math.max(0, index - 40)
  const end = Math.min(flat.length, index + needle.length + 80)
  const excerpt = flat.slice(start, end)
  if (excerpt.length <= MAX_SNIPPET_CHARS) return `${start > 0 ? "…" : ""}${excerpt}${end < flat.length ? "…" : ""}`
  return `${excerpt.slice(0, MAX_SNIPPET_CHARS)}…`
}

export const Plugin = {
  id: "opencode.tool.search_conversations",
  effect: Effect.fn("SearchConversationsTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [context.sessionID],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              const parsed = parseQuery(input.query)
              const needle = parsed.phrase ?? parsed.terms[0]
              if (needle === undefined || needle === "")
                return yield* new ToolFailure({ message: "Search query cannot be empty." })
              const limit = input.limit ?? DEFAULT_LIMIT

              // Fetch one past each cap so hitting a cap is detectable.
              const listed = yield* sessions.list({ limit: MAX_SESSIONS_SCANNED + 1 })
              const scanned = listed.data.slice(0, MAX_SESSIONS_SCANNED)
              let partial = listed.data.length > MAX_SESSIONS_SCANNED

              const matches: Array<typeof Hit.Type> = []
              for (const session of scanned) {
                const messages = yield* sessions.messages({
                  sessionID: session.id,
                  order: "asc",
                  limit: MAX_MESSAGES_PER_SESSION + 1,
                })
                if (messages.length > MAX_MESSAGES_PER_SESSION) partial = true
                const texts = messages.slice(0, MAX_MESSAGES_PER_SESSION).map(messageText).filter(Boolean)
                const title = session.title ?? ""
                const haystack = [title, ...texts].join("\n").toLowerCase()
                const matched =
                  parsed.phrase !== undefined
                    ? haystack.includes(parsed.phrase)
                    : parsed.terms.every((term) => haystack.includes(term))
                if (!matched) continue
                const snippet = makeSnippet(texts, needle) ?? makeSnippet([title], needle)
                matches.push({
                  conversation_id: session.id,
                  title,
                  source: "LOCAL",
                  updated_at_ms: DateTime.toEpochMillis(session.time.updated),
                  ...(snippet === undefined ? {} : { snippet }),
                })
              }

              const truncated = matches.length > limit
              const hits = matches.slice(0, limit)
              const output = { hits, truncated, partial, rebuilding: false }
              // Content rendering mirrors Cursor's render (agent-exec
              // bundle, function UEe @4271592) EXCEPT one line
              // (DEV-GAPS-79/W79C): when `rebuilding` is true Cursor
              // pushes "The conversation search index is rebuilding;
              // results may be incomplete." (string @4272188) between
              // the truncated and partial lines below. This fork omits
              // that line deliberately — `rebuilding` is always false
              // here because there is no FTS index and therefore no
              // index-rebuild state (see header) — so the omitted line
              // could never render and there is no behavior difference
              // today. Do not invent rebuild logic to "fix" this; if a
              // real index with a rebuild state is ever introduced,
              // restore the line in Cursor's position (after the
              // truncated line, before the partial line).
              const content =
                hits.length === 0
                  ? "No matching conversations found."
                  : [
                      `Found ${hits.length} conversation${hits.length === 1 ? "" : "s"}:`,
                      ...hits.map((hit, index) => {
                        const updated =
                          hit.updated_at_ms === 0 ? "unknown" : new Date(hit.updated_at_ms).toISOString()
                        const lines = [
                          `${index + 1}. [local] "${hit.title}" (id: ${hit.conversation_id}, updated: ${updated})`,
                        ]
                        if (hit.snippet !== undefined && hit.snippet.length > 0) lines.push(`   snippet: ${hit.snippet}`)
                        return lines.join("\n")
                      }),
                      ...(truncated
                        ? ["Additional matches were omitted because the result limit was reached."]
                        : []),
                      ...(partial ? ["Search stopped early; partial results were returned."] : []),
                    ].join("\n")
              return { output, content, metadata: {} }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: "Search conversations tool failed", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
