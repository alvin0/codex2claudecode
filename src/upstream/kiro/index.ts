import type { Canonical_ErrorResponse, Canonical_Request, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import { responseHeaders } from "../../core/http"
import type { UpstreamResult, Upstream_Provider } from "../../core/interfaces"
import type { JsonObject, RequestOptions } from "../../core/types"
import { HIDDEN_KIRO_MODELS, MODEL_CACHE_TTL_SECONDS } from "./constants"
import { Kiro_Auth_Manager, type KiroAuthManagerOptions } from "./auth"
import { Kiro_Client } from "./client"
import { kiroWebSearchTool, webSearchBlocks } from "./mcp"
import { convertCanonicalToKiroPayload, trimNoticeText } from "./payload"
import { collectKiroResponse, streamKiroResponse } from "./parse"
import { KiroHttpError, KiroMcpError, KiroNetworkError, PayloadTooLargeError, ToolNameTooLongError } from "./types"

interface KiroClientOptions extends KiroAuthManagerOptions {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  apiRegion?: string
}

export class Kiro_Upstream_Provider implements Upstream_Provider {
  private readonly auth: Kiro_Auth_Manager
  private readonly client: Kiro_Client
  private modelCache?: { models: string[]; cachedAt: number }

  constructor(options: { auth: Kiro_Auth_Manager; client?: Kiro_Client }) {
    this.auth = options.auth
    this.client = options.client ?? new Kiro_Client(this.auth)
  }

  static async fromAuthFile(path?: string, options?: KiroClientOptions) {
    const auth = await Kiro_Auth_Manager.fromAuthFile(path, options)
    return new Kiro_Upstream_Provider({ auth, client: new Kiro_Client(auth, options) })
  }

  async proxy(request: Canonical_Request, options?: RequestOptions): Promise<UpstreamResult> {
    const serverToolError = validateUnsupportedServerTools(request.tools)
    if (serverToolError) return serverToolError

    const explicitWebSearch = hasExplicitWebSearchIntent(request)
    const clientWebSearchCall = clientWebSearchToolCall(request, explicitWebSearch)
    const clientAllowedDirectoriesCall = clientAllowedDirectoriesToolCall(request)
    const effective = computeEffectiveTools(request.tools, request.toolChoice, {
      autoWebSearch: !hasClientWebSearchTool(request) && webSearchAutoInjectEnabled() && (!request.textFormat || explicitWebSearch),
    })
    if ("error" in effective) return canonicalError(400, effective.error)

    const model = normalizeKiroModelName(request.model)
    if (clientWebSearchCall) {
      return clientToolCallResponse(request, model, clientWebSearchCall)
    }
    if (clientAllowedDirectoriesCall) {
      return clientToolCallResponse(request, model, clientAllowedDirectoriesCall)
    }

    const fallbackWebSearchQuery = effective.webSearch ? inferWebSearchFallbackQuery(request) : undefined
    const shouldPreflightWebSearch = Boolean(effective.webSearch && explicitWebSearch && fallbackWebSearchQuery)
    if (request.stream && shouldPreflightWebSearch && fallbackWebSearchQuery) {
      return this.streamWithWebSearchPreflight(request, options, effective.tools, model, fallbackWebSearchQuery)
    }

    let preflightWebSearch: Awaited<ReturnType<Kiro_Client["callMcpWebSearch"]>> | undefined
    try {
      if (shouldPreflightWebSearch && fallbackWebSearchQuery) {
        preflightWebSearch = await this.client.callMcpWebSearch(fallbackWebSearchQuery, { signal: options?.signal })
      }
    } catch (error) {
      const mapped = mapKiroError(error)
      if (mapped) return mapped
      throw error
    }

    const requestForPayload = {
      ...request,
      instructions: buildKiroInstructions(request.instructions, request.textFormat, Boolean(effective.webSearch), preflightWebSearch?.summary),
    }
    let payload
    let payloadTrimWarning = ""
    try {
      payload = convertCanonicalToKiroPayload(requestForPayload, effective.tools, {
        modelId: model,
        authType: this.auth.getAuthType(),
        profileArn: this.auth.getProfileArn(),
        instructions: requestForPayload.instructions,
        onTrim: (notice) => {
          payloadTrimWarning = `${trimNoticeText(notice)}\n\n`
        },
      })
      options?.onRequestBody?.(JSON.stringify(payload))
    } catch (error) {
      if (error instanceof ToolNameTooLongError) return canonicalError(400, error.message)
      if (error instanceof PayloadTooLargeError) return canonicalError(413, error.message)
      throw error
    }
    const inputTokenEstimate = estimateInputTokens(payload)

    try {
      const response = withLoggedResponseBody(await this.client.generateAssistantResponse(payload, { signal: options?.signal, stream: request.stream }), options?.onResponseBodyChunk)
      const serverTools = effective.webSearch
        ? {
            webSearch: (query: string) => this.client.callMcpWebSearch(query, { signal: options?.signal }),
            webSearchFallbackQuery: fallbackWebSearchQuery,
          }
        : undefined
      const initialServerToolBlocks = preflightWebSearch && fallbackWebSearchQuery ? webSearchBlocks(preflightWebSearch.toolUseId, fallbackWebSearchQuery, preflightWebSearch.results) : []
      if (request.stream) return streamKiroResponse(response, model, effective.tools, inputTokenEstimate, serverTools, initialServerToolBlocks, payloadTrimWarning)
      return collectKiroResponse(response, model, effective.tools, inputTokenEstimate, serverTools, initialServerToolBlocks, payloadTrimWarning)
    } catch (error) {
      const mapped = mapKiroError(error)
      if (mapped) return mapped
      throw error
    }
  }

  private streamWithWebSearchPreflight(
    request: Canonical_Request,
    options: RequestOptions | undefined,
    effectiveTools: JsonObject[],
    model: string,
    query: string,
  ): UpstreamResult {
    const client = this.client
    const authType = this.auth.getAuthType()
    const profileArn = this.auth.getProfileArn()
    const id = `resp_${crypto.randomUUID().replace(/-/g, "")}`

    return {
      type: "canonical_stream",
      status: 200,
      id,
      model,
      events: {
        async *[Symbol.asyncIterator]() {
          const toolUseId = `srvtoolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`
          yield {
            type: "server_tool_block",
            blocks: [{ type: "server_tool_use", id: toolUseId, name: "web_search", input: { query } }],
          } as const

          let search: Awaited<ReturnType<Kiro_Client["callMcpWebSearch"]>>
          try {
            search = await client.callMcpWebSearch(query, { signal: options?.signal, toolUseId })
          } catch (error) {
            yield { type: "error", message: streamErrorMessage(error) } as const
            return
          }

          yield {
            type: "server_tool_block",
            blocks: webSearchBlocks(search.toolUseId, query, search.results).filter((block) => block.type !== "server_tool_use"),
          } as const

          const requestForPayload = {
            ...request,
            instructions: buildKiroInstructions(request.instructions, request.textFormat, true, search.summary),
          }
          let payload
          let payloadTrimWarning = ""
          try {
            payload = convertCanonicalToKiroPayload(requestForPayload, effectiveTools, {
              modelId: model,
              authType,
              profileArn,
              instructions: requestForPayload.instructions,
              onTrim: (notice) => {
                payloadTrimWarning = `${trimNoticeText(notice)}\n\n`
              },
            })
            options?.onRequestBody?.(JSON.stringify(payload))
          } catch (error) {
            yield { type: "error", message: error instanceof Error ? error.message : String(error) } as const
            return
          }
          const inputTokenEstimate = estimateInputTokens(payload)

          let response
          try {
            response = withLoggedResponseBody(await client.generateAssistantResponse(payload, { signal: options?.signal, stream: true }), options?.onResponseBodyChunk)
          } catch (error) {
            yield { type: "error", message: streamErrorMessage(error) } as const
            return
          }

          const downstream = streamKiroResponse(
            response,
            model,
            effectiveTools,
            inputTokenEstimate,
            {
              webSearch: (nextQuery: string) => client.callMcpWebSearch(nextQuery, { signal: options?.signal }),
              webSearchFallbackQuery: query,
            },
            [],
            payloadTrimWarning,
          )
          for await (const event of downstream.events) {
            if (event.type === "usage") {
              yield {
                ...event,
                usage: {
                  ...event.usage,
                  serverToolUse: {
                    ...event.usage.serverToolUse,
                    webSearchRequests: 1 + (event.usage.serverToolUse?.webSearchRequests ?? 0),
                  },
                },
              }
              continue
            }
            yield event
          }
        },
      },
    }
  }

  async checkHealth(timeoutMs: number) {
    return this.client.checkHealth(timeoutMs)
  }

  async usage() {
    try {
      return await this.client.getUsageLimits()
    } catch {
      return Response.json({ error: "Usage limits unavailable" }, { status: 502 })
    }
  }

  async listModels() {
    if (this.modelCache && Date.now() - this.modelCache.cachedAt < MODEL_CACHE_TTL_SECONDS * 1000) return this.modelCache.models
    try {
      const models = dedupe((await this.client.listAvailableModels()).map(normalizeKiroModelName))
      this.modelCache = { models, cachedAt: Date.now() }
      return models
    } catch {
      return HIDDEN_KIRO_MODELS
    }
  }

  getAuthType() {
    return this.auth.getAuthType()
  }

  getRegion() {
    return this.auth.getRegion()
  }

  getProfileArn() {
    return this.auth.getProfileArn()
  }
}

export function computeEffectiveTools(tools: JsonObject[] = [], toolChoice?: JsonObject | string, options: { autoWebSearch?: boolean } = {}): { tools: JsonObject[]; webSearch?: boolean } | { error: string } {
  const hasServerWebSearch = tools.some((tool) => tool.type === "web_search")
  const functionTools = tools.filter((tool) => tool.type === "function")
  const shouldProvideWebSearch = hasServerWebSearch || Boolean(options.autoWebSearch)
  const injectedWebSearch = shouldProvideWebSearch && !functionTools.some((tool) => tool.name === "web_search") ? kiroWebSearchTool() : undefined
  const allTools = injectedWebSearch ? [injectedWebSearch, ...functionTools] : prioritizeWebSearch(functionTools)
  const webSearchEnabled = shouldProvideWebSearch && allTools.some((tool) => tool.name === "web_search")

  if (!toolChoice || toolChoice === "auto") return { tools: allTools, ...(webSearchEnabled ? { webSearch: true } : {}) }
  if (toolChoice === "none") return { tools: [] }
  if (toolChoice === "required") {
    console.warn("Kiro does not support required tool_choice; including all tools")
    return { tools: allTools, ...(webSearchEnabled ? { webSearch: true } : {}) }
  }
  if (typeof toolChoice === "object" && toolChoice.type === "web_search") {
    const found = allTools.find((tool) => tool.name === "web_search")
    return found ? { tools: [found], ...(webSearchEnabled ? { webSearch: true } : {}) } : { error: "web_search tool_choice was requested but web_search was not provided" }
  }
  if (typeof toolChoice === "object" && typeof toolChoice.name === "string") {
    console.warn("Kiro does not support named tool_choice; narrowing available tools")
    const found = allTools.find((tool) => tool.name === toolChoice.name)
    return found ? { tools: [found], ...(webSearchEnabled && found.name === "web_search" ? { webSearch: true } : {}) } : { error: `Named tool_choice '${toolChoice.name}' was not found in provided tools` }
  }
  if (typeof toolChoice === "object" && toolChoice.type === "function" && typeof (toolChoice as { function?: { name?: unknown } }).function?.name === "string") {
    const name = (toolChoice as { function: { name: string } }).function.name
    const found = allTools.find((tool) => tool.name === name)
    return found ? { tools: [found], ...(webSearchEnabled && found.name === "web_search" ? { webSearch: true } : {}) } : { error: `Named tool_choice '${name}' was not found in provided tools` }
  }
  return { tools: allTools, ...(webSearchEnabled ? { webSearch: true } : {}) }
}

export function normalizeKiroModelName(model: string) {
  let normalized = model.replace(/(-\d+(?:-\d+)?)-latest$/, "$1").replace(/-\d{8}$/, "")
  normalized = normalized.replace(/^(claude-[a-z]+-\d+)-(\d+)$/, "$1.$2")
  normalized = normalized.replace(/^(claude-\d+)-(\d+)(-[a-z]+.*)$/, "$1.$2$3")
  return normalized
}

function validateUnsupportedServerTools(tools: JsonObject[] = []): Canonical_ErrorResponse | undefined {
  const unsupported = tools.filter((tool) => tool.type === "web_fetch" || tool.type === "mcp")
  if (!unsupported.length) return
  return canonicalError(400, "Server tools web_fetch and mcp are not supported by the Kiro upstream provider")
}

function canonicalError(status: number, body: string): Canonical_ErrorResponse {
  return { type: "canonical_error", status, headers: new Headers(), body }
}

function streamErrorMessage(error: unknown) {
  if (error instanceof KiroHttpError) return `Kiro HTTP ${error.status}: ${error.body}`
  if (error instanceof KiroNetworkError) return error.message
  if (error instanceof KiroMcpError) return error.message
  return error instanceof Error ? error.message : String(error)
}

function mapKiroError(error: unknown): Canonical_ErrorResponse | undefined {
  if (error instanceof KiroHttpError) return { type: "canonical_error", status: error.status, headers: error.headers, body: error.body }
  if (error instanceof KiroNetworkError) return canonicalError(504, error.message)
  if (error instanceof KiroMcpError) return canonicalError(502, error.message)
}

const inputTokenEstimateEncoder = new TextEncoder()

function estimateInputTokens(value: unknown) {
  const serialized = JSON.stringify(value)
  if (!serialized) return 0
  // This is usage fallback only; exact tokenization is too slow on near-limit streamed payloads.
  return Math.ceil(inputTokenEstimateEncoder.encode(serialized).length / 4)
}

function buildKiroInstructions(instructions: string | undefined, textFormat: JsonObject | undefined, webSearch: boolean, webSearchContext?: string) {
  const additions = [
    webSearch
      ? [
          "Web search policy for this gateway:",
          "- The tool named `web_search` is available for explicit websearch/web search requests, URL lookup, article/page summarization, current/recent/external information, news, consumer tech, and product information.",
          "- These requests are in scope even when they are unrelated to programming or software development.",
          "- When the user provides a URL or asks to use websearch/web search, call `web_search` with a non-empty `query` string. If a URL is present, use that URL as the query.",
          "- Do not refuse because the request is outside coding or software development; do not say you cannot browse before trying `web_search`.",
          "- After search results are available, answer directly in the user's language.",
        ].join("\n")
      : undefined,
    webSearchContext
      ? [
          "The gateway has already executed `web_search` for this turn.",
          "Use the following search results as source context for the final answer. Do not print the raw <web_search> block.",
          webSearchContext,
        ].join("\n")
      : undefined,
    structuredOutputInstruction(textFormat),
  ].filter((item): item is string => Boolean(item))

  return additions.reduce((acc, addition) => {
    if (acc?.includes(addition)) return acc
    return [acc, addition].filter(Boolean).join("\n\n")
  }, instructions)
}

function prioritizeWebSearch(tools: JsonObject[]) {
  const webSearch = tools.find((tool) => tool.name === "web_search")
  if (!webSearch) return tools
  return [webSearch, ...tools.filter((tool) => tool !== webSearch)]
}

function inferWebSearchFallbackQuery(request: Canonical_Request) {
  const text = webSearchQueryText(currentUserText(request))
  if (!text) return
  const url = text.match(/https?:\/\/[^\s<>"')\]]+/)?.[0]?.replace(/[),.;]+$/, "")
  return url || text.slice(0, 500)
}

function hasExplicitWebSearchIntent(request: Canonical_Request) {
  const text = currentUserText(request)
  if (!text) return false
  return /https?:\/\//i.test(text) || /\bweb\s*search\b|\bwebsearch\b|tìm kiếm web|tra cứu web|sử dụng web/i.test(text)
}

function currentUserText(request: Canonical_Request) {
  const message = request.input.at(-1)
  if (message?.role !== "user") return ""
  return message.content.flatMap(contentText).map(stripHiddenContext).map((text) => text.trim()).filter(Boolean).join("\n").trim()
}

function hasClientWebSearchTool(request: Canonical_Request) {
  return typeof request.metadata.claudeClientWebSearchToolName === "string"
}

function clientWebSearchToolCall(request: Canonical_Request, explicitWebSearch: boolean) {
  if (!explicitWebSearch) return
  if (request.toolChoice === "none") return
  const query = inferWebSearchFallbackQuery(request)
  if (!query) return
  const name = selectClientWebToolName(request, query)
  if (!name) return
  const toolArguments = clientWebSearchArguments(name, query)
  if (!toolArguments) return
  return { name, arguments: JSON.stringify(toolArguments) }
}

function clientWebSearchArguments(name: string, query: string) {
  if (isClientWebFetchToolName(name)) {
    if (!isUrlQuery(query)) return
    return { url: query, prompt: "Summarize this page for the user." }
  }
  return { query }
}

function selectClientWebToolName(request: Canonical_Request, query: string) {
  const metadataName = typeof request.metadata.claudeClientWebSearchToolName === "string" && isClientWebToolName(request.metadata.claudeClientWebSearchToolName)
    ? request.metadata.claudeClientWebSearchToolName
    : undefined
  if (!metadataName) return

  const chosen = selectedToolChoiceName(request)
  if (chosen) {
    if (!isClientWebToolName(chosen)) return
    return canUseClientWebTool(chosen, query) ? chosen : undefined
  }
  if (request.toolChoice && typeof request.toolChoice === "object" && request.toolChoice.type !== "function") return

  const names = dedupe([
    metadataName,
    ...clientWebToolNames(request),
  ])
  if (!isUrlQuery(query)) return names.find(isClientWebSearchToolName)
  return names.find((name) => name === metadataName && canUseClientWebTool(name, query))
    ?? names.find((name) => canUseClientWebTool(name, query))
}

function selectedToolChoiceName(request: Canonical_Request) {
  if (!request.toolChoice || typeof request.toolChoice !== "object") return
  if (typeof request.toolChoice.name === "string") return request.toolChoice.name
  const functionChoice = request.toolChoice.function as JsonObject | undefined
  return typeof functionChoice?.name === "string" ? functionChoice.name : undefined
}

function clientWebToolNames(request: Canonical_Request) {
  return (request.tools ?? []).flatMap((tool) => typeof tool.name === "string" && isClientWebToolName(tool.name) ? [tool.name] : [])
}

function canUseClientWebTool(name: string, query: string | undefined) {
  return isClientWebFetchToolName(name) ? Boolean(query && isUrlQuery(query)) : isClientWebSearchToolName(name)
}

function isClientWebToolName(name: string) {
  return /^web[_-]?(search|fetch)(?:_\d+)?$/i.test(name)
}

function isClientWebSearchToolName(name: string) {
  return /^web[_-]?search(?:_\d+)?$/i.test(name)
}

function isClientWebFetchToolName(name: string) {
  return /^web[_-]?fetch(?:_\d+)?$/i.test(name)
}

function isUrlQuery(query: string) {
  return /^https?:\/\//i.test(query)
}

function clientAllowedDirectoriesToolCall(request: Canonical_Request) {
  if (!hasAllowedDirectoriesIntent(request)) return
  if (request.toolChoice === "none") return
  const tool = request.tools?.find((item) => typeof item.name === "string" && /(?:^|__)list_allowed_directories$/i.test(item.name))
  const name = typeof tool?.name === "string" ? tool.name : undefined
  if (!name) return
  if (typeof request.toolChoice === "object" && request.toolChoice) {
    const chosen = typeof request.toolChoice.name === "string" ? request.toolChoice.name
      : typeof (request.toolChoice.function as JsonObject | undefined)?.name === "string" ? (request.toolChoice.function as JsonObject).name
        : undefined
    if (chosen && chosen !== name) return
  }
  return { name, arguments: "{}" }
}

function hasAllowedDirectoriesIntent(request: Canonical_Request) {
  const text = currentUserText(request)
  if (!text) return false
  const normalized = text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
  return /\blist[_\s-]*allowed[_\s-]*directories\b|\ballowed directories\b/i.test(text)
    || /(thư mục|folder|directories?|thu muc).*(được phép|có thể|duoc phep|co the).*(truy cập|đọc|truy cap|doc)/i.test(text)
    || /(truy cập|đọc|truy cap|doc).*(thư mục|folder|directories?|thu muc).*(nào|gì|nao|gi)/i.test(text)
    || /(thu muc|folder|directories?).*(duoc phep|co the).*(truy cap|doc)/i.test(normalized)
    || /(truy cap|doc).*(thu muc|folder|directories?).*(nao|gi)/i.test(normalized)
}

function clientToolCallResponse(
  request: Canonical_Request,
  model: string,
  call: { name: string; arguments: string },
): Canonical_Response | Canonical_StreamResponse {
  const id = `resp_${crypto.randomUUID().replace(/-/g, "")}`
  const callId = `toolu_${crypto.randomUUID().replace(/-/g, "")}`
  const usage = { inputTokens: estimateInputTokens(request), outputTokens: 0 }

  if (!request.stream) {
    return {
      type: "canonical_response",
      id,
      model,
      stopReason: "tool_use",
      content: [{ type: "tool_call", id: `fc_${crypto.randomUUID().replace(/-/g, "")}`, callId, name: call.name, arguments: call.arguments }],
      usage,
    }
  }

  return {
    type: "canonical_stream",
    status: 200,
    id,
    model,
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: "tool_call_done", callId, name: call.name, arguments: call.arguments } as const
        yield { type: "usage", usage } as const
        yield { type: "message_stop", stopReason: "tool_use" } as const
      },
    },
  }
}

