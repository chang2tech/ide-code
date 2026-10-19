export * as LogRedaction from "./redaction.js"

import type { FieldClassification } from "./schema.js"

// Logging hygiene: proto field-classification map (docs/rea/deep-sandbox.md §7).
// CREDENTIALS fields are never logged — only their presence may be recorded.

export interface ClassifiedField {
  readonly value: unknown
  readonly classification: FieldClassification
}

const CREDENTIAL_KEYS =
  /token|secret|password|passwd|api[_-]?key|credential|auth|private[_-]?key|bearer|session[_-]?key/i

// Best-effort classification for fields not in an explicit map.
export const classifyKey = (key: string): FieldClassification => {
  if (CREDENTIAL_KEYS.test(key)) return "CREDENTIALS"
  if (/^(path|file|dir|directory|working_directory|uri|url)$/i.test(key)) return "PATH"
  if (/^(command|stdout|stderr|output|content|prompt|message|plan)$/i.test(key)) return "CODE"
  return "SAFE"
}

export const redactValue = (value: unknown, classification: FieldClassification): unknown => {
  switch (classification) {
    case "CREDENTIALS":
      return value === undefined || value === null || value === "" ? value : "[REDACTED]"
    case "CODE":
      return typeof value === "string" && value.length > 2000 ? `${value.slice(0, 2000)}…[truncated]` : value
    default:
      return value
  }
}

// Scrub secret-shaped substrings from free-form command text before logging.
// Keeps the flag/key name for debuggability, replaces only the secret value.
// Applied to CODE-classified command text, which truncation alone does not protect.
const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  // Authorization: Bearer <token> / -H "Authorization: Bearer <token>"
  /(\bbearer\s+)[A-Za-z0-9\-._~+/=]{8,}/gi,
  // https://user:pass@host — URL-embedded credentials (curl, git, wget);
  // the whole userinfo is dropped, leaving https://[REDACTED]host/…
  /(https?:\/\/)(?:[^\/\s:@]+:)?[^\/\s@]+@/gi,
  // --password=secret, --token <token>, -psecret, "authorization": "…"
  // (skips `Authorization: Bearer …` — pattern 1 already handled the token)
  /((?:--?(?:password|passwd|token|secret|api[_-]?key|auth|credential)|["']?authorization["']?)\s*[:=]\s*["']?)((?!bearer\b)[^"'\s;|&]+)/gi,
  // export AWS_SECRET_ACCESS_KEY=… / SECRET=…
  /(\bexport\s+[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY)\s*=\s*)([^\s;|&]+)/gi,
]

export const scrubCommandSecrets = (text: string | undefined): string | undefined => {
  if (typeof text !== "string" || text === "") return text
  let out = text
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, "$1[REDACTED]")
  return out
}

// Redact a record of classified fields for safe logging.
export const redactFields = (fields: Record<string, ClassifiedField>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(fields)) out[key] = redactValue(field.value, field.classification)
  return out
}

// Explicit classification map for the policy-engine's own log surface.
// Additions here must mirror the proto map: never downgrade a CREDENTIALS field.
export const PolicyLogFields: Record<string, FieldClassification> = {
  tool: "SAFE",
  sessionID: "SAFE",
  decision: "SAFE",
  command: "CODE",
  working_directory: "PATH",
  path: "PATH",
  url: "PATH",
  stdout: "CODE",
  stderr: "CODE",
  connection_token: "CREDENTIALS",
  api_key_credentials: "CREDENTIALS",
  secret_scope_id: "CREDENTIALS",
}
