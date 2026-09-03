/**
 * JSON-RPC 2.0 over HTTP for the MCP methods `initialize`, `tools/list`, and
 * `tools/call` (Requirement 20.1).
 *
 * This is the provider-agnostic generalization of the single-shot MCP request an
 * upstream connector used to own: the same envelope and the same
 * `401/403 → refresh → retry once` branch, with two things lifted out —
 * authorization arrives as a **call parameter** and the refresh arrives as an
 * injected {@link McpClientOptions.onUnauthorized} hook. As a result this module
 * reads **zero** credential files (Requirement 20.2) and imports nothing from
 * `src/inbound/` or `src/upstream/` (Requirement 20.7).
 *
 * Failure is always a thrown {@link McpProtocolError} carrying a category, never
 * a silently empty result (Requirements 20.4, 20.5).
 */

import type { JsonObject } from "../types"

import { categoryForJsonRpcCode, categoryForStatus, McpProtocolError } from "./errors"
import type { McpCallResult, McpRemoteTool } from "./types"

/** MCP protocol revision this client negotiates. */
export const MCP_PROTOCOL_VERSION = "2025-06-18"

/** `clientInfo` reported during `initialize`. Deliberately provider-neutral. */
export const MCP_CLIENT_INFO = { name: "mcp-gateway", version: "1.0.0" } as const

/** Default per-request timeout. Matches the value the upstream MCP path used. */
export const MCP_DEFAULT_TIMEOUT_MS = 60_000

/** Authorization material for a remote MCP server, supplied by the caller. */
export interface McpAuth {
  /**
   * Bearer material. Used verbatim when it already carries an auth scheme
   * (`Bearer …`, `Basic …`), otherwise sent as `Bearer <value>`. The outgoing
   * `authorization` header derives from this field and nothing else.
   */
  authorization?: string
  /** Extra headers to forward. Applied before `authorization`. */
  headers?: Record<string, string>
}

export interface McpClientOptions {
  fetch?: typeof fetch
  /** Client-wide abort signal, combined with any per-call signal. */
  signal?: AbortSignal
  /** Called once on 401/403 to obtain fresh authorization, then the call is retried once. */
  onUnauthorized?: () => Promise<string | undefined>
  /** Per-request timeout. Defaults to {@link MCP_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Injectable id source, so a test can pin the JSON-RPC `id`. */
  requestId?: () => string
}

/** Per-call overrides. A call may narrow the signal or swap the credential. */
export interface McpRequestOptions {
  signal?: AbortSignal
  auth?: McpAuth
}

/** A parsed JSON-RPC 2.0 reply, before method-specific interpretation. */
export interface McpJsonRpcResponse {
  id?: unknown
  jsonrpc?: unknown
  result?: unknown
  /** Absent *or* `null` both mean success: some servers send `"error": null`. */
  error?: unknown
}

export class McpClient {
  private readonly serverUrl: string
  private readonly auth: McpAuth
  private readonly fetchFn: typeof fetch
  private readonly signal?: AbortSignal
  private readonly onUnauthorized?: () => Promise<string | undefined>
  private readonly timeoutMs: number
  private readonly nextRequestId: () => string
  /** Replaced in place by a successful {@link McpClientOptions.onUnauthorized}. */
  private authorization?: string

  constructor(serverUrl: string, auth: McpAuth = {}, options: McpClientOptions = {}) {
    this.serverUrl = serverUrl
    this.auth = auth
    this.authorization = auth.authorization
    this.fetchFn = options.fetch ?? fetch
    this.signal = options.signal
    this.onUnauthorized = options.onUnauthorized
    this.timeoutMs = options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS
    this.nextRequestId = options.requestId ?? (() => `mcp_${crypto.randomUUID().replace(/-/g, "")}`)
  }

