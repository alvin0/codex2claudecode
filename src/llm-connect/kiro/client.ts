import { KiroAuthManager } from "./auth"
import { buildKiroGenerateAssistantResponsePayload } from "./payload"
import type { KiroClientOptions, KiroGenerateAssistantResponseOptions, KiroRequestHeaderOptions } from "./types"

export class KiroStandaloneClient {
  private readonly authManager: KiroAuthManager
  private readonly fetchFn: typeof fetch
  private readonly userAgent: string
  private readonly agentMode: string
  private readonly codewhispererOptout: boolean
  private preferredApiHost?: string

  private constructor(authManager: KiroAuthManager, options: KiroClientOptions) {
    this.authManager = authManager
    this.fetchFn = options.fetch ?? fetch
    this.userAgent = options.userAgent ?? "aws-sdk-js/1.0.27 ua/2.1 os/darwin lang/js md/bun api/codewhispererstreaming#1.0.27 m/E KiroIDE-0.7.45-bun"
    this.agentMode = options.agentMode ?? "vibe"
    this.codewhispererOptout = options.codewhispererOptout ?? true
  }

  static async create(options: KiroClientOptions = {}) {
    const authManager = options.authManager instanceof KiroAuthManager ? options.authManager : await KiroAuthManager.fromSources(options)
    return new KiroStandaloneClient(authManager, options)
  }

  get tokens() {
    return this.authManager.tokens
  }

  async refresh() {
    return this.authManager.refresh()
  }

  async listAvailableModels() {
    let lastError: unknown

    for (const apiHost of this.candidateApiHosts()) {
      try {
        const url = new URL(`${apiHost}/ListAvailableModels`)
        url.searchParams.set("origin", "AI_EDITOR")
        if (this.authManager.authType === "kiro_desktop" && this.authManager.profileArn) {
          url.searchParams.set("profileArn", this.authManager.profileArn)
        }
        const response = await this.requestWithRetry(url, { method: "GET" })
        if (response.ok) {
          this.preferredApiHost = apiHost
          return response.json() as Promise<Record<string, unknown>>
        }
        if (!shouldTryNextApiHost(response.status)) {
          throw new Error(`Kiro model list failed: ${response.status} ${await response.text()}`)
        }
        lastError = new Error(`Kiro model list failed: ${response.status} ${await response.text()}`)
      } catch (error) {
        lastError = error
        if (!isRetryableApiHostError(error)) throw error
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Kiro model list failed for all candidate API regions")
  }

  async getUsageLimits(resourceType = "AGENTIC_REQUEST") {
    let lastError: unknown

    for (const apiHost of this.candidateApiHosts()) {
      try {
        const url = new URL(`${apiHost}/getUsageLimits`)
        url.searchParams.set("isEmailRequired", "true")
        url.searchParams.set("origin", "AI_EDITOR")
        if (this.authManager.authType === "kiro_desktop" && this.authManager.profileArn) {
          url.searchParams.set("profileArn", this.authManager.profileArn)
        }
        url.searchParams.set("resourceType", resourceType)
        const response = await this.requestWithRetry(url, { method: "GET" })
        if (response.ok) {
          this.preferredApiHost = apiHost
          return response.json() as Promise<Record<string, unknown>>
        }
        if (!shouldTryNextApiHost(response.status)) {
          throw new Error(`Kiro getUsageLimits failed: ${response.status} ${await response.text()}`)
        }
        lastError = new Error(`Kiro getUsageLimits failed: ${response.status} ${await response.text()}`)
      } catch (error) {
        lastError = error
        if (!isRetryableApiHostError(error)) throw error
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Kiro getUsageLimits failed for all candidate API regions")
  }

  async mcpCall(method: string, params: Record<string, unknown>) {
    const token = await this.authManager.getAccessToken()
    const requestId = `mcp_${crypto.randomUUID().replace(/-/g, "")}`
    const body = {
      id: requestId,
      jsonrpc: "2.0",
      method,
      params,
    }

    for (const apiHost of this.candidateApiHosts()) {
      try {
        const response = await this.fetchFn(`${apiHost}/mcp`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "x-amzn-codewhisperer-optout": "false",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        })
        if (response.ok) {
          this.preferredApiHost = apiHost
          return response.json() as Promise<Record<string, unknown>>
        }
        if (!shouldTryNextApiHost(response.status)) return undefined
      } catch {
        continue
      }
    }
    return undefined
  }

  async generateAssistantResponse(options: KiroGenerateAssistantResponseOptions) {
    const payload = buildKiroGenerateAssistantResponsePayload({
      content: options.content,
      currentMessage: options.currentMessage,
      modelId: options.modelId,
      history: options.history,
      conversationId: options.conversationId,
      profileArn: this.authManager.authType === "kiro_desktop" ? this.authManager.profileArn : undefined,
    })

    let lastError: unknown
    for (const apiHost of this.candidateApiHosts()) {
      try {
        const response = await this.requestWithRetry(`${apiHost}/generateAssistantResponse`, {
          method: "POST",
          body: JSON.stringify(options.stream ? { ...payload, stream: true } : payload),
        })
        if (response.ok) {
          this.preferredApiHost = apiHost
          return response
        }
        if (!shouldTryNextApiHost(response.status)) {
          throw new Error(`Kiro generateAssistantResponse failed: ${response.status} ${await response.text()}`)
        }
        lastError = new Error(`Kiro generateAssistantResponse failed: ${response.status} ${await response.text()}`)
      } catch (error) {
        lastError = error
        if (!isRetryableApiHostError(error)) throw error
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Kiro generateAssistantResponse failed for all candidate API regions")
  }

  private async requestWithRetry(url: string | URL, init: RequestInit) {
    let response = await this.fetchFn(url, {
      ...init,
      headers: await this.headers(init.headers),
    })
    if (response.status !== 401 && response.status !== 403) return response
    await this.authManager.forceRefresh()
    response = await this.fetchFn(url, {
      ...init,
      headers: await this.headers(init.headers),
    })
    return response
  }

  private async headers(input?: HeadersInit, options: KiroRequestHeaderOptions = {}) {
    const token = await this.authManager.getAccessToken()
    const headers = new Headers(input)
    headers.delete("accept-encoding")
    headers.delete("connection")
    headers.delete("content-length")
    headers.delete("host")
    headers.delete("keep-alive")
    headers.delete("transfer-encoding")
    headers.set("Authorization", `Bearer ${token}`)
    headers.set("Content-Type", "application/json")
    headers.set("User-Agent", this.userAgent)
    headers.set("x-amz-user-agent", this.userAgent)
    headers.set("x-amzn-codewhisperer-optout", String(options.codewhispererOptout ?? this.codewhispererOptout))
    headers.set("x-amzn-kiro-agent-mode", options.agentMode ?? this.agentMode)
    headers.set("amz-sdk-invocation-id", crypto.randomUUID())
    headers.set("amz-sdk-request", "attempt=1; max=3")
    return headers
  }

  private candidateApiHosts() {
    return [this.preferredApiHost, ...this.authManager.candidateApiHosts].filter(
      (value, index, array): value is string => Boolean(value) && array.indexOf(value) === index,
    )
  }
}

function isRetryableApiHostError(error: unknown) {
  if (!(error instanceof Error)) return false
  return /Unable to connect|ConnectionRefused|ECONNREFUSED|fetch failed|network/i.test(error.message)
}

function shouldTryNextApiHost(status: number) {
  return status === 502 || status === 503 || status === 504
}
