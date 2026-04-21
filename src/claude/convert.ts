import type { ClaudeMessagesRequest, JsonObject } from "../types"

export function claudeToResponsesBody(body: ClaudeMessagesRequest): JsonObject {
  const tools = body.tools?.length ? claudeToolsToResponsesTools(body.tools) : undefined
  const hasWebTool = tools?.some((tool) => tool.type === "web_search")
  const textFormat = claudeOutputFormatToResponsesTextFormat(body.output_config?.format)

  return {
    model: body.model,
    ...(body.output_config?.effort && { reasoning_effort: body.output_config.effort }),
    instructions: [
      claudeSystemToText(body.system) || "You are a helpful assistant.",
      hasWebTool
        ? "When web search is available and the user asks for current or recent information, use web search internally and answer directly with the found information. Do not respond that you are going to search."
        : undefined,
    ]
      .filter((item) => item !== undefined)
      .join("\n\n"),
    input: body.messages.flatMap(claudeMessageToResponsesInput),
    store: false,
    stream: true,
    ...(textFormat && { text: { format: textFormat } }),
    ...(tools && { tools }),
    ...(hasWebTool && { include: ["web_search_call.action.sources"] }),
    ...(body.tool_choice && { tool_choice: claudeToolChoiceToResponsesToolChoice(body.tool_choice) }),
  }
}

function claudeMessageToResponsesInput(message: ClaudeMessagesRequest["messages"][number]) {
  const blocks = claudeContentToResponsesBlocks(message.role, message.content)
  const messageContent = blocks.filter((block) => block.kind === "content").map((block) => block.value)
  return [
    ...(messageContent.length
      ? [
          {
            role: message.role,
            content: messageContent,
          },
        ]
      : []),
    ...blocks.filter((block) => block.kind === "item").map((block) => block.value),
  ]
}

function claudeToolToResponsesTool(tool: NonNullable<ClaudeMessagesRequest["tools"]>[number]) {
  if (isClaudeWebTool(tool)) {
    return {
      type: "web_search",
      ...(tool.allowed_domains?.length && { filters: { allowed_domains: tool.allowed_domains } }),
      ...(tool.user_location && { user_location: claudeUserLocationToResponsesUserLocation(tool.user_location) }),
    }
  }

  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema ?? { type: "object", properties: {} },
    strict: tool.strict ?? false,
  }
}

function claudeOutputFormatToResponsesTextFormat(format: ClaudeMessagesRequest["output_config"] extends { format?: infer T } ? T : never) {
  if (!format || format.type !== "json_schema" || !format.schema) return
  return {
    type: "json_schema",
    name: format.name ?? outputSchemaName(format.schema),
    schema: format.schema,
    strict: format.strict ?? true,
  }
}

function outputSchemaName(schema: JsonObject) {
  if (typeof schema.title === "string" && schema.title.trim()) return sanitizeSchemaName(schema.title)
  return "structured_output"
}

function sanitizeSchemaName(value: string) {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return sanitized || "structured_output"
}

function isClaudeWebTool(tool: Pick<NonNullable<ClaudeMessagesRequest["tools"]>[number], "name" | "type">) {
  return [tool.name, tool.type].some((value) => typeof value === "string" && /^web_(search|fetch)(?:_\d+)?$/.test(value))
}

function claudeUserLocationToResponsesUserLocation(userLocation: JsonObject) {
  return {
    type: "approximate",
    approximate: Object.fromEntries(
      ["city", "region", "country", "timezone"].flatMap((key) =>
        typeof userLocation[key] === "string" ? [[key, userLocation[key]] as const] : [],
      ),
    ),
  }
}

function claudeToolsToResponsesTools(tools: NonNullable<ClaudeMessagesRequest["tools"]>) {
  return tools
    .map((tool) => claudeToolToResponsesTool(tool))
    .filter(
      (tool, index, mapped) =>
        tool.type !== "web_search" || mapped.findIndex((item) => item.type === "web_search") === index,
    )
}

function claudeToolChoiceToResponsesToolChoice(toolChoice: NonNullable<ClaudeMessagesRequest["tool_choice"]>) {
  if (toolChoice.type === "any") return "required"
  if (toolChoice.type === "tool" && typeof toolChoice.name === "string" && /^web_(search|fetch)(?:_\d+)?$/.test(toolChoice.name)) {
    return { type: "web_search" }
  }
  if (toolChoice.type === "tool" && toolChoice.name) return { type: "function", name: toolChoice.name }
  return "auto"
}

