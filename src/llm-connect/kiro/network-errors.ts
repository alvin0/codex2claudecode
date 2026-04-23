/**
 * Network error classification and user-friendly message formatting.
 *
 * Inspired by kiro-gateway's network_errors.py — provides a centralized system
 * for classifying network errors and converting them into actionable messages
 * with troubleshooting guidance.
 */

export type ErrorCategory =
  | "dns_resolution"
  | "connection_refused"
  | "connection_reset"
  | "network_unreachable"
  | "timeout_connect"
  | "timeout_read"
  | "ssl_error"
  | "proxy_error"
  | "too_many_redirects"
  | "rate_limited"
  | "server_error"
  | "auth_error"
  | "unknown"

export interface NetworkErrorInfo {
  category: ErrorCategory
  userMessage: string
  technicalDetails: string
  isRetryable: boolean
  suggestedHttpCode: number
  retryAfterMs?: number
}

/**
 * Classify a network/HTTP error into a structured NetworkErrorInfo.
 *
 * Analyzes the error message and type to determine the specific kind of
 * failure and whether it makes sense to retry.
 */
export function classifyNetworkError(error: unknown): NetworkErrorInfo {
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ""
  const technical = `${name}: ${message}`

  // DNS resolution failures
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i.test(message)) {
    return {
      category: "dns_resolution",
      userMessage: "DNS resolution failed — cannot resolve the provider's domain name.",
      technicalDetails: technical,
      isRetryable: true,
      suggestedHttpCode: 502,
    }
  }

  // Connection refused
  if (/ECONNREFUSED|Connection refused/i.test(message)) {
    return {
      category: "connection_refused",
      userMessage: "Connection refused — the server is not accepting connections.",
      technicalDetails: technical,
      isRetryable: true,
      suggestedHttpCode: 502,
    }
  }

  // Connection reset
  if (/ECONNRESET|Connection reset|EPIPE|broken pipe/i.test(message)) {
    return {
      category: "connection_reset",
      userMessage: "Connection reset — the server closed the connection unexpectedly.",
      technicalDetails: technical,
      isRetryable: true,
      suggestedHttpCode: 502,
    }
  }

  // Network unreachable
  if (/ENETUNREACH|Network is unreachable|No route to host|EHOSTUNREACH/i.test(message)) {
    return {
      category: "network_unreachable",
      userMessage: "Network unreachable — cannot reach the server's network.",
      technicalDetails: technical,
      isRetryable: true,
      suggestedHttpCode: 502,
    }
  }

  // SSL/TLS errors
  if (/SSL|TLS|certificate|CERT_|ERR_TLS/i.test(message)) {
    return {
      category: "ssl_error",
      userMessage: "SSL/TLS error — secure connection could not be established.",
      technicalDetails: technical,
      isRetryable: false,
      suggestedHttpCode: 502,
    }
  }

  // Timeout (connect vs read)
  if (/ETIMEDOUT|connect timeout|connection timed out/i.test(message)) {
    return {
      category: "timeout_connect",
      userMessage: "Connection timeout — server did not respond to connection attempt.",
      technicalDetails: technical,
      isRetryable: true,
      suggestedHttpCode: 504,
    }
  }

  if (/timeout|ESOCKETTIMEDOUT|read timeout|AbortError|abort/i.test(message)) {
    return {
      category: "timeout_read",
      userMessage: "Read timeout — server stopped responding during data transfer.",
      technicalDetails: technical,
      isRetryable: true,
      suggestedHttpCode: 504,
    }
  }

  // Proxy errors
  if (/proxy/i.test(message)) {
    return {
      category: "proxy_error",
      userMessage: "Proxy connection failed — cannot connect through the configured proxy.",
      technicalDetails: technical,
      isRetryable: true,
      suggestedHttpCode: 502,
    }
  }

  // Too many redirects
  if (/redirect/i.test(message)) {
    return {
      category: "too_many_redirects",
      userMessage: "Too many redirects — the server is redirecting in a loop.",
      technicalDetails: technical,
      isRetryable: false,
      suggestedHttpCode: 502,
    }
  }

  // Generic fetch/network failures
  if (/fetch failed|network|Unable to connect/i.test(message)) {
    return {
      category: "unknown",
      userMessage: "Network request failed due to an unexpected error.",
      technicalDetails: technical,
      isRetryable: true,
      suggestedHttpCode: 502,
    }
  }

  return {
    category: "unknown",
    userMessage: "An unexpected error occurred.",
    technicalDetails: technical,
    isRetryable: true,
    suggestedHttpCode: 500,
  }
}

/**
 * Classify an HTTP response status code into a NetworkErrorInfo.
 */
export function classifyHttpStatus(status: number, body?: string): NetworkErrorInfo {
  if (status === 401 || status === 403) {
    return {
      category: "auth_error",
      userMessage: `Authentication failed (${status}). Token may have expired.`,
      technicalDetails: `HTTP ${status}: ${body ?? ""}`.trim(),
      isRetryable: true, // retryable after token refresh
      suggestedHttpCode: status,
    }
  }

  if (status === 429) {
    return {
      category: "rate_limited",
      userMessage: "Rate limited — too many requests. Retrying after backoff.",
      technicalDetails: `HTTP 429: ${body ?? ""}`.trim(),
      isRetryable: true,
      suggestedHttpCode: 429,
    }
  }

  if (status >= 500) {
    return {
      category: "server_error",
      userMessage: `Server error (${status}). The service may be temporarily unavailable.`,
      technicalDetails: `HTTP ${status}: ${body ?? ""}`.trim(),
      isRetryable: true,
      suggestedHttpCode: status,
    }
  }

  return {
    category: "unknown",
    userMessage: `Unexpected HTTP status ${status}.`,
    technicalDetails: `HTTP ${status}: ${body ?? ""}`.trim(),
    isRetryable: false,
    suggestedHttpCode: status,
  }
}
