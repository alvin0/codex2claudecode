import { writeFile } from "node:fs/promises"

import { writeAccountInfoFile } from "./account-info"
import { extractAccountId, readAuthFileData, selectAuthEntry } from "./auth"
import { syncCodexCliAuthTokens } from "./codex-auth"
import { DEFAULT_CLIENT_ID, DEFAULT_CODEX_ENDPOINT, DEFAULT_ISSUER, REFRESH_SAFETY_MARGIN_MS, WHAM_ENVIRONMENTS_ENDPOINT, WHAM_USAGE_ENDPOINT } from "./constants"
import { ensureParentDir, resolveAuthFile } from "./paths"
import { normalizeReasoningBody } from "./reasoning"
import type { AuthFileContent, AuthFileData, ChatCompletionRequest, CodexClientOptions, CodexClientTokens, HealthStatus, JsonObject, RequestOptions, ResponsesRequest, TokenResponse } from "./types"

export class CodexStandaloneClient {
  private accessToken: string
  private refreshToken: string
  private expiresAt?: number
  private accountId?: string
  private refreshPromise?: Promise<TokenResponse>

  private readonly clientId: string
  private readonly issuer: string
  private readonly codexEndpoint: string
  private readonly originator: string
  private readonly userAgent: string
  private readonly fetchFn: typeof fetch
  private readonly authFile?: string
  private readonly codexAuthFile?: string
  private authEntryIndex?: number
  private authFileIsArray?: boolean

  constructor(options: CodexClientOptions) {
    this.accessToken = options.accessToken
    this.refreshToken = options.refreshToken
    this.expiresAt = options.expiresAt
    this.accountId = options.accountId
    this.clientId = options.clientId ?? DEFAULT_CLIENT_ID
    this.issuer = options.issuer ?? DEFAULT_ISSUER
    this.codexEndpoint = options.codexEndpoint ?? DEFAULT_CODEX_ENDPOINT
    this.originator = options.originator ?? "opencode"
    this.userAgent = options.userAgent ?? "codex-standalone-client"
    this.fetchFn = options.fetch ?? fetch
    this.authFile = options.authFile
    this.codexAuthFile = options.codexAuthFile
  }

  static async fromAuthFile(
    path = resolveAuthFile(),
    options?: Omit<CodexClientOptions, "accessToken" | "refreshToken" | "expiresAt" | "accountId" | "authFile">,
  ) {
    const authFile = resolveAuthFile(path)
    const file = await readAuthFileData(authFile)
    const selected = selectAuthEntry(file.data, options?.authAccount ?? process.env.CODEX_AUTH_ACCOUNT, authFile)
    const client = new CodexStandaloneClient({
      ...options,
      accessToken: selected.auth.access,
      refreshToken: selected.auth.refresh,
      expiresAt: selected.auth.expires,
      accountId: selected.auth.accountId,
      authFile,
    })
    client.authEntryIndex = selected.index
    client.authFileIsArray = selected.isArray
    return client
  }

  get tokens(): CodexClientTokens {
    return {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
      accountId: this.accountId,
    }
  }

  async refresh() {
    const tokens = await this.refreshAccessToken()
    this.applyTokenResponse(tokens)
    await this.saveAuthFile()
    await syncCodexCliAuthTokens({
      accountId: this.accountId,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      path: this.codexAuthFile,
    }).catch(() => false)
    return this.tokens
  }

  async responses<ResponseBody = unknown>(body: ResponsesRequest, options?: RequestOptions) {
    return this.requestJson<ResponseBody>(body, options)
  }

  async chatCompletions<ResponseBody = unknown>(body: ChatCompletionRequest, options?: RequestOptions) {
    return this.requestJson<ResponseBody>(body, options)
  }

  async responsesStream(body: ResponsesRequest, options?: RequestOptions) {
    return this.requestStream({ ...body, stream: true }, options)
  }

  async chatCompletionsStream(body: ChatCompletionRequest, options?: RequestOptions) {
    return this.requestStream({ ...body, stream: true }, options)
  }

  async proxy(body: JsonObject, options?: RequestOptions) {
    return this.request(body, options)
  }

  async usage(options?: RequestOptions) {
    return this.requestUpstream(WHAM_USAGE_ENDPOINT, "GET", options)
  }

  async environments(options?: RequestOptions) {
    return this.requestUpstream(WHAM_ENVIRONMENTS_ENDPOINT, "GET", options)
  }