export function estimateClaudeInputTokens(body: ClaudeMessagesRequest) {
  const text = [
    claudeSystemToText(body.system),
    ...body.messages.flatMap((message) => extractTextFromClaudeContent(message.content)),
    ...(body.tools ?? []).flatMap((tool) => [tool.name, tool.description, JSON.stringify(tool.input_schema ?? {})]),
  ]
    .filter((item) => typeof item === "string")
    .join("\n")

  return Math.max(1, Math.ceil(text.length / 4))
}

function extractTextFromClaudeContent(content: unknown): string[] {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return [String(content)]
  return content.flatMap((part) => {
    if (typeof part === "string") return [part]
    if (!part || typeof part !== "object") return []
    const item = part as { type?: unknown; text?: unknown; content?: unknown }
    if (item.type === "text" && typeof item.text === "string") return [item.text]
    if (item.type === "tool_result") return extractTextFromClaudeContent(item.content)
    return []
  })
}

function claudeSystemToText(system: unknown) {
  if (!system) return
  if (typeof system === "string") return filterClaudeSystemText(system)
  if (!Array.isArray(system)) return JSON.stringify(system)
  return system
    .map((part) => {
      if (typeof part === "string") return part
      if (!part || typeof part !== "object") return
      const item = part as { type?: unknown; text?: unknown }
      if (item.type === "text" && typeof item.text === "string") return item.text
      return
    })
    .filter((part) => part !== undefined)
    .map(filterClaudeSystemText)
    .filter((part) => part !== undefined)
    .join("\n\n")
}

function filterClaudeSystemText(text: string) {
  const normalized = text.trim()
  if (!normalized) return
  if (normalized.startsWith("x-anthropic-billing-header:")) return
  if (normalized === "You are Claude Code, Anthropic's official CLI for Claude.") return
  return text
}

function claudeContentToResponsesBlocks(role: "user" | "assistant", content: unknown) {
  if (typeof content === "string") {
    return [{ kind: "content" as const, value: { type: role === "assistant" ? "output_text" : "input_text", text: content } }]
  }

  if (!Array.isArray(content)) {
    return [
      {
        kind: "content" as const,
        value: { type: role === "assistant" ? "output_text" : "input_text", text: String(content) },
      },
    ]
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return {
          kind: "content" as const,
          value: { type: role === "assistant" ? "output_text" : "input_text", text: part },
        }
      }
      if (!part || typeof part !== "object") return

      const item = part as {
        type?: unknown
        text?: unknown
        title?: unknown
        source?: {
          type?: unknown
          media_type?: unknown
          data?: unknown
          url?: unknown
        }
      }

      if (item.type === "text" && typeof item.text === "string") {
        return {
          kind: "content" as const,
          value: { type: role === "assistant" ? "output_text" : "input_text", text: item.text },
        }
      }

      if (item.type === "tool_use" && typeof (item as { id?: unknown }).id === "string") {
        return {
          kind: "item" as const,
          value: {
            type: "function_call",
            call_id: (item as { id: string }).id,
            name: (item as { name?: unknown }).name ?? "unknown",
            arguments: JSON.stringify((item as { input?: unknown }).input ?? {}),
          },
        }
      }

      if (item.type === "tool_result" && typeof (item as { tool_use_id?: unknown }).tool_use_id === "string") {
        return {
          kind: "item" as const,
          value: {
            type: "function_call_output",
            call_id: (item as { tool_use_id: string }).tool_use_id,
            output: toolResultToText(item),
          },
        }
      }

      if (role === "user" && item.type === "image" && item.source?.type === "base64") {
        return {
          kind: "content" as const,
          value: {
            type: "input_image",
            image_url: `data:${item.source.media_type};base64,${item.source.data}`,
          },
        }
      }

      if (role === "user" && item.type === "image" && item.source?.type === "url") {
        return {
          kind: "content" as const,
          value: {
            type: "input_image",
            image_url: item.source.url,
          },
        }
      }

      if (role === "user" && item.type === "document" && item.source?.type === "base64") {
        return {
          kind: "content" as const,
          value: {
            type: "input_file",
            filename: typeof item.title === "string" ? item.title : "document.pdf",
            file_data: `data:${item.source.media_type};base64,${item.source.data}`,
          },
        }
      }

      return
    })
    .filter((part) => part !== undefined)
}

function toolResultToText(item: { content?: unknown; is_error?: unknown }) {
  const content = item.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (!part || typeof part !== "object") return ""
        const block = part as { type?: unknown; text?: unknown }
        if (block.type === "text" && typeof block.text === "string") return block.text
        return JSON.stringify(part)
      })
      .filter((part) => part.length > 0)
      .join("\n")
  }
  return JSON.stringify(content ?? "")
}
