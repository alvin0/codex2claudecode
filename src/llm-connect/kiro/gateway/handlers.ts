import type { KiroStandaloneClient } from "../client"
import type { ChatCompletionRequest, ClaudeMessagesRequest } from "../../../types"
import { claudeErrorResponse } from "../../../claude/errors"

import { anthropicMessagesToKiroInput, openAiChatCompletionsToKiroInput } from "./convert"
import { anthropicJsonResponse, anthropicStreamResponse, collectKiroResponse, openAiJsonResponse, openAiStreamResponse } from "./stream"
import { hasWebSearchTool, handleKiroWebSearch } from "./web-search"

export async function handleKiroAnthropicMessages(
  client: Pick<KiroStandaloneClient, "generateAssistantResponse" | "mcpCall">,
  request: Request,
) {
  let body: ClaudeMessagesRequest
  try {
    body = (await request.json()) as ClaudeMessagesRequest
  } catch (error) {
    return claudeErrorResponse(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, 400)
  }

  if (!Array.isArray(body.messages)) return claudeErrorResponse("Claude messages request requires messages", 400)

  // Web search: early return via MCP API (like Python Path A)
  // Only intercept on the first turn (no prior assistant messages).
  // Multi-turn requests that already contain search results should go
  // through the normal Kiro API flow so the model can reason over them.
  const isFirstTurn = !body.messages.some((m) => m.role === "assistant")
  if (isFirstTurn && hasWebSearchTool(body)) {
    return handleKiroWebSearch(client, body)
  }

  try {
    const input = anthropicMessagesToKiroInput(body)
    const response = await client.generateAssistantResponse({
      modelId: input.modelId,
      content: input.currentMessage.content,
      currentMessage: input.currentMessage,
      conversationId: input.conversationId,
      history: input.history,
      stream: body.stream,
    })

    if (!response.ok) {
      const text = await response.text()
      return claudeErrorResponse(`Kiro request failed: ${response.status} ${text}`, response.status)
    }

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
    const response = await client.generateAssistantResponse({
      modelId: input.modelId,
      content: input.currentMessage.content,
      currentMessage: input.currentMessage,
      conversationId: input.conversationId,
      history: input.history,
      stream: body.stream,
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
