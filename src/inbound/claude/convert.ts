import { countTokens, encodeChat } from "gpt-tokenizer"

import type { Canonical_Request } from "../../core/canonical"
import { canonicalToCodexBody } from "../../upstream/codex/parse"
import type { ClaudeMessagesRequest, JsonObject } from "../types"

import { claudeToolChoiceToResponsesToolChoice, resolveClaudeTools } from "./server-tools"

export function claudeToResponsesBody(body: ClaudeMessagesRequest): JsonObject {
  return canonicalToCodexBody(claudeToCanonicalRequest(body))
}

export function claudeToCanonicalRequest(body: ClaudeMessagesRequest): Canonical_Request {
  const resolvedTools = resolveClaudeTools(body)
  const textFormat = claudeOutputFormatToResponsesTextFormat(body.output_config?.format)

  return {
    model: body.model,
    ...(body.output_config?.effort && { reasoningEffort: body.output_config.effort }),
    instructions: [
      claudeSystemToText(body.system) || "You are a helpful assistant.",
      resolvedTools.hasWebTool
        ? "When web search is available and the user asks for current or recent information, use web search internally and answer directly with the found information. Do not respond that you are going to search."
        : undefined,
    ]
      .filter((item) => item !== undefined)
      .join("\n\n"),
    input: body.messages.flatMap((message) => {
      const blocks = claudeContentToResponsesBlocks(message.role, message.content)
      const messageContent = blocks.filter((block) => block.kind === "content").map((block) => block.value)
      const itemMessages = blocks
        .filter((block) => block.kind === "item")
        .map((block) => ({
          role: block.value.type === "function_call_output" ? "tool" : "assistant",
          content: [block.value],
        } as const))
      return [
        ...(messageContent.length ? [{ role: message.role, content: messageContent } as const] : []),
        ...itemMessages,
      ]
    }),
    stream: body.stream ?? true,
    passthrough: false,
    metadata: { source: "claude" },
    ...(textFormat && { textFormat }),
    ...(resolvedTools.tools && { tools: resolvedTools.tools }),
    ...(resolvedTools.include && { include: resolvedTools.include }),
    ...(body.tool_choice && { toolChoice: claudeToolChoiceToResponsesToolChoice(body.tool_choice, resolvedTools) }),
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

function claudeOutputFormatToResponsesTextFormat(
  format: ClaudeMessagesRequest["output_config"] extends infer T
    ? T extends { format?: unknown }
      ? T["format"]
      : never
    : never,
) {
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


export function countClaudeInputTokens(body: ClaudeMessagesRequest) {
  const chat = claudeToTokenizerChat(body)
  const tokenizerModel = resolveTokenizerModel(body.model)
  const extraText = [
    serializeSupplementalInput("tools", body.tools),
    serializeSupplementalInput("mcp_servers", body.mcp_servers),
    serializeSupplementalInput("output_format", body.output_config?.format),
    serializeSupplementalInput("thinking", body.thinking),
    serializeSupplementalInput("tool_choice", body.tool_choice),
  ]
    .filter((item) => item !== undefined)
    .join("\n\n")

  const chatTokens = countClaudeChatTokens(chat, tokenizerModel)
  const extraTokens = extraText ? countTokens(extraText) : 0

  return Math.max(1, chatTokens + extraTokens)
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

function claudeToTokenizerChat(body: ClaudeMessagesRequest) {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = []
  const system = claudeSystemToText(body.system)
  if (system) messages.push({ role: "system", content: system })

  for (const message of body.messages) {
    const content = claudeContentToTokenizerText(message.role, message.content)
    if (!content) continue

    const previous = messages.at(-1)
    if (previous?.role === message.role) {
      previous.content = `${previous.content}\n\n${content}`
      continue
    }

    messages.push({ role: message.role, content })
  }

  return messages
}

function countClaudeChatTokens(
  chat: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  model?: Parameters<typeof encodeChat>[1],
) {
  if (chat.length === 0) return 0

  if (model) {
    try {
      return encodeChat(chat, model).length
    } catch {
      // Fall back to plain-text tokenization for unknown chat formats.
    }
  }

  return countTokens(chat.map((message) => `${message.role}: ${message.content}`).join("\n\n"))
}

function resolveTokenizerModel(model: unknown): Parameters<typeof encodeChat>[1] {
  if (typeof model !== "string") return
  const normalized = model.replace(/_(none|low|medium|high|xhigh)$/, "")

  if (/^gpt-5(?:\.[^-_]+)?-codex$/.test(normalized)) return "gpt-5-codex"
  if (/^gpt-5(?:\.[^-_]+)?-mini$/.test(normalized)) return "gpt-5-mini"
  if (/^gpt-5(?:\.[^-_]+)?-nano$/.test(normalized)) return "gpt-5-nano"
  if (/^gpt-5(?:\.[^_]+)?$/.test(normalized)) return "gpt-5"
  if (/^gpt-4\.1(?:-mini|-nano)?$/.test(normalized)) return normalized as Parameters<typeof encodeChat>[1]
  if (/^gpt-4o(?:-mini)?$/.test(normalized)) return normalized as Parameters<typeof encodeChat>[1]
  if (/^o1(?:-mini|-preview|-pro)?$/.test(normalized)) return normalized as Parameters<typeof encodeChat>[1]
  if (/^o3(?:-mini|-pro)?$/.test(normalized)) return normalized as Parameters<typeof encodeChat>[1]
  if (normalized === "o4-mini") return normalized
}

function claudeContentToTokenizerText(role: "user" | "assistant", content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return stringifyUnknown(content)

  return content
    .flatMap((part) => claudeContentPartToTokenizerText(role, part))
    .filter((part) => part.length > 0)
    .join("\n")
}

function claudeContentPartToTokenizerText(role: "user" | "assistant", part: unknown): string[] {
  if (typeof part === "string") return [part]
  if (!part || typeof part !== "object") return []

  const item = part as {
    type?: unknown
    text?: unknown
    name?: unknown
    id?: unknown
    input?: unknown
    tool_use_id?: unknown
    server_name?: unknown
    title?: unknown
    content?: unknown
    source?: {
      type?: unknown
      media_type?: unknown
      data?: unknown
      url?: unknown
      file_id?: unknown
      content?: unknown
    }
  }

  if (item.type === "text" && typeof item.text === "string") return [item.text]

  if (item.type === "tool_use" || item.type === "mcp_tool_use") {
    return [
      [
        item.type === "mcp_tool_use" ? "mcp_tool_use" : "tool_use",
        typeof item.name === "string" ? item.name : "unknown",
        typeof item.server_name === "string" ? `server=${item.server_name}` : undefined,
        typeof item.id === "string" ? `id=${item.id}` : undefined,
        stringifyUnknown(item.input),
      ]
        .filter((value) => value !== undefined && value.length > 0)
        .join(" "),
    ]
  }

  if (item.type === "tool_result" || item.type === "mcp_tool_result") {
    const toolResult = toolResultToText(item as { content?: unknown; is_error?: unknown })
    return [
      [
        item.type === "mcp_tool_result" ? "mcp_tool_result" : "tool_result",
        typeof item.tool_use_id === "string" ? `tool_use_id=${item.tool_use_id}` : undefined,
        toolResult,
      ]
        .filter((value) => value !== undefined && value.length > 0)
        .join("\n"),
    ]
  }

  if (role === "user" && item.type === "image") {
    if (item.source?.type === "url" && typeof item.source.url === "string") return [`image url=${item.source.url}`]
    return [`image media_type=${stringifyUnknown(item.source?.media_type)}`]
  }

  if (role === "user" && item.type === "document") {
    const title = typeof item.title === "string" ? item.title : "document"
    if (item.source?.type === "url" && typeof item.source.url === "string") return [`document title=${title} url=${item.source.url}`]
    if (item.source?.type === "file" && typeof item.source.file_id === "string") return [`document title=${title} file_id=${item.source.file_id}`]
    if (item.source?.type === "text") return [`document title=${title}`, stringifyUnknown((item.source as { data?: unknown }).data)]
    if (item.source?.type === "content") return [`document title=${title}`, ...extractDocumentSourceText(item.source.content)]
    return [`document title=${title} media_type=${stringifyUnknown(item.source?.media_type)}`]
  }

  return [stringifyUnknown(part)]
}

function extractDocumentSourceText(content: unknown): string[] {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return [stringifyUnknown(content)]

  return content.flatMap((part) => {
    if (typeof part === "string") return [part]
    if (!part || typeof part !== "object") return []
    const item = part as { type?: unknown; text?: unknown }
    if (item.type === "text" && typeof item.text === "string") return [item.text]
    return [stringifyUnknown(part)]
  })
}

function serializeSupplementalInput(label: string, value: unknown) {
  if (value === undefined) return
  if (Array.isArray(value) && value.length === 0) return
  return `${label}: ${stringifyUnknown(value)}`
}

function stringifyUnknown(value: unknown) {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
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
          file_id?: unknown
          content?: unknown
        }
      }

      if (item.type === "text" && typeof item.text === "string") {
        return {
          kind: "content" as const,
          value: { type: role === "assistant" ? "output_text" : "input_text", text: item.text },
        }
      }

      if ((item.type === "tool_use" || item.type === "mcp_tool_use") && typeof (item as { id?: unknown }).id === "string") {
        const toolUseId = (item as { id: string }).id
        return {
          kind: "item" as const,
          value: {
            type: item.type === "mcp_tool_use" ? "mcp_call" : "function_call",
            id: item.type === "mcp_tool_use" ? toolUseId : claudeFunctionCallItemId(toolUseId),
            call_id: toolUseId,
            name: (item as { name?: unknown }).name ?? "unknown",
            server_label: item.type === "mcp_tool_use" ? (item as { server_name?: unknown }).server_name ?? "unknown" : undefined,
            arguments: JSON.stringify((item as { input?: unknown }).input ?? {}),
          },
        }
      }

      if ((item.type === "tool_result" || item.type === "mcp_tool_result") && typeof (item as { tool_use_id?: unknown }).tool_use_id === "string") {
        return {
          kind: "item" as const,
          value: {
            type: item.type === "mcp_tool_result" ? "mcp_call_output" : "function_call_output",
            call_id: (item as { tool_use_id: string }).tool_use_id,
            output: toolResultToText(item as { content?: unknown; is_error?: unknown }),
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

      if (role === "user" && item.type === "document") return claudeDocumentToResponsesBlock(item)

      return
    })
    .filter((part) => part !== undefined)
}

function claudeDocumentToResponsesBlock(item: {
  title?: unknown
  source?: {
    type?: unknown
    media_type?: unknown
    data?: unknown
    url?: unknown
    file_id?: unknown
    content?: unknown
  }
}) {
  const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : "document.pdf"
  const source = item.source
  if (!source || typeof source !== "object") throw new Error("Claude document source is required")

  if (source.type === "base64" && typeof source.data === "string") {
    const data = source.data.trim()
    if (!data) throw new Error("Claude document base64 source requires data")
    const mediaType = typeof source.media_type === "string" && source.media_type.trim() ? source.media_type.trim() : "application/pdf"
    return {
      kind: "content" as const,
      value: {
        type: "input_file",
        filename: title,
        file_data: data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`,
      },
    }
  }

  if (source.type === "url") {
    if (typeof source.url !== "string" || !source.url.trim()) throw new Error("Claude document URL source requires url")
    return {
      kind: "content" as const,
      value: {
        type: "input_file",
        file_url: source.url.trim(),
      },
    }
  }

  if (source.type === "file") {
    if (typeof source.file_id !== "string" || !source.file_id.trim()) throw new Error("Claude document file source requires file_id")
    const fileId = source.file_id.trim()
    if (!fileId.startsWith("file-")) {
      throw new Error("Claude Files API document source cannot be proxied unless file_id is an OpenAI file id")
    }
    return {
      kind: "content" as const,
      value: {
        type: "input_file",
        file_id: fileId,
      },
    }
  }

  if (source.type === "text" && typeof source.data === "string") {
    return {
      kind: "content" as const,
      value: { type: "input_text", text: `Document: ${title}\n\n${source.data}` },
    }
  }

  if (source.type === "content") {
    const text = extractDocumentSourceText(source.content).join("\n")
    if (!text) throw new Error("Claude document content source requires content")
    return {
      kind: "content" as const,
      value: { type: "input_text", text: `Document: ${title}\n\n${text}` },
    }
  }

  throw new Error(`Unsupported Claude document source type: ${stringifyUnknown(source.type) || "missing"}`)
}

function claudeFunctionCallItemId(id: string) {
  if (id.startsWith("fc")) return id
  return `fc_${id.replace(/[^A-Za-z0-9]/g, "")}`
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
