import { CodexStandaloneClient } from "../client"
import { handleClaudeCountTokens, handleClaudeMessages } from "../claude"
import type { JsonObject } from "../types"

import type { HandleMessagesOptions, HealthResult, LlmProvider, ProxyOptions } from "./provider"

/**
 * Codex (OpenAI/ChatGPT) backend wrapped as an LlmProvider.
 */
export class CodexProvider implements LlmProvider {
  readonly name = "codex"
  private readonly client: CodexStandaloneClient

  constructor(client: CodexStandaloneClient) {
    this.client = client
  }

  static async create(authFile: string, options?: { authAccount?: string }) {
    const client = await CodexStandaloneClient.fromAuthFile(authFile, options)
    return new CodexProvider(client)
  }

  async handleMessages(
    request: Request,
    requestId: string,
    options?: HandleMessagesOptions,
  ) {
    return handleClaudeMessages(this.client, request, requestId, options)
  }

  async handleCountTokens(request: Request) {
    return handleClaudeCountTokens(request)
  }

  async proxy(body: JsonObject, options?: ProxyOptions) {
    return this.client.proxy(body, options)
  }

  async checkHealth(timeoutMs = 5000): Promise<HealthResult> {
    return this.client.checkHealth(timeoutMs)
  }

  async refresh() {
    return this.client.refresh()
  }

  /** Access the underlying client for Codex-specific features (usage, environments). */
  get raw() {
    return this.client
  }
}
