import type { HealthStatus } from "../../core/types"
import { responseHeaders } from "../../core/http"
import { McpClient, type McpJsonRpcResponse } from "../../core/mcp/client"
import { isMcpProtocolError } from "../../core/mcp/errors"
import { BASE_RETRY_DELAY_MS, DEFAULT_KIRO_API_REGION, GENERATE_ASSISTANT_RESPONSE_PATH, GET_USAGE_LIMITS_PATH, KIRO_API_HOST_TEMPLATE, LIST_AVAILABLE_MODELS_PATH, MAX_RETRIES, STREAMING_READ_TIMEOUT_MS, USER_AGENT_TEMPLATE, X_AMZ_USER_AGENT_TEMPLATE } from "./constants"
import type { Kiro_Auth_Manager } from "./auth"
import { parseMcpWebSearchResults, webSearchSummary } from "./web-search"
import { KiroHttpError, KiroMcpError, KiroNetworkError, type KiroGeneratePayload } from "./types"

/**
 * How many `ListAvailableModels` pages one walk will read.
 *
 * The measured live catalog is 20 entries on page one, so ten pages is roughly an order of magnitude
 * of headroom over the observed size while still being a bound. The cap is a guard against a
 * misbehaving cursor, not a tuning knob.
 */
export const LIST_AVAILABLE_MODELS_MAX_PAGES = 10

/** What one paginated model-catalog walk did, reported on the merged body. */
export interface KiroModelPagination {
  /** Pages actually read, always at least 1. */
  pages: number
  /** Whether the walk stopped on {@link LIST_AVAILABLE_MODELS_MAX_PAGES} with a cursor still live. */
  capReached: boolean
  maxPages: number
}

export class Kiro_Client {
  private readonly auth: Kiro_Auth_Manager
  private readonly fetchFn: typeof fetch
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly fingerprint: string
  private readonly kiroVersion: string
  private readonly apiRegion: string

