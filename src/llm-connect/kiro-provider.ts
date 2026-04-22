import { countTokens } from "gpt-tokenizer"

import { claudeErrorResponse } from "../claude/errors"
import type { ClaudeMessagesRequest, JsonObject } from "../types"

import type { HandleMessagesOptions, HealthResult, LlmProvider, ProxyOptions } from "./provider"
import { KiroStandaloneClient } from "./kiro/client"
import { anthropicMessagesToKiroInput } from "./kiro/gateway/convert"
import { handleKiroAnthropicMessages, handleKiroChatCompletions } from "./kiro/gateway/handlers"
import { buildKiroGenerateAssistantResponsePayload } from "./kiro/payload"

/**
 * Kiro backend wrapped as an LlmProvider.
 */
export class KiroProvider implements LlmProvider {
  readonly name = "kiro"
  private readonly client: KiroStandaloneClient

  constructor(client: KiroStandaloneClient) {
    this.client = client
  }

  static async create(options?: { credsFile?: string; account?: string }) {
    const client = await KiroStandaloneClient.create({
      ...options,
      credsFile: options?.credsFile,
      kiroAccount: options?.account,
    })
    return new KiroProvider(client)
  }

  async handleMessages(
    request: Request,
    requestId: string,
    _options?: HandleMessagesOptions,
  ) {
    return handleKiroAnthropicMessages(this.client, request)
  }

  async handleCountTokens(request: Request) {
    // Build the full Kiro payload (same as the messages endpoint) and count
    // tokens on the serialized JSON.  This keeps the estimate consistent with
    // what the Kiro backend actually receives.
    let body: ClaudeMessagesRequest
    try {
      body = (await request.json()) as ClaudeMessagesRequest
    } catch (error) {
      return claudeErrorResponse(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, 400)
    }

    if (!body.model || typeof body.model !== "string") return claudeErrorResponse("Claude count_tokens request requires model", 400)
    if (!Array.isArray(body.messages)) return claudeErrorResponse("Claude count_tokens request requires messages", 400)

    try {
      const input = anthropicMessagesToKiroInput(body)
      const tokens = this.client.tokens
      const profileArn = tokens.authType === "kiro_desktop" ? tokens.profileArn : undefined

      const kiroPayload = buildKiroGenerateAssistantResponsePayload({
        content: input.currentMessage.content,
        currentMessage: input.currentMessage,
        modelId: input.modelId,
        history: input.history,
        conversationId: input.conversationId,
        profileArn,
      })

      const serialized = JSON.stringify(kiroPayload)
      const inputTokens = countTokens(serialized)

      return Response.json({ input_tokens: Math.max(1, inputTokens) })
    } catch (error) {
      return claudeErrorResponse(error instanceof Error ? error.message : String(error), 400)
    }
  }

  async proxy(body: JsonObject, _options?: ProxyOptions) {
    // Determine format: if body has `messages` array with role-based entries
    // it's a chat completions request; otherwise treat as Anthropic messages.
    if (isChatCompletionsShape(body)) {
      return handleKiroChatCompletions(this.client, bodyToRequest(body))
    }
    return handleKiroAnthropicMessages(this.client, bodyToRequest(body))
  }

  async checkHealth(timeoutMs = 5000): Promise<HealthResult> {
    const started = Date.now()
    try {
      const result = await Promise.race([
        this.client.listAvailableModels(),
        timeout(timeoutMs),
      ])
      return {
        ok: result !== null,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
      }
    } catch (error) {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async refresh() {
    return this.client.refresh()
  }

  /** Access the underlying client for Kiro-specific features. */
  get raw() {
    return this.client
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isChatCompletionsShape(body: JsonObject) {
  if (!Array.isArray(body.messages)) return false
  const first = (body.messages as Array<{ role?: string }>)[0]
  return first?.role === "system" || first?.role === "developer" || first?.role === "tool"
}

function bodyToRequest(body: JsonObject) {
  return new Request("http://localhost/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function timeout(ms: number): Promise<null> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Health check timed out after ${ms}ms`)), ms),
  )
}
