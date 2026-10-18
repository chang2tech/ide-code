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
