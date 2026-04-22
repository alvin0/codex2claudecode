import type {
  ChatCompletionRequest,
  ClaudeMessagesRequest,
  ClaudeToolDefinition,
  ClaudeThinkingConfig,
  JsonObject,
  OpenAIChatToolCall,
  OpenAIChatToolDefinition,
} from "../../../types"

import type { KiroGatewayBlock, KiroGatewayMessage, KiroGatewayTool, KiroThinkingConfig } from "./types"

export function normalizeAnthropicRequest(body: ClaudeMessagesRequest) {
  return {
    system: extractAnthropicSystemText(body.system),
    messages: ensureAlternating(normalizeAnthropicMessages(body.messages)),
    tools: normalizeAnthropicTools(body.tools),
    toolChoice: body.tool_choice,
    thinking: normalizeAnthropicThinking(body.thinking),
  }
}

export function normalizeOpenAiRequest(body: ChatCompletionRequest) {
  const systemParts: string[] = []
  const messages: KiroGatewayMessage[] = []

  for (const message of body.messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = extractTextContent(message.content)
      if (text) systemParts.push(text)
      continue
    }

    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id ?? "",
            content: message.content,
          },
          ...extractImages(message.content),
        ],
      })
      continue
    }

    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: [...extractTextAndImages(message.content), ...normalizeOpenAiToolCalls(message.tool_calls)],
      })
      continue
    }

    if (message.role === "user") {
      messages.push({
        role: "user",
        content: extractTextAndImages(message.content),
      })
    }
  }

  return {
    system: systemParts.join("\n\n"),
    messages: ensureAlternating(messages),
    tools: normalizeOpenAiTools(body.tools),
    toolChoice: body.tool_choice,
    thinking: normalizeOpenAiThinking(body.reasoning_effort),
  }
}

function normalizeAnthropicMessages(messages: ClaudeMessagesRequest["messages"]) {
  return messages.map((message) => ({
    role: message.role,
    content: normalizeAnthropicContent(message.role, message.content),
  }))
}

function normalizeAnthropicContent(role: "user" | "assistant", content: unknown): KiroGatewayBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!Array.isArray(content)) return [{ type: "text", text: content == null ? "" : String(content) }]

  const blocks: KiroGatewayBlock[] = []
  for (const item of content) {
    if (typeof item === "string") {
      blocks.push({ type: "text", text: item })
      continue
    }
    if (!item || typeof item !== "object") continue
    const block = item as {
      type?: unknown
      text?: unknown
      source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown }
      id?: unknown
      name?: unknown
      input?: unknown
      tool_use_id?: unknown
      content?: unknown
      thinking?: unknown
    }

    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text })
      continue
    }

    if (block.type === "image" && block.source && typeof block.source === "object") {
      if (block.source.type === "base64" && typeof block.source.data === "string") {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: typeof block.source.media_type === "string" ? block.source.media_type : "image/jpeg",
            data: block.source.data,
          },
        })
      } else if (block.source.type === "url" && typeof block.source.url === "string") {
        blocks.push({
          type: "image",
          source: {
            type: "url",
            url: block.source.url,
          },
        })
      }
      continue
    }

    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: asJsonObject(block.input),
      })
      continue
    }

    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      blocks.push({
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
      })
      blocks.push(...extractImages(block.content))
      continue
    }

    if (role === "assistant" && block.type === "thinking" && typeof block.thinking === "string") {
      blocks.push({ type: "thinking", thinking: block.thinking })
    }
  }
  return blocks
}

function extractTextAndImages(content: unknown): KiroGatewayBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!Array.isArray(content)) return [{ type: "text", text: content == null ? "" : String(content) }]

  const blocks: KiroGatewayBlock[] = []
  for (const item of content) {
    if (typeof item === "string") {
      blocks.push({ type: "text", text: item })
      continue
    }
    if (!item || typeof item !== "object") continue
    const block = item as {
      type?: unknown
      text?: unknown
      image_url?: { url?: unknown }
    }

    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text })
      continue
    }

    if (block.type === "image_url" && block.image_url && typeof block.image_url.url === "string") {
      const value = block.image_url.url
      if (value.startsWith("data:")) {
        const [prefix, data] = value.split(",", 2)
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: prefix.slice(5).split(";")[0] || "image/jpeg",
            data,
          },
        })
      } else {
        blocks.push({
          type: "image",
          source: {
            type: "url",
            url: value,
          },
        })
      }
    }
  }
  return blocks
}

function extractImages(content: unknown): KiroGatewayBlock[] {
  return extractTextAndImages(content).filter((block) => block.type === "image")
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : String(content)

  return content
    .map((item) => {
      if (typeof item === "string") return item
      if (!item || typeof item !== "object") return ""
      const block = item as { type?: unknown; text?: unknown; content?: unknown }
      if (block.type === "text" && typeof block.text === "string") return block.text
      if (block.type === "tool_result") return extractTextContent(block.content)
      return ""
    })
    .filter(Boolean)
    .join("")
}

