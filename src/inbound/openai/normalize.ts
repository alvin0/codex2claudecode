import type { Canonical_Request } from "../../core/canonical"
import { normalizeReasoningBody } from "../../core/reasoning"
import type { JsonObject } from "../../core/types"

interface NormalizeOptions {
  passthrough?: boolean
}

export function normalizeCanonicalRequest(pathname: string, body: JsonObject, options: NormalizeOptions = {}): Canonical_Request {
  const normalizedBody = normalizeReasoningBody(body)
  const passthrough = options.passthrough ?? true
  const defaultStream = passthrough

  if (isChatPath(pathname)) {
    const messages = Array.isArray(normalizedBody.messages) ? normalizedBody.messages : []
    const instructions = messages
      .map((message) => instructionFromMessage(message))
      .filter((instruction): instruction is string => Boolean(instruction))
      .join("\n\n")

    return {
      model: typeof normalizedBody.model === "string" ? normalizedBody.model : "",
      instructions: typeof normalizedBody.instructions === "string" ? normalizedBody.instructions : (instructions || "You are a helpful assistant."),
      input: messages.flatMap((message) => normalizeChatMessage(message)),
      tools: normalizeTools(normalizedBody.tools, { passthrough }),
      toolChoice: normalizeToolChoice(normalizedBody.tool_choice),
      include: Array.isArray(normalizedBody.include) ? normalizedBody.include.filter((item): item is string => typeof item === "string") : undefined,
      textFormat: extractTextFormat(normalizedBody.text) ?? extractChatResponseFormat(normalizedBody.response_format),
      reasoningEffort: extractReasoningEffort(normalizedBody),
      stream: normalizedBody.stream !== undefined ? Boolean(normalizedBody.stream) : defaultStream,
      passthrough,
      metadata: { source: "openai", path: pathname },
    }
  }

  if (pathname === "/v1/responses") {
    const instructions = instructionsFromResponsesInput(normalizedBody.input)
    return {
      model: typeof normalizedBody.model === "string" ? normalizedBody.model : "",
      instructions: typeof normalizedBody.instructions === "string" ? normalizedBody.instructions : (instructions || "You are a helpful assistant."),
      input: normalizeResponsesInput(normalizedBody.input),
      tools: normalizeTools(normalizedBody.tools, { passthrough }),
      toolChoice: normalizeToolChoice(normalizedBody.tool_choice),
      include: Array.isArray(normalizedBody.include) ? normalizedBody.include.filter((item): item is string => typeof item === "string") : undefined,
      textFormat: extractTextFormat(normalizedBody.text),
      reasoningEffort: extractReasoningEffort(normalizedBody),
      stream: normalizedBody.stream !== undefined ? Boolean(normalizedBody.stream) : defaultStream,
      passthrough,
      metadata: { source: "openai", path: pathname },
    }
  }

  return {
    model: typeof normalizedBody.model === "string" ? normalizedBody.model : "",
    instructions: typeof normalizedBody.instructions === "string" ? normalizedBody.instructions : undefined,
    input: Array.isArray(normalizedBody.input) ? normalizedBody.input.filter(isCanonicalInputMessage) : [],
    stream: normalizedBody.stream !== undefined ? Boolean(normalizedBody.stream) : defaultStream,
    passthrough,
    metadata: { source: "openai", path: pathname },
  }
}

export function normalizeRequestBody(pathname: string, body: JsonObject): JsonObject {
  const normalizedBody = normalizeReasoningBody(body)

  if (isChatPath(pathname)) {
    const messages = Array.isArray(normalizedBody.messages) ? normalizedBody.messages : []
    const instructions = messages
      .map((message) => instructionFromMessage(message))
      .filter((instruction): instruction is string => Boolean(instruction))
      .join("\n\n")

    return {
      ...normalizedBody,
      instructions: normalizedBody.instructions ?? (instructions || "You are a helpful assistant."),
      store: false,
      stream: true,
      messages: undefined,
      input: messages.flatMap((message) => normalizeChatMessage(message)),
      ...(normalizedBody.response_format ? { text: { format: extractChatResponseFormat(normalizedBody.response_format) } } : {}),
    }
  }

  if (pathname === "/v1/responses" && typeof normalizedBody.input === "string") {
    return {
      ...normalizedBody,
      instructions: normalizedBody.instructions ?? "You are a helpful assistant.",
      store: false,
      stream: true,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: normalizedBody.input }],
        },
      ],
    }
  }

  return { ...normalizedBody, store: normalizedBody.store ?? false, stream: normalizedBody.stream ?? true }
}

function extractTextFormat(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const item = value as { format?: unknown }
  return item.format && typeof item.format === "object" && !Array.isArray(item.format) ? (item.format as JsonObject) : undefined
}

