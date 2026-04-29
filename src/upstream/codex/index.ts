import type { Canonical_ErrorResponse, Canonical_PassthroughResponse, Canonical_Request, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import { responseHeaders } from "../../core/http"
import type { TokenCredentialProvider, UpstreamResult, Upstream_Provider } from "../../core/interfaces"
import { withChunkCallback } from "../../core/stream-utils"
import type { RequestOptions } from "../../core/types"
import { readCodexFastModeConfig } from "./fast-mode"
import { CODEX_MODEL_CACHE_TTL_SECONDS } from "./constants"
import { CodexStandaloneClient } from "./client"
import { CodexModelMetadataRegistry } from "./model-metadata"
import type { CodexClientOptions, CodexClientTokens } from "./types"
import { canonicalToCodexBody, canonicalToCodexInputTokensBody, collectCodexResponse, streamCodexResponse } from "./parse"

export class Codex_Upstream_Provider implements Upstream_Provider, TokenCredentialProvider<CodexClientTokens> {
  readonly providerKind = "codex" as const

  private readonly client: CodexStandaloneClient
  private readonly authFile?: string
  private modelCache?: { models: string[]; cachedAt: number }
  readonly modelMetadata = new CodexModelMetadataRegistry()

  constructor(options: CodexClientOptions | { client: CodexStandaloneClient; authFile?: string }) {
    this.client = "client" in options ? options.client : new CodexStandaloneClient(options)
    this.authFile = "authFile" in options ? options.authFile : undefined
  }

  static async fromAuthFile(
    path?: string,
    options?: Omit<CodexClientOptions, "accessToken" | "refreshToken" | "expiresAt" | "accountId" | "authFile">,
  ) {
    return new Codex_Upstream_Provider({
      client: await CodexStandaloneClient.fromAuthFile(path, options),
      authFile: path,
    })
  }

  async proxy(request: Canonical_Request, options?: RequestOptions): Promise<UpstreamResult> {
    const body = await this.applyFastMode(canonicalToCodexBody(request))
    options?.onRequestBody?.(JSON.stringify(body))
    const rawResponse = await this.client.proxy(body, options)
    const response = options?.onResponseBodyChunk ? withChunkCallback(rawResponse, options.onResponseBodyChunk) : rawResponse
    if (!response.ok) return toCanonicalError(response)
    if (request.passthrough) return toCanonicalPassthrough(response)
    if (request.stream) return streamCodexResponse(response, request.model)
    return collectCodexResponse(response, request.model)
  }

  async inputTokens(request: Canonical_Request, options?: RequestOptions) {
    return this.client.inputTokens(canonicalToCodexInputTokensBody(request), options)
  }

  async checkHealth(timeoutMs: number) {
    return this.client.checkHealth(timeoutMs)
  }

  async usage(options?: RequestOptions) {
    return this.client.usage(options)
  }

  async environments(options?: RequestOptions) {
    return this.client.environments(options)
  }

  async modelsRaw(options?: RequestOptions) {
    return this.client.modelsRaw(options)
  }

  /**
   * List available model slugs from the Codex /backend-api/models API.
   * Results are cached for CODEX_MODEL_CACHE_TTL_SECONDS.
   * Also populates the modelMetadata registry.
   */
  async listModels(): Promise<string[]> {
    if (this.modelCache && Date.now() - this.modelCache.cachedAt < CODEX_MODEL_CACHE_TTL_SECONDS * 1000) return this.modelCache.models
    try {
      const response = await this.client.modelsRaw()
      if (!response.ok) return this.modelCache?.models ?? []
      const body = await response.json().catch(() => undefined)
      this.modelMetadata.populate(body)
      const models = this.modelMetadata.modelSlugs()
      this.modelCache = { models, cachedAt: Date.now() }
      return models
    } catch {
      return this.modelCache?.models ?? []
    }
  }

  /**
   * Refresh model metadata from the Codex /backend-api/models API.
   * Called at startup and can be called on account switch.
   */
  async refreshModelMetadata(): Promise<void> {
    try {
      const response = await this.client.modelsRaw()
      if (response.ok) {
        const body = await response.json().catch(() => undefined)
        this.modelMetadata.populate(body)
        const models = this.modelMetadata.modelSlugs()
        this.modelCache = { models, cachedAt: Date.now() }
      }
    } catch {
      // Non-fatal — metadata will use defaults
    }
  }

  async refresh() {
    return this.client.refresh()
  }

  get tokens() {
    return this.client.tokens
  }

  private async applyFastMode(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (body.service_tier) return body
    const config = await readCodexFastModeConfig(this.authFile)
    if (!config.enabled) return body
    return { ...body, service_tier: "priority" }
  }
}

async function toCanonicalError(response: Response): Promise<Canonical_ErrorResponse> {
  return {
    type: "canonical_error",
    status: response.status,
    headers: responseHeaders(response.headers),
    body: await response.text(),
  }
}

function toCanonicalPassthrough(response: Response): Canonical_PassthroughResponse {
  return {
    type: "canonical_passthrough",
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers),
    body: response.body,
  }
}

export type { CodexClientOptions, CodexClientTokens }
export { CodexStandaloneClient }
export { CodexModelMetadataRegistry } from "./model-metadata"
export type { CodexModelMetadata, CodexThinkingEffort } from "./model-metadata"
export type {
  Canonical_ErrorResponse,
  Canonical_PassthroughResponse,
  Canonical_Request,
  Canonical_Response,
  Canonical_StreamResponse,
}

