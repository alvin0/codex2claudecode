import type { Canonical_Request } from "../../core/canonical"
import type { HealthStatus, JsonObject, RequestOptions } from "../../core/types"
import { COPILOT_API_VERSION, COPILOT_EDITOR_PLUGIN_VERSION, COPILOT_GITHUB_API_BASE_URL, COPILOT_GITHUB_VERSION, COPILOT_USER_AGENT } from "./constants"
import { buildCopilotResponsesBody } from "./parse"
import type { Copilot_Auth_Manager } from "./auth"

export interface CopilotClientOptions {
  auth: Copilot_Auth_Manager
  fetch?: typeof fetch
}

export class Copilot_Client {
  private readonly auth: Copilot_Auth_Manager
  private readonly fetchFn: typeof fetch

  constructor(options: CopilotClientOptions) {
    this.auth = options.auth
    this.fetchFn = options.fetch ?? fetch
  }

  async proxy(request: Canonical_Request, options?: RequestOptions): Promise<Response> {
    const accessToken = await this.auth.getAccessToken()
    const body = buildCopilotResponsesBody(request)
    options?.onRequestBody?.(JSON.stringify(body))
    return this.fetchJson("/responses", accessToken, body, options)
  }

  async embeddingsRaw(body: JsonObject, options?: RequestOptions): Promise<Response> {
    options?.onRequestBody?.(JSON.stringify(body))
    const accessToken = await this.auth.getAccessToken()
    return this.fetchJson("/embeddings", accessToken, body, options)
  }

  async modelsRaw(options?: RequestOptions): Promise<Response> {
    const accessToken = await this.auth.getAccessToken()
    return this.fetchJson("/models", accessToken, undefined, options)
  }

  async usage(options?: RequestOptions): Promise<Response> {
    const response = await this.fetchFn(`${COPILOT_GITHUB_API_BASE_URL}/copilot_internal/user`, {
      headers: githubHeaders(await this.auth.getGitHubToken(), this.auth.getAccountType()),
      signal: options?.signal,
    })
    return response
  }

  async checkHealth(timeoutMs: number): Promise<HealthStatus> {
    const controller = new AbortController()
    const started = Date.now()
    const timer = setTimeout(() => controller.abort("health timeout"), timeoutMs)
    try {
      const response = await this.modelsRaw({ signal: controller.signal })
      return {
        ok: response.ok,
        status: response.status,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async refresh() {
    return this.auth.refreshAndPersist()
  }

  private async fetchJson(path: string, accessToken: string, body?: unknown, options?: RequestOptions) {
    const response = await this.fetchFn(`${this.baseUrl()}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: copilotHeaders(accessToken, this.auth.getAccountType(), this.auth.getGitHubToken()),
      signal: options?.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return response
  }

  private baseUrl() {
    const accountType = this.auth.getAccountType()
    return accountType && accountType !== "individual"
      ? `https://api.${accountType}.githubcopilot.com`
      : "https://api.githubcopilot.com"
  }
}

function copilotHeaders(accessToken: string, accountType: string, githubToken: string) {
  return {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
    "copilot-integration-id": "vscode-chat",
    "editor-version": "vscode/1.112.0",
    "editor-plugin-version": COPILOT_EDITOR_PLUGIN_VERSION,
    "user-agent": COPILOT_USER_AGENT,
    "openai-intent": "conversation-panel",
    "x-github-api-version": COPILOT_API_VERSION,
    "x-vscode-user-agent-library-version": "electron-fetch",
    "x-copilot-account-type": accountType,
    "x-copilot-github-token": githubToken,
    "x-copilot-version": COPILOT_GITHUB_VERSION,
    "x-request-id": crypto.randomUUID(),
  }
}

function githubHeaders(githubToken: string, accountType: string) {
  return {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `token ${githubToken}`,
    "editor-version": "vscode/1.112.0",
    "editor-plugin-version": COPILOT_EDITOR_PLUGIN_VERSION,
    "user-agent": COPILOT_USER_AGENT,
    "x-github-api-version": COPILOT_API_VERSION,
    "x-vscode-user-agent-library-version": "electron-fetch",
    "x-copilot-account-type": accountType,
    "x-request-id": crypto.randomUUID(),
  }
}
