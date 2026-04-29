export type KiroErrorCategory =
  | "network_dns"
  | "network_connect"
  | "network_timeout"
  | "caller_abort"
  | "auth"
  | "quota"
  | "payload_too_large"
  | "upstream_5xx"
  | "mcp_error"
  | "unknown"

const REDACTED = "[redacted]"
const SECRET_KEYS = /authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|profile[_-]?arn|mcp[_-]?authorization|client[_-]?secret/i
const TOKEN_LIKE = /\b(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{24,}\b/g

export function classifyNetworkError(error: unknown): { category: KiroErrorCategory; message: string; detail: string } {
  const detail = errorMessage(error)
  const lower = detail.toLowerCase()
  const category: KiroErrorCategory = error instanceof DOMException && error.name === "AbortError" || /timeout|timed out|abort/.test(lower)
    ? "network_timeout"
    : /enotfound|eai_again|getaddrinfo|dns|name resolution|could not resolve/.test(lower)
      ? "network_dns"
      : /econnrefused|econnreset|econnaborted|network down|connection|connect|fetch failed/.test(lower)
        ? "network_connect"
        : "unknown"
  return { category, detail: redact(detail), message: networkMessage(category, detail) }
}

export function classifyHttpError(status: number, body: string): KiroErrorCategory {
  const lower = body.toLowerCase()
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "quota"
  if (status >= 500) return "upstream_5xx"
  if (/content length|too large|exceeds|context limit|payload|improperly formed request|malformed request/.test(lower)) return "payload_too_large"
  return "unknown"
}

export function publicHttpErrorBody(status: number, body: string, category = classifyHttpError(status, body)) {
  const preview = bounded(redact(body))
  if (category === "auth") return `Kiro auth error (${status}). Reconnect or refresh the active Kiro account. Details: ${preview}`
  if (category === "quota") return `Kiro quota/rate limit error (${status}). Wait for quota reset or reduce request frequency. Details: ${preview}`
  if (category === "payload_too_large") return `Kiro payload/context error (${status}). Reduce or compact the request context before retrying. Details: ${preview}`
  if (category === "upstream_5xx") return `Kiro upstream service error (${status}). Retry later. Details: ${preview}`
  return preview
}

export function redact(value: string) {
  let redacted = value.replace(TOKEN_LIKE, REDACTED)
  redacted = redacted.replace(new RegExp(`("(?:${SECRET_KEYS.source})"\\s*:\\s*")([^"]+)(")`, "gi"), `$1${REDACTED}$3`)
  redacted = redacted.replace(new RegExp(`((?:${SECRET_KEYS.source})\\s*[=:]\\s*)([^\\s,;]+)`, "gi"), `$1${REDACTED}`)
  return redacted
}

function networkMessage(category: KiroErrorCategory, detail: string) {
  const safeDetail = bounded(redact(detail))
  if (category === "network_dns") return `Kiro network error (${category}): could not resolve the Kiro API host. Check DNS, VPN, proxy, or network settings. Details: ${safeDetail}`
  if (category === "network_connect") return `Kiro network error (${category}): could not connect to Kiro. Check connectivity, proxy/VPN, and firewall settings. Details: ${safeDetail}`
  if (category === "network_timeout") return `Kiro network error (${category}): the Kiro request timed out before a response completed. Retry or check network stability. Details: ${safeDetail}`
  return `Kiro network error (${category}): request failed before Kiro returned a response. Details: ${safeDetail}`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function bounded(value: string, limit = 2000) {
  return value.length > limit ? `${value.slice(0, limit)}...[truncated]` : value
}