  constructor(auth: Kiro_Auth_Manager, options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; fingerprint?: string; kiroVersion?: string; apiRegion?: string } = {}) {
    this.auth = auth
    this.fetchFn = options.fetch ?? fetch
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.fingerprint = options.fingerprint ?? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    this.kiroVersion = options.kiroVersion ?? "unknown"
    this.apiRegion = options.apiRegion ?? process.env.KIRO_API_REGION ?? DEFAULT_KIRO_API_REGION
  }

  async generateAssistantResponse(payload: KiroGeneratePayload, options: { signal?: AbortSignal; stream?: boolean } = {}) {
    return this.requestWithRetries(this.url(GENERATE_ASSISTANT_RESPONSE_PATH), "POST", JSON.stringify(payload), options)
  }

  async listAvailableModels() {
    const response = await this.requestWithRetries(this.modelsUrl().toString(), "GET")
    const body = await response.json().catch(() => undefined) as { models?: unknown; modelIds?: unknown } | undefined
    const rawModels = Array.isArray(body?.models) ? body.models : Array.isArray(body?.modelIds) ? body.modelIds : []
    return rawModels.flatMap((model) => {
      if (typeof model === "string") return [model]
      if (model && typeof model === "object" && typeof (model as { id?: unknown }).id === "string") return [(model as { id: string }).id]
      if (model && typeof model === "object" && typeof (model as { modelId?: unknown }).modelId === "string") return [(model as { modelId: string }).modelId]
      return []
    })
  }

  async listAvailableModelsRaw(): Promise<Response> {
    return this.requestWithRetries(this.modelsUrl().toString(), "GET")
  }

  /**
   * Fetch the full model list response body for metadata parsing, **following pagination**.
   *
   * `ListAvailableModels` is paginated: the measured live response carries top-level
   * `defaultModel, models, nextToken` with 20 entries on page one. Reading only the first page made
   * every model beyond it invisible to `KiroModelMetadataRegistry` — not merely missing metadata,
   * missing entirely — which is a silent wrong answer about a catalog that changes over time.
   *
   * So this walks the cursor to completion and returns **one merged body** in the same shape
   * `populate()` already accepts: page one's fields, with every later page's `models` (and
   * `modelIds`, for the older response shape) appended in arrival order and `nextToken` dropped,
   * since a merged body has no meaningful cursor. `defaultModel` stays page one's.
   *
   * Three safety rails, because a cursor is a loop condition supplied by someone else:
   *
   * - {@link LIST_AVAILABLE_MODELS_MAX_PAGES} caps the walk, so a server that always returns a token
   *   cannot spin forever.
   * - A token identical to the one just sent is treated as no progress and ends the walk.
   * - A page that fails to parse, or that is not an object, ends the walk and keeps what was already
   *   collected. Failure degrades to fewer models, never to an exception — a first-page failure
   *   still returns `undefined` exactly as before.
   *
   * The walk reports itself through {@link KiroModelPagination} on the merged body's
   * `modelPagination` key: an unknown extra key is ignored by `populate()`, and it is what lets a
   * cap-reached walk be observed rather than inferred.
   */
  async listAvailableModelsFull(): Promise<unknown> {
    const firstPage = await this.fetchModelsPage(undefined)
    if (!isRecord(firstPage)) return firstPage

    const merged: Record<string, unknown> = { ...firstPage }
    const models = arrayField(firstPage, "models")
    const modelIds = arrayField(firstPage, "modelIds")
    let token = stringField(firstPage, "nextToken")
    let pages = 1
    let capReached = false

    while (token !== undefined) {
      if (pages >= LIST_AVAILABLE_MODELS_MAX_PAGES) {
        capReached = true
        break
      }
      // A later page that errors must not lose the pages already collected: page one is the
      // behaviour that existed before pagination, and a failure past it degrades to that rather
      // than to a thrown call.
      let page: unknown
      try {
        page = await this.fetchModelsPage(token)
      } catch {
        break
      }
      if (!isRecord(page)) break
      pages += 1
      models.push(...arrayField(page, "models"))
      modelIds.push(...arrayField(page, "modelIds"))
      const next = stringField(page, "nextToken")
      // Same cursor twice is not progress; treat it as the end rather than as another page.
      if (next === undefined || next === token) break
      token = next
    }

    if (models.length) merged.models = models
    if (modelIds.length) merged.modelIds = modelIds
    delete merged.nextToken
    merged.modelPagination = { pages, capReached, maxPages: LIST_AVAILABLE_MODELS_MAX_PAGES } satisfies KiroModelPagination
    return merged
  }

  /** One page of the model catalog, or `undefined` when the body is unusable. */
  private async fetchModelsPage(nextToken: string | undefined): Promise<unknown> {
    const url = this.modelsUrl()
    if (nextToken !== undefined) url.searchParams.set("nextToken", nextToken)
    const response = await this.requestWithRetries(url.toString(), "GET")
    return response.json().catch(() => undefined)
  }

  async checkHealth(timeoutMs: number): Promise<HealthStatus> {
    const started = Date.now()
    try {
      const response = await this.requestOnce(this.modelsUrl().toString(), "GET", undefined, { timeoutMs })
      return {
        ok: response.ok,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        status: response.status,
        ...(!response.ok ? { error: healthError(response.status) } : {}),
      }
    } catch (error) {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async getUsageLimits(): Promise<Response> {
    const url = this.usageLimitsUrl()
    return this.requestOnce(url.toString(), "GET", undefined, { timeoutMs: 10_000 })
  }

  async callMcpWebSearch(query: string, options: { signal?: AbortSignal; toolUseId?: string } = {}) {
    const toolUseId = options.toolUseId ?? `srvtoolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`
    const requestId = `web_search_tooluse_${randomId(22)}_${Date.now()}_${randomId(8)}`

    const body = await this.requestMcpOnce(requestId, "tools/call", { name: "web_search", arguments: { query } }, options)
    const results = parseMcpWebSearchResults(body)
    return {
      toolUseId,
      results,
      summary: webSearchSummary(query, results),
    }
  }

  private async requestWithRetries(url: string, method: string, body?: string, options: RequestSignalOptions = {}): Promise<Response> {
    let lastError: KiroHttpError | undefined
    const maxAttempts = MAX_RETRIES + 1

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await this.requestOnce(url, method, body, options, attempt)
      if (response.ok) return response

      if (response.status === 403 && attempt === 1) {
        await this.auth.refresh()
        lastError = await this.toHttpError(response)
        continue
      }

      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt >= maxAttempts) throw await this.toHttpError(response)

      lastError = await this.toHttpError(response)
      await this.sleepFn(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1))
    }

    throw lastError ?? new KiroNetworkError("Kiro request failed without a response")
  }

  private async requestOnce(url: string, method: string, body?: string, options: RequestSignalOptions = {}, attempt = 1) {
    const accessToken = await this.auth.getAccessToken()
    const requestSignal = createRequestSignal(options)
    try {
      return await this.fetchFn(url, {
        method,
        headers: this.headers(accessToken, method, attempt),
        body,
        signal: requestSignal.signal,
      })
    } catch (error) {
      if (isAbortError(error) && (options.signal?.aborted || options.timeoutMs !== undefined && !options.stream)) throw error
      throw new KiroNetworkError(error)
    } finally {
      requestSignal.cleanup()
    }
  }

  /**
   * One JSON-RPC round trip to Kiro's `/mcp`, with the protocol layer delegated
   * to the provider-agnostic {@link McpClient} (Requirements 20.2, 28.1): the
   * envelope, the headers, the `401/403 → refresh → retry once` branch, the
   * 60s timeout, and abort propagation all live in core now.
   *
   * Three pieces of Kiro-specific knowledge stay on this side of the boundary:
   *
   * - **The credential.** Authorization is supplied at construction rather than
   *   per call, because {@link McpClient} resolves a per-call credential ahead of
   *   the one `onUnauthorized` refreshes — a per-call `auth` would make the retry
   *   reuse the rejected token. Fetching the token here and refreshing inside the
   *   hook matches the previous per-attempt `getAccessToken()` exactly.
   * - **The request id.** Kiro's id format is `web_search_tooluse_…`, pinned
   *   through `options.requestId` instead of core's generic `mcp_<uuid>`.
   * - **The error surface.** Core throws `McpProtocolError`; every caller of this
   *   class — and `src/upstream/kiro/errors.ts` — expects the Kiro errors, so the
   *   thrown type is mapped back at this boundary and never leaks outward.
   *
   * Returns the whole JSON-RPC body, unread: `parseMcpWebSearchResults()` owns the
   * `result` shape and reads `error` itself.
   */
  private async requestMcpOnce(requestId: string, method: string, params: unknown, options: { signal?: AbortSignal } = {}): Promise<McpJsonRpcResponse> {
    // `McpProtocolError` flattens a non-ok response into a message, but
    // `KiroHttpError` carries the status, the headers, and the untruncated body.
    // Keeping a clone of each response is what lets the mapping below rebuild the
    // full Kiro error rather than a lossy imitation of it.
    let lastResponse: Response | undefined
    const observingFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await this.fetchFn(input, init)
      lastResponse = response.clone()
      return response
    }) as typeof fetch

    const client = new McpClient(
      this.url("/mcp"),
      {
        authorization: await this.auth.getAccessToken(),
        // `content-type: application/json` comes from the core client; the opt-out
        // header is Kiro's, and `/mcp` wants it `false` where the other paths want `true`.
        headers: { "x-amzn-codewhisperer-optout": "false" },
      },
      {
        fetch: observingFetch,
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: 60_000,
        requestId: () => requestId,
        onUnauthorized: async () => {
          try {
            await this.auth.refresh()
          } catch (error) {
            throw new KiroNetworkError(error)
          }
          return this.auth.getAccessToken()
        },
      },
    )

    try {
      return await client.requestRaw(method, params)
    } catch (error) {
      throw await this.toKiroMcpError(error, lastResponse)
    }
  }

  /** Translate a core MCP failure into the Kiro error its callers already handle. */
  private async toKiroMcpError(error: unknown, response: Response | undefined): Promise<unknown> {
    if (!isMcpProtocolError(error)) return error

    if (error.category === "http" || error.category === "unauthorized") {
      // Prefer the captured response: same status, plus the headers and body.
      if (response && response.status === error.status) return await this.toHttpError(response)
      return new KiroHttpError(error.status ?? 502, new Headers(), error.message)
    }

    if (error.category === "transport") return new KiroNetworkError(error.cause ?? error)

    // A reply that is not a JSON-RPC object at all. Kiro's MCP failure surface.
    return new KiroMcpError(error.message)
  }

  private headers(accessToken: string, method: string, attempt = 1) {
    const headers = new Headers()
    headers.set("Authorization", `Bearer ${accessToken}`)
    headers.set("Content-Type", "application/json")
    headers.set("x-amzn-codewhisperer-optout", "true")
    headers.set("User-Agent", renderTemplate(USER_AGENT_TEMPLATE, this.fingerprint, this.kiroVersion))
    headers.set("x-amz-user-agent", renderTemplate(X_AMZ_USER_AGENT_TEMPLATE, this.fingerprint, this.kiroVersion))
    headers.set("x-amzn-kiro-agent-mode", "vibe")
    headers.set("amz-sdk-invocation-id", crypto.randomUUID())
    headers.set("amz-sdk-request", `attempt=${attempt}; max=${MAX_RETRIES}`)
    return headers
  }

  private url(path: string) {
    return `${KIRO_API_HOST_TEMPLATE.replace("{region}", this.apiRegion)}${path}`
  }

  private modelsUrl() {
    const url = new URL(this.url(LIST_AVAILABLE_MODELS_PATH))
    url.searchParams.set("origin", "AI_EDITOR")
    if (this.auth.getAuthType() === "kiro_desktop" && this.auth.getProfileArn()) url.searchParams.set("profileArn", this.auth.getProfileArn()!)
    return url
  }

  private usageLimitsUrl() {
    const url = new URL(this.url(GET_USAGE_LIMITS_PATH))
    if (this.auth.getAuthType() === "kiro_desktop" && this.auth.getProfileArn()) url.searchParams.set("profileArn", this.auth.getProfileArn()!)
    return url
  }

  private async toHttpError(response: Response) {
    return new KiroHttpError(response.status, responseHeaders(response.headers), await response.text())
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** A copy of `body[key]` when it is an array, otherwise a fresh empty array to append into. */
function arrayField(body: Record<string, unknown>, key: string): unknown[] {
  const value = body[key]
  return Array.isArray(value) ? [...value] : []
}

/** A non-empty string field, or `undefined` — an empty cursor is not a cursor. */
function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === "string" && value.length ? value : undefined
}

