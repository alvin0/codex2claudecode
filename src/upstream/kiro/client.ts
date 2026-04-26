import type { HealthStatus } from "../../core/types"
import { responseHeaders } from "../../core/http"
import { BASE_RETRY_DELAY_MS, DEFAULT_KIRO_API_REGION, GENERATE_ASSISTANT_RESPONSE_PATH, GET_USAGE_LIMITS_PATH, KIRO_API_HOST_TEMPLATE, LIST_AVAILABLE_MODELS_PATH, MAX_RETRIES, STREAMING_READ_TIMEOUT_MS, USER_AGENT_TEMPLATE, X_AMZ_USER_AGENT_TEMPLATE } from "./constants"
import type { Kiro_Auth_Manager } from "./auth"
import { parseMcpWebSearchResults, webSearchSummary } from "./mcp"
import { KiroHttpError, KiroNetworkError, type KiroGeneratePayload } from "./types"

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

  async checkHealth(timeoutMs: number): Promise<HealthStatus> {
    const started = Date.now()
    try {
      const response = await this.requestOnce(this.modelsUrl().toString(), "GET", undefined, { signal: AbortSignal.timeout(timeoutMs) })
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
    return this.requestOnce(url.toString(), "GET", undefined, { signal: AbortSignal.timeout(10_000) })
  }

  async callMcpWebSearch(query: string, options: { signal?: AbortSignal; toolUseId?: string } = {}) {
    const toolUseId = options.toolUseId ?? `srvtoolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`
    const requestId = `web_search_tooluse_${randomId(22)}_${Date.now()}_${randomId(8)}`
    const body = JSON.stringify({
      id: requestId,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "web_search",
        arguments: { query },
      },
    })

    const response = await this.requestMcpOnce(this.url("/mcp"), body, options)
    if (!response.ok) throw await this.toHttpError(response)

    const results = parseMcpWebSearchResults(await response.json())
    return {
      toolUseId,
      results,
      summary: webSearchSummary(query, results),
    }
  }

  private async requestWithRetries(url: string, method: string, body?: string, options: { signal?: AbortSignal; stream?: boolean } = {}): Promise<Response> {
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

  private async requestOnce(url: string, method: string, body?: string, options: { signal?: AbortSignal; stream?: boolean } = {}, attempt = 1) {
    const accessToken = await this.auth.getAccessToken()
    try {
      return await this.fetchFn(url, {
        method,
        headers: this.headers(accessToken, method),
        body,
        signal: requestSignal(options),
      })
    } catch (error) {
      if (isAbortError(error) && options.signal?.aborted) throw error
      throw new KiroNetworkError(error instanceof Error ? error.message : String(error))
    }
  }

  private async requestMcpOnce(url: string, body: string, options: { signal?: AbortSignal } = {}) {
    const request = async () => {
      const accessToken = await this.auth.getAccessToken()
      return this.fetchFn(url, {
        method: "POST",
        headers: this.mcpHeaders(accessToken),
        body,
        signal: mcpSignal(options.signal),
      })
    }

    try {
      let response = await request()
      if (response.status !== 403) return response
      await this.auth.refresh()
      response = await request()
      return response
    } catch (error) {
      if (isAbortError(error) && options.signal?.aborted) throw error
      throw new KiroNetworkError(error instanceof Error ? error.message : String(error))
    }
  }

  private headers(accessToken: string, method: string) {
    const headers = new Headers()
    headers.set("Authorization", `Bearer ${accessToken}`)
    headers.set("Content-Type", "application/json")
    headers.set("x-amzn-codewhisperer-optout", "true")
    headers.set("User-Agent", renderTemplate(USER_AGENT_TEMPLATE, this.fingerprint, this.kiroVersion))
    headers.set("x-amz-user-agent", renderTemplate(X_AMZ_USER_AGENT_TEMPLATE, this.fingerprint, this.kiroVersion))
    headers.set("x-amzn-kiro-agent-mode", "vibe")
    headers.set("amz-sdk-invocation-id", crypto.randomUUID())
    headers.set("amz-sdk-request", `attempt=1; max=${MAX_RETRIES}`)
    return headers
  }

  private mcpHeaders(accessToken: string) {
    const headers = new Headers()
    headers.set("Authorization", `Bearer ${accessToken}`)
    headers.set("Content-Type", "application/json")
    headers.set("x-amzn-codewhisperer-optout", "false")
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

function randomId(length: number) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const values = new Uint32Array(length)
  crypto.getRandomValues(values)
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("")
}

function mcpSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(60_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function requestSignal(options: { signal?: AbortSignal; stream?: boolean }) {
  if (!options.stream) return options.signal
  const timeout = AbortSignal.timeout(STREAMING_READ_TIMEOUT_MS)
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
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
