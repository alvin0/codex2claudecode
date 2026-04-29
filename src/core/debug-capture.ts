import type { JsonObject } from "./types"

export const DEBUG_PREVIEW_LIMIT = 4000

export function kiroDebugOnErrorEnabled(env: Record<string, string | undefined> = process.env) {
  return ["1", "true", "yes", "on"].includes((env.KIRO_DEBUG_ON_ERROR ?? "").toLowerCase())
}

export function createKiroDebugBundle(input: {
  route: string
  status: number
  error: string
  model?: unknown
  requestBody?: string
  upstreamRequestBody?: string
  upstreamResponseBody?: string
  transformedResponseBody?: string
}): JsonObject {
  return redactDebugValue({
    provider: "kiro",
    capture: "debug_on_error",
    route: input.route,
    status: input.status,
    model: typeof input.model === "string" ? input.model : undefined,
    error: preview(input.error),
    requestBody: preview(input.requestBody),
    upstreamRequestBody: preview(input.upstreamRequestBody),
    upstreamResponseBody: preview(input.upstreamResponseBody),
    transformedResponseBody: preview(input.transformedResponseBody),
  }) as JsonObject
}

export function redactDebugValue(value: unknown): unknown {
  if (typeof value === "string") return redactDebugText(value)
  if (Array.isArray(value)) return value.map(redactDebugValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    isSecretKey(key) ? "[redacted]" : redactDebugValue(item),
  ]))
}

export function redactDebugText(text: string) {
  return redactSensitiveText(text)
    .replace(/\b[A-Za-z0-9._~+/=-]{32,}\b/g, "[redacted]")
}

export function redactSensitiveText(text: string) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/"?(authorization|authorization_token|x-api-key|anthropic-api-key|accessToken|refreshToken|idToken|profileArn|mcpAuthorization|clientSecret|access_token|refresh_token|id_token)"?\s*:\s*"[^"]+"/gi, '"$1":"[redacted]"')
}

function preview(value: string | undefined) {
  if (value === undefined) return undefined
  const redacted = redactDebugText(value)
  return redacted.length > DEBUG_PREVIEW_LIMIT ? `${redacted.slice(0, DEBUG_PREVIEW_LIMIT)}...[truncated]` : redacted
}

function isSecretKey(key: string) {
  return /authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|profile[_-]?arn|mcp[_-]?authorization|client[_-]?secret/i.test(key)
}
