import type { ChatCompletionRequest, ClaudeMessagesRequest, JsonObject } from "../../../types"
import {
  createKiroAssistantResponseMessage,
  createKiroHistoryEntry,
  createKiroUserInputMessage,
} from "../payload"
import type { KiroImage, KiroToolResult, KiroToolSpecification, KiroToolUse } from "../types"

import { normalizeAnthropicRequest, normalizeOpenAiRequest } from "./normalize"
import type { KiroGatewayBlock, KiroGatewayInput, KiroGatewayMessage, KiroGatewayTool } from "./types"

export function anthropicMessagesToKiroInput(body: ClaudeMessagesRequest): KiroGatewayInput {
  if (!Array.isArray(body.messages)) throw new Error("Claude messages request requires messages")
  const normalized = normalizeAnthropicRequest(body)
  return normalizedMessagesToKiroInput({
    messages: normalized.messages,
    system: normalized.system,
    modelId: body.model,
    stream: Boolean(body.stream),
    tools: normalized.tools,
    toolChoice: normalizeToolChoice(normalized.toolChoice),
    thinking: normalized.thinking,
  })
}

export function openAiChatCompletionsToKiroInput(body: ChatCompletionRequest): KiroGatewayInput {
  if (!Array.isArray(body.messages)) throw new Error("Chat completions request requires messages")
  const normalized = normalizeOpenAiRequest(body)
  return normalizedMessagesToKiroInput({
    messages: normalized.messages,
    system: normalized.system,
    modelId: body.model,
    stream: Boolean(body.stream),
    tools: normalized.tools,
    toolChoice: normalizeToolChoice(normalized.toolChoice),
    thinking: normalized.thinking,
  })
}

function normalizedMessagesToKiroInput(options: {
  messages: KiroGatewayMessage[]
  system?: string
  modelId: string
  stream: boolean
  tools?: KiroGatewayTool[]
  toolChoice?: string | JsonObject
  thinking?: KiroGatewayInput["thinking"]
}): KiroGatewayInput {
  if (!options.messages.length) throw new Error("No messages to send")

  const historyMessages = options.messages.slice(0, -1)
  const currentMessage = options.messages.at(-1)!
  const history = buildHistory(historyMessages, options.modelId)

  let currentBlocks = [...currentMessage.content]
  if (options.system && !history.length && currentMessage.role === "user") {
    currentBlocks = prependSystemToBlocks(currentBlocks, options.system)
  } else if (options.system && history.length) {
    prependSystemToFirstHistoryUser(history, options.system)
  }

  if (currentMessage.role === "assistant") {
    history.push(
      createKiroHistoryEntry({
        assistantResponseMessage: createKiroAssistantResponseMessage({
          content: blocksToText(currentBlocks) || "(empty)",
          toolUses: blocksToToolUses(currentBlocks),
        }),
      }),
    )
    currentBlocks = [{ type: "text", text: "Continue" }]
  }

  const currentText = blocksToText(currentBlocks) || "Continue"
  const currentImages = blocksToImages(currentBlocks)
  const currentToolResults = blocksToToolResults(currentBlocks)
  const currentTools = normalizeToolsForCurrentMessage(options.tools)

  return {
    modelId: options.modelId,
    stream: options.stream,
    currentMessage: createKiroUserInputMessage({
      content: injectThinking(currentText, options.thinking),
      modelId: options.modelId,
      images: currentImages,
      tools: currentTools,
      toolResults: currentToolResults,
    }),
    history: history.length ? history : undefined,
    system: options.system,
    tools: options.tools,
    toolChoice: options.toolChoice,
    thinking: options.thinking,
  }
}

function buildHistory(messages: KiroGatewayMessage[], modelId: string) {
  return messages.map((message) =>
    message.role === "user"
      ? createKiroHistoryEntry({
          userInputMessage: createKiroUserInputMessage({
            content: blocksToText(message.content) || "(empty)",
            modelId,
            images: blocksToImages(message.content),
            toolResults: blocksToToolResults(message.content),
          }),
        })
      : createKiroHistoryEntry({
          assistantResponseMessage: createKiroAssistantResponseMessage({
            content: blocksToText(message.content) || "(empty)",
            toolUses: blocksToToolUses(message.content),
          }),
        }),
  )
}

function prependSystemToFirstHistoryUser(
  history: ReturnType<typeof buildHistory>,
  system: string,
) {
  for (const entry of history) {
    if (!entry.userInputMessage) continue
    entry.userInputMessage.content = [system, entry.userInputMessage.content].filter(Boolean).join("\n\n")
    return
  }
}