function normalizeOpenAiToolCalls(toolCalls?: OpenAIChatToolCall[]) {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls.flatMap((toolCall) => {
    if (toolCall.type !== "function") return []
    return [
      {
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.function.name,
        input: parseJson(toolCall.function.arguments),
      } satisfies KiroGatewayBlock,
    ]
  })
}

function normalizeAnthropicTools(tools?: ClaudeToolDefinition[]) {
  if (!Array.isArray(tools)) return undefined
  const normalized: KiroGatewayTool[] = tools.map((tool) => ({
    type: isWebTool(tool) ? (tool.name.startsWith("web_fetch") ? "web_fetch" : "web_search") : "function",
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
    allowed_domains: tool.allowed_domains,
    blocked_domains: tool.blocked_domains,
    user_location: tool.user_location,
  }))
  return normalized.length ? normalized : undefined
}

function normalizeOpenAiTools(tools?: OpenAIChatToolDefinition[]) {
  if (!Array.isArray(tools)) return undefined
  const normalized: KiroGatewayTool[] = []
  for (const tool of tools) {
    if (tool.type === "web_search") {
      normalized.push({
        type: "web_search",
        name: "web_search",
        description: "Search the web for current information",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        allowed_domains: tool.allowed_domains,
        blocked_domains: tool.blocked_domains,
        user_location: tool.user_location,
      })
      continue
    }

    if (tool.type === "function" && tool.function) {
      normalized.push({
        type: tool.function.name === "web_search" ? "web_search" : "function",
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
        allowed_domains: tool.allowed_domains,
        blocked_domains: tool.blocked_domains,
        user_location: tool.user_location,
      })
    }
  }
  return normalized.length ? normalized : undefined
}

function normalizeAnthropicThinking(thinking?: ClaudeThinkingConfig) {
  if (!thinking) return { enabled: false } satisfies KiroThinkingConfig
  return {
    enabled: thinking.type === "enabled" || typeof thinking.budget_tokens === "number",
    budgetTokens: thinking.budget_tokens,
  } satisfies KiroThinkingConfig
}

function normalizeOpenAiThinking(reasoningEffort?: ChatCompletionRequest["reasoning_effort"]) {
  if (!reasoningEffort) return { enabled: false } satisfies KiroThinkingConfig
  if (reasoningEffort === "none") return { enabled: false } satisfies KiroThinkingConfig
  const percentage = {
    low: 0.2,
    medium: 0.5,
    high: 0.8,
    xhigh: 0.95,
  } as const
  return {
    enabled: true,
    budgetTokens: Math.round(4096 * (percentage[reasoningEffort] ?? 0.5)),
  } satisfies KiroThinkingConfig
}

function extractAnthropicSystemText(system: ClaudeMessagesRequest["system"]) {
  if (typeof system === "string") return system
  if (!Array.isArray(system)) return system == null ? "" : String(system)
  return system
    .map((item) => {
      if (typeof item === "string") return item
      if (!item || typeof item !== "object") return ""
      const block = item as { type?: unknown; text?: unknown }
      return block.type === "text" && typeof block.text === "string" ? block.text : ""
    })
    .filter(Boolean)
    .join("\n\n")
}

function ensureAlternating(messages: KiroGatewayMessage[]) {
  if (!messages.length) return []

  const normalized = mergeAdjacentMessages(messages)
  if (normalized[0]?.role !== "user") normalized.unshift({ role: "user", content: [{ type: "text", text: "(empty)" }] })

  const result: KiroGatewayMessage[] = []
  for (const message of normalized) {
    const previous = result.at(-1)
    if (!previous || previous.role !== message.role) {
      result.push(message)
      continue
    }
    result.push({
      role: previous.role === "user" ? "assistant" : "user",
      content: [{ type: "text", text: "(empty)" }],
    })
    result.push(message)
  }
  return result
}

function mergeAdjacentMessages(messages: KiroGatewayMessage[]) {
  const result: KiroGatewayMessage[] = []
  for (const message of messages) {
    const previous = result.at(-1)
    if (!previous || previous.role !== message.role) {
      result.push({ ...message, content: [...message.content] })
      continue
    }
    previous.content.push(...message.content)
  }
  return result
}

function isWebTool(tool: Pick<ClaudeToolDefinition, "name" | "type">) {
  return [tool.name, tool.type].some((value) => typeof value === "string" && /^web_(search|fetch)(?:_\d+)?$/.test(value))
}

function parseJson(input: string) {
  try {
    return asJsonObject(JSON.parse(input))
  } catch {
    return {}
  }
}

function asJsonObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {}
}
