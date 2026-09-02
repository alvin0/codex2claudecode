import type { Canonical_ErrorResponse, Canonical_Request } from "../../core/canonical"
import { responseHeaders } from "../../core/http"
import type { HealthStatus, JsonObject, RequestOptions } from "../../core/types"
import type { TokenCredentialProvider, UpstreamResult, Upstream_Provider } from "../../core/interfaces"
import { bunPath as path } from "../../core/paths"
import { expandHome } from "../../core/paths"
import { COPILOT_CACHE_FILE_NAME, COPILOT_MODEL_CACHE_TTL_SECONDS } from "./constants"
import { Copilot_Client } from "./client"
import { withCopilotFeatureNotices } from "./feature-notices"
import { resolveCopilotFeatures } from "./features"
import { collectCopilotResponse, streamCopilotResponse } from "./parse"
import { Copilot_Auth_Manager, type CopilotAuthManagerOptions } from "./auth"
import { readCopilotModelCache, writeCopilotModelCache } from "./cache"

export class Copilot_Upstream_Provider implements Upstream_Provider, TokenCredentialProvider<{ copilotToken: string }> {
  readonly providerKind = "copilot" as const

  private readonly auth: Copilot_Auth_Manager
  private readonly client: Copilot_Client
  private readonly authFilePath?: string
  private readonly strict: boolean
  private modelCache?: { models: string[]; cachedAt: number }

  /**
   * `strict` governs what the Gateway does with a client-supplied field, so it sits beside the
   * auth and client wiring rather than inside either. Optional and defaulting to off; the flag
   * reader that supplies it is app-level (design decision D3 — nothing under `src/upstream/`
   * reads the environment).
   */
  constructor(options: { auth: Copilot_Auth_Manager; client?: Copilot_Client; authFilePath?: string; strict?: boolean }) {
    this.auth = options.auth
    this.client = options.client ?? new Copilot_Client({ auth: this.auth })
    this.authFilePath = options.authFilePath
    this.strict = options.strict ?? false
  }

  /**
   * `strict` rides on the same options bag as the auth settings so the app-level composition
   * root can hand it over in one call, and is forwarded to the constructor rather than to the
   * auth manager, which reads only the fields it knows. Omitting it keeps the pre-flag behavior
   * (design decision D3).
   */
  static async fromAuthFile(path?: string, options?: CopilotAuthManagerOptions & { strict?: boolean }) {
    const auth = await Copilot_Auth_Manager.fromAuthFile(path, options)
    return new Copilot_Upstream_Provider({
      auth,
      client: new Copilot_Client({ auth, fetch: options?.fetch }),
      authFilePath: path,
      strict: options?.strict,
    })
  }

  /**
   * Proxy one request, with every matrix-covered field it carries resolved to a declared
   * outcome first.
   *
   * The resolution happens **before** the upstream call, so a failed resolution never spends a
   * request. Notices then travel with the result, and `withCopilotFeatureNotices()` picks the
   * channel from the result's shape.
   *
   * On today's matrix (`./capabilities.ts`) every feature `resolveCopilotFeatures()` looks at is
   * either native or has no canonical field to arrive in yet, so `notices()` is empty and the
   * delivery call returns its input unchanged.
   */
  async proxy(request: Canonical_Request, options?: RequestOptions): Promise<UpstreamResult> {
    const decisions = resolveCopilotFeatures(request, { strict: this.strict })
    const rejection = decisions.firstRejection()
    if (rejection) return canonicalError(400, rejection.message)

    const response = await this.client.proxy(request, options)
    if (!response.ok) return await toCanonicalError(response)
    const collected = await collectCopilotResponse(response, request.model)
    return withCopilotFeatureNotices(request.stream ? streamCopilotResponse(collected) : collected, decisions.notices())
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

/** A failure this provider decided itself, with no upstream response to report. */
function canonicalError(status: number, body: string): Canonical_ErrorResponse {
  return { type: "canonical_error", status, headers: new Headers(), body }
}

function cacheFilePath(authFile: string) {
  return path.join(path.dirname(expandHome(authFile)), COPILOT_CACHE_FILE_NAME)
}
