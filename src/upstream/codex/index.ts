import type { Canonical_ErrorResponse, Canonical_PassthroughResponse, Canonical_Request, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import { responseHeaders } from "../../core/http"
import type { TokenCredentialProvider, UpstreamResult, Upstream_Provider } from "../../core/interfaces"
import type { RequestOptions } from "../../core/types"
import { readCodexFastModeConfig } from "./fast-mode"
import { CodexStandaloneClient } from "./client"
import type { CodexClientOptions, CodexClientTokens } from "./types"
import { canonicalToCodexBody, canonicalToCodexInputTokensBody, collectCodexResponse, streamCodexResponse } from "./parse"

export class Codex_Upstream_Provider implements Upstream_Provider, TokenCredentialProvider<CodexClientTokens> {
  readonly providerKind = "codex" as const

  private readonly client: CodexStandaloneClient
  private readonly authFile?: string

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
    const response = withLoggedResponseBody(await this.client.proxy(body, options), options?.onResponseBodyChunk)
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
export type {
  Canonical_ErrorResponse,
  Canonical_PassthroughResponse,
  Canonical_Request,
  Canonical_Response,
  Canonical_StreamResponse,
}

function withLoggedResponseBody(response: Response, onChunk?: (chunk: string) => void): Response {
  if (!onChunk || !response.body) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read()
      if (chunk.done) {
        const tail = decoder.decode()
        if (tail) onChunk(tail)
        controller.close()
        return
      }
      onChunk(decoder.decode(chunk.value, { stream: true }))
      controller.enqueue(chunk.value)
    },
    async cancel(reason) {
      const tail = decoder.decode()
      if (tail) onChunk(tail)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