  /** Perform the MCP handshake. Throws on any non-conforming reply. */
  async initialize(options: McpRequestOptions = {}): Promise<void> {
    await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { ...MCP_CLIENT_INFO },
      },
      options,
    )
  }

  /** List the tools the server advertises. */
  async listTools(options: McpRequestOptions = {}): Promise<McpRemoteTool[]> {
    const result = this.expectObjectResult(await this.request("tools/list", {}, options), "tools/list")
    if (!Array.isArray(result.tools)) {
      throw new McpProtocolError("protocol", "MCP tools/list returned no tools array")
    }
    return result.tools.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return []
      const tool = entry as JsonObject
      if (typeof tool.name !== "string" || !tool.name) return []
      return [
        {
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          ...(isPlainObject(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
        },
      ]
    })
  }

  /**
   * Invoke a tool. The text-embedded envelope
   * `{result:{content:[{type:"text",text:"<json>"}]}}` is unwrapped and its
   * payload parsed (Requirement 20.3); text that fails to parse throws
   * `malformed_payload` rather than returning an empty result
   * (Requirement 20.5).
   */
  async callTool(name: string, args: unknown, options: McpRequestOptions = {}): Promise<McpCallResult> {
    const result = this.expectObjectResult(
      await this.request("tools/call", { name, arguments: args ?? {} }, options),
      "tools/call",
    )
    return {
      content: parseMcpTextEnvelope(result.content),
      isError: result.isError === true,
    }
  }

  /**
   * Send one JSON-RPC request and return the reply's `result`.
   *
   * Public because an upstream connector may own a bespoke `result` shape and
   * only wants the protocol layer — envelope, headers, auth retry, abort —
   * delegated here.
   */
  async request(method: string, params: unknown, options: McpRequestOptions = {}): Promise<unknown> {
    const body = buildJsonRpcRequest(this.nextRequestId(), method, params)
    const response = await this.send(body, options)
    return readJsonRpcResult(await this.readJson(response, method), method)
  }

  /** The raw JSON-RPC reply body, for a caller that parses `result` itself. */
  async requestRaw(method: string, params: unknown, options: McpRequestOptions = {}): Promise<McpJsonRpcResponse> {
    const body = buildJsonRpcRequest(this.nextRequestId(), method, params)
    const response = await this.send(body, options)
    return await this.readJson(response, method)
  }

  /**
   * One HTTP round trip, with the single auth retry. A 401/403 calls
   * `onUnauthorized` once, adopts whatever authorization it returns, and repeats
   * the request exactly once; a second rejection throws `unauthorized`.
   */
  private async send(body: string, options: McpRequestOptions): Promise<Response> {
    const response = await this.fetchOnce(body, options)
    if (response.status !== 401 && response.status !== 403) {
      if (!response.ok) throw await this.toHttpError(response)
      return response
    }

    if (!this.onUnauthorized) throw await this.toHttpError(response)

    const refreshed = await this.onUnauthorized()
    if (refreshed !== undefined) this.authorization = refreshed
    const retried = await this.fetchOnce(body, options)
    if (!retried.ok) throw await this.toHttpError(retried)
    return retried
  }

  private async fetchOnce(body: string, options: McpRequestOptions): Promise<Response> {
    const callerSignal = mergeSignals(this.signal, options.signal)
    const request = withTimeout(callerSignal, this.timeoutMs)
    try {
      return await this.fetchFn(this.serverUrl, {
        method: "POST",
        headers: this.headers(options.auth),
        body,
        signal: request.signal,
      })
    } catch (error) {
      // A caller-initiated abort is the caller's own error, propagated as-is
      // (Requirement 20.6). Anything else is a transport failure.
      if (isAbortError(error) && callerSignal?.aborted) throw error
      throw new McpProtocolError("transport", `MCP request failed: ${errorMessage(error)}`, { cause: error })
    } finally {
      request.cleanup()
    }
  }

  /**
   * Outgoing headers. `content-type` first, then the caller's extra headers,
   * then `authorization` — so the authorization header derives only from the
   * authorization material passed in, never from a stale default.
   */
  private headers(callAuth?: McpAuth): Headers {
    const headers = new Headers()
    headers.set("content-type", "application/json")
    for (const [key, value] of Object.entries({ ...this.auth.headers, ...callAuth?.headers })) {
      if (typeof value === "string") headers.set(key, value)
    }
    const authorization = callAuth?.authorization ?? this.authorization
    if (authorization) headers.set("authorization", asAuthorizationHeader(authorization))
    return headers
  }

  private async readJson(response: Response, method: string): Promise<McpJsonRpcResponse> {
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch (error) {
      throw new McpProtocolError("protocol", `MCP ${method} returned a non-JSON body: ${errorMessage(error)}`, {
        status: response.status,
        cause: error,
      })
    }
    if (!isPlainObject(parsed)) {
      throw new McpProtocolError("protocol", `MCP ${method} returned a non-object JSON-RPC body`, {
        status: response.status,
      })
    }
    return parsed as McpJsonRpcResponse
  }

  private expectObjectResult(result: unknown, method: string): JsonObject {
    if (!isPlainObject(result)) {
      throw new McpProtocolError("protocol", `MCP ${method} returned a non-object result`)
    }
    return result
  }

  private async toHttpError(response: Response): Promise<McpProtocolError> {
    const body = await response.text().catch(() => "")
    return new McpProtocolError(
      categoryForStatus(response.status),
      `MCP server returned HTTP ${response.status}${body ? `: ${truncate(body)}` : ""}`,
      { status: response.status },
    )
  }
}

