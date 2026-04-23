import { LOG_BODY_PREVIEW_LIMIT } from "../../../constants"
import type { KiroStandaloneClient } from "../client"
import type { ChatCompletionRequest, ClaudeMessagesRequest, RequestProxyLog } from "../../../types"
import { claudeErrorResponse } from "../../../claude/errors"

import { anthropicMessagesToKiroInput, openAiChatCompletionsToKiroInput } from "./convert"
import { anthropicJsonResponse, anthropicStreamResponse, collectKiroResponse, openAiJsonResponse, openAiStreamResponse } from "./stream"
import { extractQueryFromMessages, hasWebSearchTool, handleKiroWebSearch } from "./web-search"

export async function handleKiroAnthropicMessages(
  client: Pick<KiroStandaloneClient, "generateAssistantResponse" | "mcpCall">,
  request: Request,
  requestId?: string,
  options?: { logBody?: boolean; onProxy?: (entry: RequestProxyLog) => void },
) {
  let body: ClaudeMessagesRequest
  try {
    body = (await request.json()) as ClaudeMessagesRequest
  } catch (error) {
    return claudeErrorResponse(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, 400)
  }

  if (!Array.isArray(body.messages)) return claudeErrorResponse("Claude messages request requires messages", 400)

  const localTitleResponse = maybeHandleConversationTitle(body)
  if (localTitleResponse) return localTitleResponse

  // Web search: intercept requests that include a web_search tool.
  //
  // The Kiro generateAssistantResponse API does not natively support web
  // search.  When the caller includes a web_search tool we handle it
  // ourselves via the MCP web_search endpoint and return Anthropic-format
  // results directly.
  if (hasWebSearchTool(body)) {
    return handleKiroWebSearch(client, body, { onProxy: options?.onProxy })
  }

  try {
    const input = anthropicMessagesToKiroInput(body)
    const upstreamStream = true
    const requestBody = previewText(stringifyKiroRequestBody({
      modelId: input.modelId,
      conversationId: input.conversationId,
      history: input.history,
      currentMessage: input.currentMessage,
      content: input.currentMessage.content,
      stream: upstreamStream,
    }))
    if (options?.logBody && requestId) logUpstreamBody(requestId, requestBody)

    const started = Date.now()
    const response = await client.generateAssistantResponse({
      modelId: input.modelId,
      content: input.currentMessage.content,
      currentMessage: input.currentMessage,
      conversationId: input.conversationId,
      history: input.history,
      stream: upstreamStream,
    })
    const durationMs = Date.now() - started

    if (!response.ok) {
      const text = await response.text()
      options?.onProxy?.({
        label: "Kiro messages",
        method: "POST",
        target: "/generateAssistantResponse",
        status: response.status,
        durationMs,
        error: text.slice(0, LOG_BODY_PREVIEW_LIMIT) || "-",
        requestBody,
      })
      return claudeErrorResponse(`Kiro request failed: ${response.status} ${text}`, response.status)
    }

    options?.onProxy?.({
      label: "Kiro messages",
      method: "POST",
      target: "/generateAssistantResponse",
      status: response.status,
      durationMs,
      error: "-",
      requestBody,
    })

    if (body.stream) return anthropicStreamResponse(response, body, { mcpCall: client.mcpCall.bind(client) })
    return Response.json(anthropicJsonResponse(await collectKiroResponse(response), body))
  } catch (error) {
    return claudeErrorResponse(error instanceof Error ? error.message : String(error), 400)
  }
}

export async function handleKiroChatCompletions(
  client: Pick<KiroStandaloneClient, "generateAssistantResponse">,
  request: Request,
) {
  let body: ChatCompletionRequest
  try {
    body = (await request.json()) as ChatCompletionRequest
  } catch (error) {
    return openAiErrorResponse(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, 400)
  }

  if (!Array.isArray(body.messages)) return openAiErrorResponse("Chat completions request requires messages", 400)

  try {
    const input = openAiChatCompletionsToKiroInput(body)
    const upstreamStream = true
    const response = await client.generateAssistantResponse({
      modelId: input.modelId,
      content: input.currentMessage.content,
      currentMessage: input.currentMessage,
      conversationId: input.conversationId,
      history: input.history,
      stream: upstreamStream,
    })

    if (!response.ok) {
      const text = await response.text()
      return openAiErrorResponse(`Kiro request failed: ${response.status} ${text}`, response.status)
    }

    if (body.stream) return openAiStreamResponse(response, body)
    return Response.json(openAiJsonResponse(await collectKiroResponse(response), body))
  } catch (error) {
    return openAiErrorResponse(error instanceof Error ? error.message : String(error), 400)
  }
}

function openAiErrorResponse(message: string, status: number) {
  return Response.json(
    {
      error: {
        message,
        type: status === 400 ? "invalid_request_error" : "api_error",
      },
    },
    { status },
  )
}

function stringifyKiroRequestBody(value: Record<string, unknown>) {
  return JSON.stringify(value)
}

function maybeHandleConversationTitle(body: ClaudeMessagesRequest) {
  if (!isConversationTitleRequest(body)) return

  const title = buildConversationTitle(body)
  const text = JSON.stringify({ title })
  return body.stream ? streamAnthropicText(body.model, text) : Response.json(anthropicTextMessage(body.model, text))
}

function isConversationTitleRequest(body: ClaudeMessagesRequest) {
  const systemText = extractSystemText(body.system)
  const schema = body.output_config?.format?.schema
  const properties = isJsonObject(schema?.properties) ? schema.properties : undefined
  const titleProperty = isJsonObject(properties?.title) ? properties.title : undefined

  return body.output_config?.format?.type === "json_schema"
    && typeof titleProperty?.type === "string"
    && titleProperty.type === "string"
    && systemText.includes("Generate a concise, sentence-case title")
    && systemText.includes("Return JSON with a single \"title\" field.")
}

function buildConversationTitle(body: ClaudeMessagesRequest) {
  const query = extractQueryFromMessages(body.messages) ?? "Coding session"
  const normalized = query
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/^(please|can you|could you|help me|i need help with|hãy|vui lòng|giúp tôi|cho tôi biết)\s+/i, "")
    .replace(/[!?.,:;()[\]{}]+/g, " ")
    .replace(/\s+/g, " ")

  const words = normalized.split(" ").filter(Boolean)
  const title = words.slice(0, 6).join(" ").trim()
  if (!title) return "Coding session"
  return title.charAt(0).toUpperCase() + title.slice(1)
}

function anthropicTextMessage(model: string, text: string) {
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
  }
}

function streamAnthropicText(model: string, text: string) {
  const encoder = new TextEncoder()
  const message = anthropicTextMessage(model, text)
  const events = [
    ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, stop_sequence: null } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: message.usage }],
    ["message_stop", { type: "message_stop" }],
  ] as const

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const [event, data] of events) {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        }
        controller.close()
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    },
  )
}

function extractSystemText(system: ClaudeMessagesRequest["system"]) {
  if (typeof system === "string") return system
  if (!Array.isArray(system)) return ""
  return system
    .map((item) => {
      if (typeof item === "string") return item
      if (!item || typeof item !== "object") return ""
      return typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : ""
    })
    .filter(Boolean)
    .join("\n\n")
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function previewText(text: string) {
  return text.slice(0, LOG_BODY_PREVIEW_LIMIT)
}

function logUpstreamBody(requestId: string, requestBody: string) {
  console.log(`[${requestId}] upstream body ${requestBody}`)
}