function randomId(length: number) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const values = new Uint32Array(length)
  crypto.getRandomValues(values)
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("")
}

interface RequestSignalOptions {
  signal?: AbortSignal
  stream?: boolean
  timeoutMs?: number
}

function createRequestSignal(options: RequestSignalOptions) {
  const timeoutMs = options.timeoutMs ?? (options.stream ? STREAMING_READ_TIMEOUT_MS : undefined)
  if (timeoutMs === undefined) return { signal: options.signal, cleanup: () => {} }

  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) {
    abortFromCaller()
  } else {
    options.signal?.addEventListener("abort", abortFromCaller, { once: true })
  }

  const timeout = setTimeout(() => controller.abort(new DOMException("Signal timed out", "AbortError")), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
    },
  }
}

function renderTemplate(template: string, fingerprint: string, kiroVersion: string) {
  return template
    .replaceAll("{platform}", process.platform)
    .replaceAll("{version}", process.version)
    .replaceAll("{nodeVersion}", process.version.replace(/^v/, ""))
    .replaceAll("{kiroVersion}", kiroVersion)
    .replaceAll("{fingerprint}", fingerprint)
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError" || error instanceof Error && error.name === "AbortError"
}

function healthError(status: number) {
  if (status === 401 || status === 403) return `Kiro auth rejected health check with ${status}`
  if (status === 429) return "Kiro rate limited the health check"
  if (status >= 400 && status < 500) return `Kiro client error during health check: ${status}`
  if (status >= 500) return `Kiro server error during health check: ${status}`
  return `Kiro health check returned ${status}`
}