/** The outgoing JSON-RPC 2.0 envelope. */
export function buildJsonRpcRequest(id: string, method: string, params: unknown): string {
  return JSON.stringify({
    id,
    jsonrpc: "2.0",
    method,
    ...(params === undefined ? {} : { params }),
  })
}

/**
 * Interpret a JSON-RPC reply: return `result`, or throw with the category the
 * `error` object maps to (Requirement 20.4).
 *
 * `error: null` counts as success — a measured server shape.
 */
export function readJsonRpcResult(body: McpJsonRpcResponse, method: string): unknown {
  if (body.jsonrpc !== undefined && body.jsonrpc !== "2.0") {
    throw new McpProtocolError("protocol", `MCP ${method} reply declared jsonrpc ${JSON.stringify(body.jsonrpc)}`)
  }

  if (body.error !== undefined && body.error !== null) {
    const error = isPlainObject(body.error) ? body.error : {}
    const code = typeof error.code === "number" ? error.code : undefined
    const message = typeof error.message === "string" && error.message ? error.message : JSON.stringify(body.error)
    throw new McpProtocolError(categoryForJsonRpcCode(code), `MCP ${method} failed: ${message}`, {
      ...(code !== undefined ? { code } : {}),
      ...(error.data !== undefined ? { data: error.data } : {}),
    })
  }

  if (body.result === undefined || body.result === null) {
    throw new McpProtocolError("protocol", `MCP ${method} reply carried neither result nor error`)
  }
  return body.result
}

/**
 * Unwrap the text-embedded payload MCP servers use for structured results:
 * `content: [{ type: "text", text: "<json>" }]` yields the parsed JSON value —
 * any JSON value, including a string, number, or array. Content that is not a
 * single text part is returned unchanged; text that fails to parse throws
 * `malformed_payload` (Requirements 20.3, 20.5).
 */
export function parseMcpTextEnvelope(content: unknown): unknown {
  if (!Array.isArray(content) || content.length !== 1) return content
  const first = content[0]
  if (!isPlainObject(first) || first.type !== "text" || typeof first.text !== "string") return content
  try {
    return JSON.parse(first.text) as unknown
  } catch (error) {
    throw new McpProtocolError(
      "malformed_payload",
      `MCP result text is not valid JSON: ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

function asAuthorizationHeader(authorization: string): string {
  return /^\S+\s+\S/.test(authorization) ? authorization : `Bearer ${authorization}`
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Combine the client-wide and per-call signals into one, or reuse the only one. */
function mergeSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (!first) return second
  if (!second || first === second) return first
  const controller = new AbortController()
  for (const signal of [first, second]) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/** Layer a timeout over the caller's signal without mutating it. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(signal?.reason)
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener("abort", abortFromCaller, { once: true })

  const timeout = setTimeout(() => controller.abort(new DOMException("Signal timed out", "AbortError")), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abortFromCaller)
    },
  }
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(value: string, limit = 500): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}