function extractChatResponseFormat(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const item = value as JsonObject
  if (item.type === "json_schema") {
    const jsonSchema = item.json_schema
    if (jsonSchema && typeof jsonSchema === "object" && !Array.isArray(jsonSchema)) {
      return { type: "json_schema", ...(jsonSchema as JsonObject) }
    }
  }
  if (item.type === "json_object") return { type: "json_object" }
}

function extractReasoningEffort(body: JsonObject) {
  const reasoning = body.reasoning
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) && typeof (reasoning as JsonObject).effort === "string") {
    return (reasoning as JsonObject).effort as string
  }
  return typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined
}

function isCanonicalInputMessage(message: unknown): message is Canonical_Request["input"][number] {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false
  const item = message as { role?: unknown; content?: unknown }
  return (
    (item.role === "user" || item.role === "assistant" || item.role === "tool") &&
    Array.isArray(item.content)
  )
}

function normalizeResponsesInput(value: unknown): Canonical_Request["input"] {
  if (typeof value === "string") return [{ role: "user", content: [{ type: "input_text", text: value }] }]
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => normalizeResponsesInputItem(item))
}

function normalizeResponsesInputItem(value: unknown): Canonical_Request["input"] {
  if (!isJsonObject(value)) return []

  if (value.type === "message") {
    const role = canonicalRole(value.role)
    if (!role) return []
    const content = normalizeResponsesMessageContent(value.content, role)
    return content.length ? [{ role, content }] : []
  }

  if (isCanonicalInputMessage(value)) {
    const content = normalizeResponsesMessageContent(value.content, value.role)
    return content.length ? [{ role: value.role, content }] : []
  }
  if (value.type === "function_call") return [{ role: "assistant", content: [normalizeFunctionCallItem(value)] }]
  if (value.type === "function_call_output") return [{ role: "tool", content: [normalizeFunctionCallOutputItem(value)] }]
  if (value.type === "reasoning") return [{ role: "assistant", content: [value] }]
  const role = canonicalRole(value.role)
  if (role) {
    const content = normalizeResponsesMessageContent(value.content, role)
    return content.length ? [{ role, content }] : []
  }
  return []
}

function canonicalRole(value: unknown): Canonical_Request["input"][number]["role"] | undefined {
  return value === "user" || value === "assistant" || value === "tool" ? value : undefined
}

function instructionsFromResponsesInput(value: unknown) {
  if (!Array.isArray(value)) return ""
  return value
    .flatMap((item) => {
      if (!isJsonObject(item)) return []
      if (item.role !== "system" && item.role !== "developer") return []
      return [contentToText(item.content)]
    })
    .filter(Boolean)
    .join("\n\n")
}

function normalizeFunctionCallItem(item: JsonObject): JsonObject {
  const callId = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `call_${crypto.randomUUID().replace(/-/g, "")}`
  return {
    type: "function_call",
    id: typeof item.id === "string" ? item.id : `fc_${crypto.randomUUID().replace(/-/g, "")}`,
    call_id: callId,
    name: typeof item.name === "string" ? item.name : "unknown",
    arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
  }
}

function normalizeFunctionCallOutputItem(item: JsonObject): JsonObject {
  return {
    type: "function_call_output",
    ...(typeof item.id === "string" ? { id: item.id } : {}),
    call_id: typeof item.call_id === "string" ? item.call_id : "call_unknown",
    output: contentToText(item.output),
  }
}

function normalizeResponsesMessageContent(value: unknown, role: Canonical_Request["input"][number]["role"]): JsonObject[] {
  if (role === "tool") {
    if (typeof value === "string") return [{ type: "input_text", text: value }]
    if (isJsonObject(value)) return [normalizeResponsesToolContentItem(value)]
    if (Array.isArray(value)) {
      return value.flatMap((item) => {
        if (typeof item === "string") return [{ type: "input_text", text: item }]
        return isJsonObject(item) ? [normalizeResponsesToolContentItem(item)] : []
      })
    }
    return []
  }
  return normalizeMessageContent(value, role)
}

function normalizeResponsesToolContentItem(item: JsonObject): JsonObject {
  if (item.type === "function_call_output") return normalizeFunctionCallOutputItem(item)
  return item
}

function instructionFromMessage(message: unknown) {
  if (!message || typeof message !== "object") return
  const item = message as { role?: unknown; content?: unknown }
  if (item.role !== "system" && item.role !== "developer") return
  if (typeof item.content === "string") return item.content
  return contentToText(item.content)
}

