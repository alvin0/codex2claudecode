import type { Canonical_ErrorResponse, Canonical_PassthroughResponse, Canonical_Request, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import { responseHeaders } from "../../core/http"
import type { ProviderModelDescriptor, TokenCredentialProvider, UpstreamResult, Upstream_Provider } from "../../core/interfaces"
import { withChunkCallback } from "../../core/stream-utils"
import type { RequestOptions } from "../../core/types"
import { readCodexFastModeConfig } from "./fast-mode"
import { CODEX_MODEL_CACHE_TTL_SECONDS } from "./constants"
import { CodexStandaloneClient } from "./client"
import { withCodexFeatureNotices } from "./feature-notices"
import { resolveCodexFeatures } from "./features"
import { CodexModelMetadataRegistry } from "./model-metadata"
import type { CodexClientOptions, CodexClientTokens } from "./types"
import { canonicalToCodexBody, canonicalToCodexInputTokensBody, collectCodexResponse, streamCodexResponse } from "./parse"

/**
 * How this provider is constructed: either credentials it turns into a client, or a client
 * already built — plus the one feature-resolution setting.
 *
 * `strict` rides on both members rather than living in `CodexClientOptions`, because it governs
 * what the Gateway does with a client-supplied field, not how the HTTP client talks to the
 * upstream. Optional and defaulting to off; the flag reader that supplies it is app-level
 * (design decision D3 — nothing under `src/upstream/` reads the environment).
 */
type CodexProviderOptions = (CodexClientOptions | { client: CodexStandaloneClient; authFile?: string }) & {
  strict?: boolean
}

export class Codex_Upstream_Provider implements Upstream_Provider, TokenCredentialProvider<CodexClientTokens> {
  readonly providerKind = "codex" as const

  private readonly client: CodexStandaloneClient
  private readonly authFile?: string
  private readonly strict: boolean
  private modelCache?: { models: string[]; cachedAt: number }
  readonly modelMetadata = new CodexModelMetadataRegistry()

  constructor(options: CodexProviderOptions) {
    this.client = "client" in options ? options.client : new CodexStandaloneClient(options)
    this.authFile = "authFile" in options ? options.authFile : undefined
    this.strict = options.strict ?? false
  }

  /**
   * `strict` rides on the same options bag as the client settings so the app-level composition
   * root can hand it over in one call, and is forwarded to the constructor rather than to the
   * client: `CodexStandaloneClient` reads only the fields it knows and ignores this one.
   * Omitting it keeps the pre-flag behavior (design decision D3).
   */
  static async fromAuthFile(
    path?: string,
    options?: Omit<CodexClientOptions, "accessToken" | "refreshToken" | "expiresAt" | "accountId" | "authFile"> & { strict?: boolean },
  ) {
    return new Codex_Upstream_Provider({
      client: await CodexStandaloneClient.fromAuthFile(path, options),
      authFile: path,
      strict: options?.strict,
    })
  }

  /**
   * Proxy one request, with every matrix-covered field it carries resolved to a declared
   * outcome first.
   *
   * The resolution happens **before** the upstream call, because a failed resolution must not
   * spend a request: `firstRejection()` returns the 400 on its own. Everything else the
   * declaration produces travels with the result, and `withCodexFeatureNotices()` picks the
   * channel from the result's shape — including leaving a byte-identical passthrough alone.
   *
   * On today's matrix (`./capabilities.ts`) every feature `resolveCodexFeatures()` looks at is
   * either native or has no canonical field to arrive in yet, so `notices()` is empty and the
   * delivery call returns its input unchanged. That is Requirement 10.6 holding structurally: a
   * `temperature` bound for this upstream produces zero notices because the cell that governs it
   * is declared native, not because the cell is skipped.
   */
  async proxy(request: Canonical_Request, options?: RequestOptions): Promise<UpstreamResult> {
    const decisions = resolveCodexFeatures(request, { strict: this.strict })
    const rejection = decisions.firstRejection()
    if (rejection) return canonicalError(400, rejection.message)

    const body = await this.applyFastMode(canonicalToCodexBody(request))
    options?.onRequestBody?.(JSON.stringify(body))
    const rawResponse = await this.client.proxy(body, options)
    const response = options?.onResponseBodyChunk ? withChunkCallback(rawResponse, options.onResponseBodyChunk) : rawResponse
    if (!response.ok) return toCanonicalError(response)
    if (request.passthrough) return toCanonicalPassthrough(response)
    const result = request.stream ? streamCodexResponse(response, request.model) : await collectCodexResponse(response, request.model)
    return withCodexFeatureNotices(result, decisions.notices())
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
   * List available model slugs from the Codex /backend-api/codex/models API.
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

  async listModelDescriptors(): Promise<ProviderModelDescriptor[]> {
    await this.listModels()
    return this.modelMetadata.all().map((metadata) => ({
      id: metadata.slug,
      displayName: metadata.title,
      maxInputTokens: metadata.maxTokens,
      maxOutputTokens: metadata.maxOutputTokens,
      supportsImages: metadata.supportsImages,
      ...(metadata.thinkingEfforts.length > 0 && {
        effort: {
          schemaPath: "reasoning" as const,
          levels: metadata.thinkingEfforts.map((effort) => effort.thinkingEffort),
          ...(metadata.defaultThinkingEffort && { defaultLevel: metadata.defaultThinkingEffort }),
        },
      }),
    }))
  }

  /**
   * Refresh model metadata from the Codex /backend-api/codex/models API.
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

/** A failure this provider decided itself, with no upstream response to report. */
function canonicalError(status: number, body: string): Canonical_ErrorResponse {
  return { type: "canonical_error", status, headers: new Headers(), body }
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
