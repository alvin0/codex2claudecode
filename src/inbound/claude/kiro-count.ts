import { countTokens } from "gpt-tokenizer"

import type { ClaudeMessagesRequest, ClaudeTool } from "./types"

const CLAUDE_CORRECTION_FACTOR = 1.15

export function countKiroClaudeInputTokens(body: ClaudeMessagesRequest) {
  return countKiroRequestTokens(body)
}

function countKiroRequestTokens(body: ClaudeMessagesRequest) {
  return corrected(countMessagesTokens(body.messages))
    + corrected(countSystemTokens(body.system))
    + corrected(countToolsTokens(body.tools))
    + corrected(countSupplementalInputTokens("mcp_servers", body.mcp_servers))
    + corrected(countSupplementalInputTokens("output_format", body.output_config?.format))
    + corrected(countSupplementalInputTokens("thinking", body.thinking))
    + corrected(countSupplementalInputTokens("tool_choice", body.tool_choice))
}

function corrected(tokens: number) {
  return Math.floor(tokens * CLAUDE_CORRECTION_FACTOR)
}

function countMessagesTokens(messages: ClaudeMessagesRequest["messages"]) {
  let totalTokens = 0

  for (const message of messages) {
    totalTokens += 4
    totalTokens += countTokens(message.role)
    totalTokens += countContentTokens(message.content)
  }

  totalTokens += 3
  return totalTokens
}

function countContentTokens(content: unknown) {
  if (typeof content === "string") return countTokens(content)
  if (!Array.isArray(content)) return countTokens(stringifyUnknown(content))

  let totalTokens = 0
  for (const part of content) {
    totalTokens += countContentPartTokens(part)
  }
  return totalTokens
}

function countContentPartTokens(part: unknown) {
  if (typeof part === "string") return countTokens(part)
  if (!part || typeof part !== "object") return countTokens(stringifyUnknown(part))

  const item = part as {
    type?: unknown
    text?: unknown
    name?: unknown
    id?: unknown
    input?: unknown
    tool_use_id?: unknown
    is_error?: unknown
    content?: unknown
    cache_control?: unknown
  }

  if (item.type === "text" && typeof item.text === "string") {
    let totalTokens = countTokens(item.text)
    if (item.cache_control !== undefined) totalTokens += countTokens(JSON.stringify(item.cache_control))
    return totalTokens
  }

  if (item.type === "image" || item.type === "image_url") return 100

  if (item.type === "tool_use") {
    return countTokens(typeof item.id === "string" ? item.id : "")
      + countTokens(typeof item.name === "string" ? item.name : "")
      + countTokens(JSON.stringify(item.input ?? {}))
  }

  if (item.type === "tool_result") {
    let totalTokens = countTokens(typeof item.tool_use_id === "string" ? item.tool_use_id : "")
    if (item.is_error !== undefined) totalTokens += countTokens(String(item.is_error))
    totalTokens += countToolResultContentTokens(item.content)
    return totalTokens
  }

  return countTokens(JSON.stringify(part))
}

function countToolResultContentTokens(content: unknown) {
  if (typeof content === "string") return countTokens(content)
  if (!Array.isArray(content)) return content === undefined ? 0 : countTokens(String(content))

  let totalTokens = 0
  for (const part of content) {
    if (typeof part === "string") {
      totalTokens += countTokens(part)
      continue
    }
    if (!part || typeof part !== "object") {
      totalTokens += countTokens(String(part))
      continue
    }

    const item = part as { type?: unknown; text?: unknown }
    if (item.type === "text" && typeof item.text === "string") {
      totalTokens += countTokens(item.text)
      continue
    }

    if (item.type === "image" || item.type === "image_url") {
      totalTokens += 100
      continue
    }

    totalTokens += countTokens(JSON.stringify(part))
  }

  return totalTokens
}

function countSystemTokens(system: ClaudeMessagesRequest["system"]) {
  if (!system) return 0
  if (typeof system === "string") return countTokens(system)
  if (!Array.isArray(system)) return countTokens(JSON.stringify(system))

  let totalTokens = 0
  for (const block of system) {
    if (typeof block === "string") {
      totalTokens += countTokens(block)
      continue
    }
    if (!block || typeof block !== "object") {
      totalTokens += countTokens(String(block))
      continue
    }

    const item = block as { text?: unknown; cache_control?: unknown }
    if (typeof item.text === "string") totalTokens += countTokens(item.text)
    if (item.cache_control !== undefined) totalTokens += countTokens(JSON.stringify(item.cache_control))
  }

  return totalTokens
}

function countToolsTokens(tools: ClaudeTool[] | undefined) {
  if (!tools?.length) return 0

  let totalTokens = 0
  for (const tool of tools) {
    totalTokens += 4

    const payload = toolPayload(tool)
    totalTokens += countTokens(typeof payload.name === "string" ? payload.name : "")
    totalTokens += countTokens(typeof payload.description === "string" ? payload.description : "")

    const parameters = payload.input_schema ?? payload.parameters
    if (parameters !== undefined) totalTokens += countTokens(JSON.stringify(parameters))
  }

  return totalTokens
}

function toolPayload(tool: ClaudeTool) {
  const wrappedFunction = (tool as { function?: unknown }).function
  if ((tool as { type?: unknown }).type === "function" && wrappedFunction && typeof wrappedFunction === "object") {
    return wrappedFunction as Record<string, unknown>
  }
  return tool as Record<string, unknown>
}

function countSupplementalInputTokens(label: string, value: unknown) {
  if (value === undefined) return 0
  if (Array.isArray(value) && value.length === 0) return 0
  return countTokens(`${label}: ${stringifyUnknown(value)}`)
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
