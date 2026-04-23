import type { Canonical_ErrorResponse, Canonical_PassthroughResponse, Canonical_Request, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import { responseHeaders } from "../../core/http"
import type { TokenCredentialProvider, UpstreamResult, Upstream_Provider } from "../../core/interfaces"
import type { RequestOptions } from "../../core/types"
import { CodexStandaloneClient } from "./client"
import type { CodexClientOptions, CodexClientTokens } from "./types"
import { canonicalToCodexBody, collectCodexResponse, streamCodexResponse } from "./parse"

export class Codex_Upstream_Provider implements Upstream_Provider, TokenCredentialProvider<CodexClientTokens> {
  private readonly client: CodexStandaloneClient

  constructor(options: CodexClientOptions | { client: CodexStandaloneClient }) {
    this.client = "client" in options ? options.client : new CodexStandaloneClient(options)
  }

  static async fromAuthFile(
    path?: string,
    options?: Omit<CodexClientOptions, "accessToken" | "refreshToken" | "expiresAt" | "accountId" | "authFile">,
  ) {
    return new Codex_Upstream_Provider({
      client: await CodexStandaloneClient.fromAuthFile(path, options),
    })
  }

  async proxy(request: Canonical_Request, options?: RequestOptions): Promise<UpstreamResult> {
    const response = await this.client.proxy(canonicalToCodexBody(request), options)
    if (!response.ok) return toCanonicalError(response)
    if (request.passthrough) return toCanonicalPassthrough(response)
    if (request.stream) return streamCodexResponse(response, request.model)
    return collectCodexResponse(response, request.model)
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
