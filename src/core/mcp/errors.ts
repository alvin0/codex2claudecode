/**
 * Classifiable MCP failure categories.
 *
 * A caller decides what to do with an MCP failure — drop the toolset and emit a
 * notice, surface a tool error to the model, or fail the request — and that
 * decision depends on *why* the call failed. So every failure raised by
 * `src/core/mcp/` carries a category from one closed set rather than a bare
 * message (Requirement 20.4).
 */

/**
 * The closed set of MCP failure categories.
 *
 * - `transport` — the request never produced a response: DNS, connection reset,
 *   or a caller-independent abort.
 * - `http` — a non-2xx response that is not an auth rejection.
 * - `unauthorized` — 401/403, including after the single refresh-and-retry.
 * - `protocol` — a well-formed HTTP response that is not a valid JSON-RPC 2.0
 *   reply: wrong `jsonrpc` version, no `result` and no `error`, or a `result`
 *   whose shape the method does not allow.
 * - `malformed_payload` — the reply carried a text-embedded payload that failed
 *   to parse. Thrown rather than degraded to an empty result (Requirement 20.5).
 * - `tool_error` — the server returned a JSON-RPC `error` object; the transport
 *   and the protocol both worked.
 */
export type McpErrorCategory =
  | "transport"
  | "http"
  | "unauthorized"
  | "protocol"
  | "malformed_payload"
  | "tool_error"

/** Every category, in declaration order, for exhaustiveness checks and tests. */
export const MCP_ERROR_CATEGORIES: readonly McpErrorCategory[] = [
  "transport",
  "http",
  "unauthorized",
  "protocol",
  "malformed_payload",
  "tool_error",
]

/** An MCP failure tagged with the category a caller can branch on. */
export class McpProtocolError extends Error {
  readonly category: McpErrorCategory
  /** HTTP status, when the failure came from a response. */
  readonly status?: number
  /** JSON-RPC error code, when the failure came from an `error` object. */
  readonly code?: number
  /** JSON-RPC error `data`, preserved verbatim for the caller to inspect. */
  readonly data?: unknown

  constructor(
    category: McpErrorCategory,
    message: string,
    details: { status?: number; code?: number; data?: unknown; cause?: unknown } = {},
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined)
    this.name = "McpProtocolError"
    this.category = category
    if (details.status !== undefined) this.status = details.status
    if (details.code !== undefined) this.code = details.code
    if (details.data !== undefined) this.data = details.data
  }
}

/** Narrow an unknown thrown value to an {@link McpProtocolError}. */
export function isMcpProtocolError(error: unknown): error is McpProtocolError {
  return error instanceof McpProtocolError
}

/**
 * Map an HTTP status onto a category. 401 and 403 are the auth rejections the
 * client retries once; anything else non-2xx is `http`.
 */
export function categoryForStatus(status: number): McpErrorCategory {
  return status === 401 || status === 403 ? "unauthorized" : "http"
}

/**
 * Map a JSON-RPC error code onto a category.
 *
 * The JSON-RPC reserved range (-32768..-32000) describes a protocol-level
 * complaint — malformed request, unknown method, bad params — so it maps to
 * `protocol`. Codes outside that range are the server reporting that the *tool*
 * failed, which maps to `tool_error`. Auth codes some servers borrow from HTTP
 * (401/403) map to `unauthorized`.
 */
export function categoryForJsonRpcCode(code: number | undefined): McpErrorCategory {
  if (code === 401 || code === 403 || code === -32001) return "unauthorized"
  if (code !== undefined && code <= -32000 && code >= -32768) return "protocol"
  return "tool_error"
}