function prependSystemToBlocks(blocks: KiroGatewayBlock[], system: string) {
  return [{ type: "text", text: system }, { type: "text", text: "\n\n" }, ...blocks]
}

function blocksToText(blocks: KiroGatewayBlock[]) {
  const text = blocks
    .flatMap((block) => {
      if (block.type === "text") return [block.text]
      if (block.type === "tool_result") return [toolResultContentToText(block.content)]
      return []
    })
    .join("")
  return text
}

function blocksToImages(blocks: KiroGatewayBlock[]): KiroImage[] | undefined {
  const images = blocks.flatMap((block) => {
    if (block.type !== "image") return []
    const bytes = block.source.type === "base64" ? block.source.data : undefined
    if (!bytes) return []
    const format = (block.source.media_type ?? "image/jpeg").split("/").at(-1) ?? "jpeg"
    return [{ format, source: { bytes } } satisfies KiroImage]
  })
  return images.length ? images : undefined
}

function blocksToToolResults(blocks: KiroGatewayBlock[]): KiroToolResult[] | undefined {
  const toolResults = blocks.flatMap((block) => {
    if (block.type !== "tool_result") return []
    return [
      {
        content: [{ text: toolResultContentToText(block.content) || "(empty result)" }],
        status: block.is_error ? "error" : "success",
        toolUseId: block.tool_use_id,
      } satisfies KiroToolResult,
    ]
  })
  return toolResults.length ? toolResults : undefined
}

function blocksToToolUses(blocks: KiroGatewayBlock[]): KiroToolUse[] | undefined {
  const toolUses = blocks.flatMap((block) => {
    if (block.type !== "tool_use") return []
    return [{ name: block.name, input: block.input, toolUseId: block.id } satisfies KiroToolUse]
  })
  return toolUses.length ? toolUses : undefined
}

function normalizeToolsForCurrentMessage(tools?: KiroGatewayTool[]): KiroToolSpecification[] | undefined {
  if (!tools?.length) return undefined
  const converted = tools.flatMap((tool) => {
    if (tool.type === "mcp") return []
    // Convert web_search / web_fetch server tools into regular function tools
    // so the Kiro model receives the schema and can supply the query parameter.
    if (tool.type === "web_search" || tool.type === "web_fetch") {
      return [
        {
          toolSpecification: {
            name: tool.name === "web_search" ? "WebSearch" : tool.name,
            description: tool.description?.trim() || "Search the web for current information. Use when you need up-to-date data from the internet.",
            inputSchema: {
              json: {
                type: "object",
                properties: {
                  query: { type: "string", description: "The search query to execute" },
                },
                required: ["query"],
              },
            },
          },
        } satisfies KiroToolSpecification,
      ]
    }
    const description = tool.description?.trim() || `Tool: ${tool.name}`
    return [
      {
        toolSpecification: {
          name: tool.name,
          description,
          inputSchema: { json: sanitizeJsonSchema(tool.input_schema) },
        },
      } satisfies KiroToolSpecification,
    ]
  })
  return converted.length ? converted : undefined
}

function sanitizeJsonSchema(schema?: JsonObject) {
  if (!schema) return {}
  const result: JsonObject = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties") continue
    if (key === "required" && Array.isArray(value) && value.length === 0) continue
    if (Array.isArray(value)) {
      result[key] = value.map((item) => (isJsonObject(item) ? sanitizeJsonSchema(item) : item))
      continue
    }
    result[key] = isJsonObject(value) ? sanitizeJsonSchema(value) : value
  }
  return result
}

function toolResultContentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item
        if (!item || typeof item !== "object") return ""
        const block = item as { type?: unknown; text?: unknown }
        if (block.type === "text" && typeof block.text === "string") return block.text
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  if (content == null) return ""
  return String(content)
}

function normalizeToolChoice(toolChoice: unknown): string | JsonObject | undefined {
  if (typeof toolChoice === "string") return toolChoice
  return isJsonObject(toolChoice) ? toolChoice : undefined
}

function injectThinking(content: string, thinking?: KiroGatewayInput["thinking"]) {
  if (!thinking?.enabled) return content
  const budget = thinking.budgetTokens ?? 4096
  return [
    "<thinking_mode>enabled</thinking_mode>",
    `<max_thinking_length>${budget}</max_thinking_length>`,
    content,
  ].join("\n")
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
