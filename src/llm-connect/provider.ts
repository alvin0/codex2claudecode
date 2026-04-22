import type { ClaudeMessagesRequest, JsonObject, RequestProxyLog } from "../types"

/**
 * Unified LLM provider interface.
 *
 * Both Codex and Kiro implement this so the runtime can proxy Claude API
 * requests without knowing which backend is active.
 */
export interface LlmProvider {
  /** Provider identifier shown in logs and UI. */
  readonly name: string

  /**
   * Handle a Claude Messages API request (`POST /v1/messages`).
   * Returns a Response that the runtime can forward directly to the caller.
   */
  handleMessages(
    request: Request,
    requestId: string,
    options?: HandleMessagesOptions,
  ): Promise<Response>

  /**
   * Handle a Claude count_tokens request (`POST /v1/messages/count_tokens`).
   */
  handleCountTokens(request: Request): Promise<Response>

  /**
   * Proxy an OpenAI-shaped request (responses or chat/completions) to the
   * upstream and return the raw Response.
   */
  proxy(body: JsonObject, options?: ProxyOptions): Promise<Response>

  /**
   * Quick connectivity check. Implementations should return within
   * `timeoutMs` and never throw.
   */
  checkHealth(timeoutMs?: number): Promise<HealthResult>

  /**
   * Refresh the provider's auth tokens. Returns the new token state or
   * throws if refresh fails.
   */
  refresh(): Promise<unknown>
}

export interface HandleMessagesOptions {
  logBody?: boolean
  onProxy?: (entry: RequestProxyLog) => void
}

export interface ProxyOptions {
  headers?: HeadersInit
  signal?: AbortSignal
}

export interface HealthResult {
  ok: boolean
  checkedAt?: string
  latencyMs?: number
  status?: number
  error?: string
}