function contentText(block: JsonObject) {
  if (typeof block.text === "string") return [block.text]
  if (typeof block.content === "string") return [block.content]
  return []
}

function stripHiddenContext(text: string) {
  return ["system-reminder", "project-memory-context", "local-command-caveat", "command-name", "command-message", "command-args", "local-command-stdout"].reduce((acc, tag) => {
    const closed = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi")
    const open = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "gi")
    return acc.replace(closed, "").replace(open, "")
  }, text)
}

function webSearchQueryText(text: string) {
  const match = text.match(/^Perform a web search for the query:\s*([\s\S]*)$/i)
  return (match ? match[1] : text).trim()
}

function structuredOutputInstruction(textFormat: JsonObject | undefined) {
  if (!textFormat) return
  const name = typeof textFormat.name === "string" && textFormat.name.trim() ? textFormat.name.trim() : "structured_output"
  const schema = textFormat.schema ?? textFormat
  return [
    `Structured output requested (${name}). Kiro does not support native structured output, so emulate it exactly.`,
    "Return only valid JSON that matches the requested schema. Do not include markdown fences, prose, or any text outside the JSON object.",
    `JSON schema: ${JSON.stringify(schema)}`,
  ].join("\n")
}

function webSearchAutoInjectEnabled() {
  const value = process.env.KIRO_WEB_SEARCH_ENABLED ?? process.env.WEB_SEARCH_ENABLED
  if (value === undefined) return true
  return ["true", "1", "yes"].includes(value.toLowerCase())
}

function dedupe(values: string[]) {
  return [...new Set(values.filter(Boolean))]
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
  return new Response(body, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) })
}

export { Kiro_Auth_Manager } from "./auth"
export { Kiro_Client } from "./client"
export { extractWebSearchQuery, kiroWebSearchTool, parseMcpWebSearchResults, webSearchBlocks, webSearchSummary } from "./mcp"
export { convertCanonicalToKiroPayload, sanitizeToolSchema, trimNoticeText } from "./payload"
export type { KiroPayloadTrimNotice } from "./payload"
export { AwsEventStreamParser, ThinkingBlockExtractor, collectKiroResponse, streamKiroResponse } from "./parse"
export type * from "./types"