  async checkHealth(timeoutMs = 5000): Promise<HealthStatus> {
    const started = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      await this.refreshIfExpired()
      const response = await this.fetchFn(this.codexEndpoint, {
        method: "HEAD",
        headers: this.headers(),
        signal: controller.signal,
      })

      return {
        ok: response.status < 500 && response.status !== 401 && response.status !== 403,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        status: response.status,
        ...(response.status === 401 || response.status === 403
          ? { error: `Codex auth rejected health check with ${response.status}` }
          : {}),
      }
    } catch (error) {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async requestJson<ResponseBody>(body: JsonObject, options?: RequestOptions) {
    const response = await this.request(body, options)
    if (!response.ok) throw await this.toError(response)
    return (await response.json()) as ResponseBody
  }

  private async requestStream(body: JsonObject, options?: RequestOptions) {
    const response = await this.request(body, options)
    if (!response.ok) throw await this.toError(response)
    if (!response.body) throw new Error("Response did not include a stream body")
    return response.body
  }

  private async request(body: JsonObject, options?: RequestOptions) {
    return this.requestUpstream(
      this.codexEndpoint,
      "POST",
      options,
      JSON.stringify(normalizeReasoningBody(body)),
    )
  }

  private async requestUpstream(url: string, method: string, options?: RequestOptions, body?: string) {
    await this.refreshIfExpired()

    const response = await this.fetchFn(url, {
      method,
      headers: this.headers(options?.headers),
      body,
      signal: options?.signal,
    })

    if (response.status !== 401) return response

    await this.refresh()

    return this.fetchFn(url, {
      method,
      headers: this.headers(options?.headers),
      body,
      signal: options?.signal,
    })
  }

  private async refreshIfExpired() {
    if (this.expiresAt && this.expiresAt - REFRESH_SAFETY_MARGIN_MS > Date.now()) return
    if (!this.expiresAt) return
    await this.refresh()
  }

  private async refreshAccessToken() {
    if (this.refreshPromise) return this.refreshPromise

    this.refreshPromise = this.fetchFn(`${this.issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
        client_id: this.clientId,
      }).toString(),
    })
      .then(async (response) => {
        if (response.ok) return (await response.json()) as TokenResponse
        throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`)
      })
      .finally(() => {
        this.refreshPromise = undefined
      })

    return this.refreshPromise
  }

  private applyTokenResponse(tokens: TokenResponse) {
    this.accessToken = tokens.access_token
    this.refreshToken = tokens.refresh_token ?? this.refreshToken
    this.expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000
    this.accountId = extractAccountId(tokens) ?? this.accountId
  }

  private async saveAuthFile() {
    if (!this.authFile) return
    if (this.authFileIsArray) {
      const file = await readAuthFileData(this.authFile)
      const entries = Array.isArray(file.data) ? file.data : [file.data]
      entries[this.authEntryIndex ?? 0] = this.authFileContent(entries[this.authEntryIndex ?? 0])
      await ensureParentDir(this.authFile)
      await writeFile(this.authFile, `${JSON.stringify(entries satisfies AuthFileData, null, 2)}\n`)
      await writeAccountInfoFile(this.authFile, entries)
      return
    }
    const auth = this.authFileContent()
    await ensureParentDir(this.authFile)
    await writeFile(this.authFile, `${JSON.stringify(auth, null, 2)}\n`)
    await writeAccountInfoFile(this.authFile, auth)
  }

  private authFileContent(previous?: AuthFileContent): AuthFileContent {
    return {
      ...previous,
      type: "oauth",
      access: this.accessToken,
      refresh: this.refreshToken,
      expires: this.expiresAt,
      accountId: this.accountId,
    }
  }

  private headers(input?: HeadersInit) {
    const headers = new Headers(input)
    headers.delete("accept-encoding")
    headers.delete("connection")
    headers.delete("content-length")
    headers.delete("host")
    headers.delete("keep-alive")
    headers.delete("transfer-encoding")
    headers.set("authorization", `Bearer ${this.accessToken}`)
    headers.set("content-type", "application/json")
    headers.set("originator", this.originator)
    headers.set("user-agent", this.userAgent)
    if (this.accountId) headers.set("ChatGPT-Account-Id", this.accountId)
    return headers
  }

  private async toError(response: Response) {
    return new Error(`Codex request failed: ${response.status} ${await response.text()}`)
  }
}