function normalizeChatMessage(message: unknown): Canonical_Request["input"] {
  if (!message || typeof message !== "object") return []

  const item = message as {
    role?: unknown
    content?: unknown
    tool_call_id?: unknown
    tool_calls?: unknown
  }
  const role = item.role
  if (role === "system" || role === "developer") return []
  if (role !== "user" && role !== "assistant" && role !== "tool") return []

  if (role === "tool") {
    const output = contentToText(item.content)
    return [{
      role,
      content: typeof item.tool_call_id === "string"
        ? [{ type: "function_call_output", call_id: item.tool_call_id, output }]
        : [{ type: "input_text", text: output }],
    }]
  }

  const content = normalizeMessageContent(item.content, role)

  if (role === "assistant" && Array.isArray(item.tool_calls)) {
    content.push(...item.tool_calls.flatMap((toolCall) => normalizeChatToolCall(toolCall)))
  }

  return [{ role, content }]
}

function normalizeChatToolCall(value: unknown): JsonObject[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const item = value as JsonObject
  const fn = item.function && typeof item.function === "object" && !Array.isArray(item.function) ? item.function as JsonObject : undefined
  const callId = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : `call_${crypto.randomUUID().replace(/-/g, "")}`
  const name = typeof fn?.name === "string" ? fn.name : typeof item.name === "string" ? item.name : "unknown"
  const rawArguments = fn?.arguments ?? item.arguments ?? {}
  const args = typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments)
  return [{ type: "function_call", id: typeof item.id === "string" ? item.id : `fc_${crypto.randomUUID().replace(/-/g, "")}`, call_id: callId, name, arguments: args }]
}

function normalizeMessageContent(value: unknown, role: "user" | "assistant"): JsonObject[] {
  if (typeof value === "string") return [chatTextBlock(role, value)]
  if (isJsonObject(value)) return normalizeMessageContentPart(value, role)
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => normalizeMessageContentPart(item, role))
}

function normalizeMessageContentPart(value: unknown, role: "user" | "assistant"): JsonObject[] {
  if (typeof value === "string") return [chatTextBlock(role, value)]
  if (!isJsonObject(value)) return []

  if (value.type === "text" && typeof value.text === "string") return [chatTextBlock(role, value.text)]
  if (value.type === "refusal" && typeof value.refusal === "string") return [chatTextBlock(role, value.refusal)]

  if (value.type === "image_url") {
    const image = value.image_url
    const imageUrl = typeof image === "string" ? image : isJsonObject(image) && typeof image.url === "string" ? image.url : undefined
    if (!imageUrl) return []
    return [{
      type: "input_image",
      image_url: imageUrl,
      ...(isJsonObject(image) && typeof image.detail === "string" ? { detail: image.detail } : {}),
    }]
  }

  return [value]
}

function chatTextBlock(role: "user" | "assistant", text: string): JsonObject {
  return { type: role === "assistant" ? "output_text" : "input_text", text }
}

function normalizeTools(value: unknown, options: { passthrough: boolean }): JsonObject[] | undefined {
  if (!Array.isArray(value)) return
  if (options.passthrough) return value as JsonObject[]
  return value.flatMap((tool) => normalizeTool(tool))
}

function normalizeTool(value: unknown): JsonObject[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const item = value as JsonObject
  if (item.type === "web_search" || item.type === "web_search_preview") return [{ type: "web_search" }]

  if (item.type === "function") {
    const fn = item.function && typeof item.function === "object" && !Array.isArray(item.function) ? item.function as JsonObject : undefined
    if (fn) {
      return [{
        type: "function",
        name: typeof fn.name === "string" ? fn.name : "unknown",
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        parameters: isJsonObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
        ...(typeof item.strict === "boolean" ? { strict: item.strict } : typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
      }]
    }
  }

  return [item]
}

function normalizeToolChoice(value: unknown): JsonObject | string | undefined {
  if (typeof value === "string") return value
  if (!isJsonObject(value)) return
  if (value.type === "auto" || value.type === "none" || value.type === "required") return value.type
  if (value.type === "web_search_preview") return { type: "web_search" }
  if (value.type === "tool" && typeof value.name === "string") return { type: "function", name: value.name }
  return value
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) {
    if (value === undefined || value === null) return ""
    if (isJsonObject(value)) {
      if (typeof value.text === "string") return value.text
      if (typeof value.refusal === "string") return value.refusal
      if (typeof value.output === "string") return value.output
      if (typeof value.content === "string") return value.content
      if (Array.isArray(value.content)) return contentToText(value.content)
    }
    return JSON.stringify(value)
  }
  return value.map((item) => {
    if (typeof item === "string") return item
    if (!isJsonObject(item)) return ""
    if (typeof item.text === "string") return item.text
    if (typeof item.refusal === "string") return item.refusal
    if (typeof item.output === "string") return item.output
    if (typeof item.content === "string") return item.content
    if (Array.isArray(item.content)) return contentToText(item.content)
    return JSON.stringify(item)
  }).filter(Boolean).join("\n")
}

function isChatPath(pathname: string) {
  return pathname === "/v1/chat/completions"
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
