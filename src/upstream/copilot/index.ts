import type { Canonical_Request } from "../../core/canonical"
import { responseHeaders } from "../../core/http"
import type { HealthStatus, JsonObject, RequestOptions } from "../../core/types"
import type { TokenCredentialProvider, UpstreamResult, Upstream_Provider } from "../../core/interfaces"
import { bunPath as path } from "../../core/paths"
import { expandHome } from "../../core/paths"
import { COPILOT_CACHE_FILE_NAME, COPILOT_MODEL_CACHE_TTL_SECONDS } from "./constants"
import { Copilot_Client } from "./client"
import { collectCopilotResponse, streamCopilotResponse } from "./parse"
import { Copilot_Auth_Manager, type CopilotAuthManagerOptions } from "./auth"
import { readCopilotModelCache, writeCopilotModelCache } from "./cache"

export class Copilot_Upstream_Provider implements Upstream_Provider, TokenCredentialProvider<{ copilotToken: string }> {
  readonly providerKind = "copilot" as const

  private readonly auth: Copilot_Auth_Manager
  private readonly client: Copilot_Client
  private readonly authFilePath?: string
  private modelCache?: { models: string[]; cachedAt: number }

  constructor(options: { auth: Copilot_Auth_Manager; client?: Copilot_Client; authFilePath?: string }) {
    this.auth = options.auth
    this.client = options.client ?? new Copilot_Client({ auth: this.auth })
    this.authFilePath = options.authFilePath
  }

  static async fromAuthFile(path?: string, options?: CopilotAuthManagerOptions) {
    const auth = await Copilot_Auth_Manager.fromAuthFile(path, options)
    return new Copilot_Upstream_Provider({
      auth,
      client: new Copilot_Client({ auth, fetch: options?.fetch }),
      authFilePath: path,
    })
  }

  async proxy(request: Canonical_Request, options?: RequestOptions): Promise<UpstreamResult> {
    const response = await this.client.proxy(request, options)
    if (!response.ok) return await toCanonicalError(response)
    const collected = await collectCopilotResponse(response, request.model)
    return request.stream ? streamCopilotResponse(collected) : collected
  }

  async checkHealth(timeoutMs: number): Promise<HealthStatus> {
    return this.client.checkHealth(timeoutMs)
  }

  async usage(options?: RequestOptions) {
    return this.client.usage(options)
  }

  async modelsRaw(options?: RequestOptions) {
    return this.client.modelsRaw(options)
  }

  async embeddingsRaw(body: JsonObject, options?: RequestOptions) {
    return this.client.embeddingsRaw(body, options)
  }

  async listModels(): Promise<string[]> {
    if (this.modelCache && Date.now() - this.modelCache.cachedAt < COPILOT_MODEL_CACHE_TTL_SECONDS * 1000) return this.modelCache.models
    const accountKey = this.accountKey()
    if (this.authFilePath) {
      const cached = await readCopilotModelCache(accountKey, cacheFilePath(this.authFilePath))
      if (cached && Date.now() - Date.parse(cached.fetchedAt) < COPILOT_MODEL_CACHE_TTL_SECONDS * 1000) {
        this.modelCache = { models: cached.models, cachedAt: Date.parse(cached.fetchedAt) || Date.now() }
        return cached.models
      }
    }
    try {
      const response = await this.client.modelsRaw()
      if (!response.ok) return this.modelCache?.models ?? []
      const body = await response.json().catch(() => undefined) as { data?: Array<{ id?: unknown; model_picker_enabled?: unknown }> } | undefined
      const models = Array.isArray(body?.data)
        ? body.data.flatMap((item) => typeof item?.id === "string" && item.model_picker_enabled !== false ? [item.id] : [])
        : []
      this.modelCache = { models, cachedAt: Date.now() }
      if (this.authFilePath) {
        await writeCopilotModelCache(accountKey, { models, fetchedAt: new Date().toISOString() }, cacheFilePath(this.authFilePath))
      }
      return models
    } catch {
      return this.modelCache?.models ?? []
    }
  }

  async refresh() {
    await this.auth.refreshAndPersist()
    return { copilotToken: this.auth.getCopilotToken() }
  }

  get tokens() {
    return { copilotToken: this.auth.getCopilotToken() }
  }

  getAuthType() {
    return this.auth.getAuthType()
  }

  getAccountType() {
    return this.auth.getAccountType()
  }

  getEmail() {
    return this.auth.getEmail()
  }

  getPlan() {
    return this.auth.getPlan()
  }

  getAccountId() {
    return this.auth.getAccountId()
  }

  private accountKey() {
    return this.getAccountId() ?? this.getEmail() ?? this.getPlan() ?? this.getAccountType() ?? "copilot-account"
  }
}

async function toCanonicalError(response: Response) {
  return {
    type: "canonical_error" as const,
    status: response.status,
    headers: responseHeaders(response.headers),
    body: await response.text().catch(() => ""),
  }
}

function cacheFilePath(authFile: string) {
  return path.join(path.dirname(expandHome(authFile)), COPILOT_CACHE_FILE_NAME)
}
