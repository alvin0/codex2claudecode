import type { JsonObject } from "./types"

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

export function normalizeReasoningBody(body: JsonObject) {
  return {
    ...Object.fromEntries(Object.entries(body).filter((entry) => entry[0] !== "reasoning_effort")),
    ...normalizeReasoningModel(body),
  }
}

function normalizeReasoningModel(body: JsonObject) {
  if (typeof body.model !== "string") return {}

  const match = body.model.match(/^(gpt-5(?:\.[^_]+)?)(?:_(none|low|medium|high|xhigh))?$/)
  if (!match) return {}

  const [, model, effort = "medium"] = match
  const reasoning = body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning) ? body.reasoning : {}

  return {
    model,
    reasoning: {
      ...reasoning,
      effort: (reasoning as JsonObject).effort ?? body.reasoning_effort ?? effort,
    },
  }
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
  if (item.role === "system" || item.role === "developer") return
  const role = item.role
  if (role !== "developer" && role !== "user" && role !== "assistant" && role !== "tool") return

  return {
    role,
    content:
      typeof item.content === "string"
        ? [{ type: role === "assistant" ? "output_text" : "input_text", text: item.content }]
        : item.content,
  }
}
