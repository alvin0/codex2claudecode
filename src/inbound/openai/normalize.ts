import type { Canonical_Request } from "../../core/canonical"
import { normalizeReasoningBody } from "../../core/reasoning"
import type { JsonObject } from "../../core/types"

export function normalizeCanonicalRequest(pathname: string, body: JsonObject): Canonical_Request {
  const normalizedBody = normalizeReasoningBody(body)

  if (pathname === "/v1/chat/completions") {
    const messages = Array.isArray(normalizedBody.messages) ? normalizedBody.messages : []
    const instructions = messages
      .map((message) => instructionFromMessage(message))
      .filter((instruction) => instruction !== undefined)
      .join("\n\n")

    return {
      model: typeof normalizedBody.model === "string" ? normalizedBody.model : "",
      instructions: normalizedBody.instructions ?? (instructions || "You are a helpful assistant."),
      input: messages.map((message) => normalizeMessage(message)).filter((message): message is NonNullable<ReturnType<typeof normalizeMessage>> => message !== undefined),
      tools: Array.isArray(normalizedBody.tools) ? (normalizedBody.tools as JsonObject[]) : undefined,
      toolChoice: normalizedBody.tool_choice as JsonObject | string | undefined,
      include: Array.isArray(normalizedBody.include) ? normalizedBody.include.filter((item): item is string => typeof item === "string") : undefined,
      textFormat: extractTextFormat(normalizedBody.text),
      reasoningEffort: extractReasoningEffort(normalizedBody),
      stream: normalizedBody.stream !== undefined ? Boolean(normalizedBody.stream) : true,
      passthrough: true,
      metadata: { source: "openai", path: pathname },
    }
  }

  if (pathname === "/v1/responses") {
    const input = typeof normalizedBody.input === "string"
      ? [{ role: "user" as const, content: [{ type: "input_text", text: normalizedBody.input }] }]
      : Array.isArray(normalizedBody.input)
        ? normalizedBody.input.filter((message): message is Canonical_Request["input"][number] => {
          return Boolean(message) && typeof message === "object" && !Array.isArray(message) && typeof (message as { role?: unknown }).role === "string" && Array.isArray((message as { content?: unknown }).content)
        })
        : []

    return {
      model: typeof normalizedBody.model === "string" ? normalizedBody.model : "",
      instructions: typeof normalizedBody.instructions === "string" ? normalizedBody.instructions : "You are a helpful assistant.",
      input,
      tools: Array.isArray(normalizedBody.tools) ? (normalizedBody.tools as JsonObject[]) : undefined,
      toolChoice: normalizedBody.tool_choice as JsonObject | string | undefined,
      include: Array.isArray(normalizedBody.include) ? normalizedBody.include.filter((item): item is string => typeof item === "string") : undefined,
      textFormat: extractTextFormat(normalizedBody.text),
      reasoningEffort: extractReasoningEffort(normalizedBody),
      stream: normalizedBody.stream !== undefined ? Boolean(normalizedBody.stream) : true,
      passthrough: true,
      metadata: { source: "openai", path: pathname },
    }
  }

  return {
    model: typeof normalizedBody.model === "string" ? normalizedBody.model : "",
    instructions: typeof normalizedBody.instructions === "string" ? normalizedBody.instructions : undefined,
    input: Array.isArray(normalizedBody.input)
      ? normalizedBody.input.filter((message): message is Canonical_Request["input"][number] => {
        return Boolean(message) && typeof message === "object" && !Array.isArray(message) && typeof (message as { role?: unknown }).role === "string" && Array.isArray((message as { content?: unknown }).content)
      })
      : [],
    stream: normalizedBody.stream !== undefined ? Boolean(normalizedBody.stream) : true,
    passthrough: true,
    metadata: { source: "openai", path: pathname },
  }
}

export function normalizeRequestBody(pathname: string, body: JsonObject): JsonObject {
  const normalizedBody = normalizeReasoningBody(body)

  if (pathname === "/v1/chat/completions") {
    const messages = Array.isArray(normalizedBody.messages) ? normalizedBody.messages : []
    const instructions = messages
      .map((message) => instructionFromMessage(message))
      .filter((instruction) => instruction !== undefined)
      .join("\n\n")

    return {
      ...normalizedBody,
      instructions: normalizedBody.instructions ?? (instructions || "You are a helpful assistant."),
      store: false,
      stream: true,
      messages: undefined,
      input: messages.map((message) => normalizeMessage(message)).filter((message) => message !== undefined),
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

function extractReasoningEffort(body: JsonObject) {
  const reasoning = body.reasoning
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) && typeof (reasoning as JsonObject).effort === "string") {
    return (reasoning as JsonObject).effort as string
  }
  return typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined
}

function instructionFromMessage(message: unknown) {
  if (!message || typeof message !== "object") return
  const item = message as { role?: unknown; content?: unknown }
  if (item.role !== "system" && item.role !== "developer") return
  if (typeof item.content === "string") return item.content
  return JSON.stringify(item.content)
}

function normalizeMessage(message: unknown) {
  if (!message || typeof message !== "object") return

  const item = message as {
    role?: unknown
    content?: unknown
  }
  const role = item.role
  if (role === "system" || role === "developer") return
  if (role !== "user" && role !== "assistant" && role !== "tool") return

  return {
    role,
    content:
      typeof item.content === "string"
        ? [{ type: role === "assistant" ? "output_text" : "input_text", text: item.content }]
        : Array.isArray(item.content)
          ? (item.content as JsonObject[])
          : [],
  }
}
