import type { JsonObject } from "../../../types"

import type { KiroParsedEvent } from "./types"
import { detectToolInputTruncation, saveToolTruncation, detectContentTruncation, saveContentTruncation } from "./truncation"

const THINKING_OPEN_TAG = "<thinking>"
const THINKING_CLOSE_TAG = "</thinking>"

/** Default timeout (ms) waiting for the very first data from the stream. */
const FIRST_TOKEN_TIMEOUT_MS = 15_000

/** Maximum number of first-token-timeout retries. */
const FIRST_TOKEN_MAX_RETRIES = 3

/**
 * Error thrown when the model does not produce any data within the
 * first-token timeout window.
 */
export class FirstTokenTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`No response from model within ${timeoutMs}ms`)
    this.name = "FirstTokenTimeoutError"
  }
}

export async function collectKiroEvents(response: Response): Promise<KiroParsedEvent[]> {
  if (!response.body) throw new Error("Kiro response did not include a body")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = new KiroEventParser()
  const events: KiroParsedEvent[] = []

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    events.push(...parser.feed(decoder.decode(chunk.value, { stream: true })))
  }

  events.push(...parser.flush())
  return events
}

export async function* streamKiroEvents(
  response: Response,
  options?: { firstTokenTimeoutMs?: number },
): AsyncGenerator<KiroParsedEvent> {
  if (!response.body) throw new Error("Kiro response did not include a body")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = new KiroEventParser()
  const timeoutMs = options?.firstTokenTimeoutMs ?? FIRST_TOKEN_TIMEOUT_MS
  let firstChunkReceived = false
  let hasUsageEvent = false
  let hasContextUsageEvent = false
  let totalContentLength = 0

  try {
    while (true) {
      // Apply first-token timeout only for the very first chunk
      let chunk: ReadableStreamReadResult<Uint8Array>
      if (!firstChunkReceived) {
        chunk = await readWithTimeout(reader, timeoutMs)
        firstChunkReceived = true
      } else {
        chunk = await reader.read()
      }

      if (chunk.done) break

      for (const event of parser.feed(decoder.decode(chunk.value, { stream: true }))) {
        if (event.type === "usage") hasUsageEvent = true
        if (event.type === "context_usage") hasContextUsageEvent = true
        if (event.type === "content") totalContentLength += event.content.length
        if (event.type === "thinking") totalContentLength += event.thinking.length
        yield event
      }
    }

    for (const event of parser.flush()) {
      if (event.type === "usage") hasUsageEvent = true
      if (event.type === "context_usage") hasContextUsageEvent = true
      if (event.type === "content") totalContentLength += event.content.length
      if (event.type === "thinking") totalContentLength += event.thinking.length
      yield event
    }

    // --- Content truncation detection ---
    const contentTrunc = detectContentTruncation(hasUsageEvent, hasContextUsageEvent, totalContentLength)
    if (contentTrunc.detected) {
      // We can't yield a special event here (the caller handles it), but we
      // save the state so the next request can inject a recovery message.
      saveContentTruncation(`stream_content_${totalContentLength}_${Date.now()}`)
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Read from a ReadableStreamDefaultReader with a timeout.
 * Throws FirstTokenTimeoutError if no data arrives within `timeoutMs`.
 */
async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new FirstTokenTimeoutError(timeoutMs))
    }, timeoutMs)

    reader.read().then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

class KiroEventParser {
  private buffer = ""
  private contentBuffer = ""
  private inThinking = false
  private currentTool: { id: string; name: string; input: string } | undefined
  private toolUses: Array<{ id: string; name: string; input: JsonObject }> = []

  feed(chunk: string) {
    this.buffer += chunk
    const events: KiroParsedEvent[] = []

    while (true) {
      const start = this.buffer.indexOf("{")
      if (start < 0) {
        this.buffer = ""
        break
      }
      if (start > 0) this.buffer = this.buffer.slice(start)
      const end = findMatchingBrace(this.buffer, 0)
      if (end < 0) break

      const raw = this.buffer.slice(0, end + 1)
      this.buffer = this.buffer.slice(end + 1)
      const parsed = this.parseObject(raw)
      if (parsed.length) events.push(...parsed)
    }

    return events
  }

  flush() {
    const events: KiroParsedEvent[] = []
    // Flush any remaining content still held back by the thinking-tag parser.
    // This happens when the stream ends while we're inside a <thinking> block
    // (no closing tag arrived) or when trailing content is shorter than the
    // tag-lookahead window.
    if (this.contentBuffer) {
      if (this.inThinking) {
        events.push({ type: "thinking", thinking: this.contentBuffer, isLast: true } satisfies KiroParsedEvent)
      } else {
        events.push({ type: "content", content: this.contentBuffer } satisfies KiroParsedEvent)
      }
      this.contentBuffer = ""
    }
    events.push(...this.flushCurrentTool())
    return events
  }

  private parseObject(raw: string) {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>
      if (typeof value.content === "string") return this.parseContent(value.content)
      if (typeof value.name === "string") return this.startTool(value)
      if (Object.prototype.hasOwnProperty.call(value, "input")) return this.appendToolInput(value.input)
      if (value.stop === true) return this.flushCurrentTool()
      if (isRecord(value.usage)) return [{ type: "usage", usage: value.usage } satisfies KiroParsedEvent]
      if (typeof value.contextUsagePercentage === "number") {
        return [{ type: "context_usage", contextUsagePercentage: value.contextUsagePercentage } satisfies KiroParsedEvent]
      }
      return []
    } catch {
      return []
    }
  }

  private parseContent(content: string) {
    const events: KiroParsedEvent[] = []
    this.contentBuffer += content

    while (this.contentBuffer.length) {
      if (this.inThinking) {
        const closeIndex = this.contentBuffer.indexOf(THINKING_CLOSE_TAG)
        if (closeIndex < 0) {
          if (this.contentBuffer.length <= THINKING_CLOSE_TAG.length) break
          const safeLength = this.contentBuffer.length - THINKING_CLOSE_TAG.length
          const chunk = this.contentBuffer.slice(0, safeLength)
          this.contentBuffer = this.contentBuffer.slice(safeLength)
          if (chunk) events.push({ type: "thinking", thinking: chunk } satisfies KiroParsedEvent)
          break
        }

        const chunk = this.contentBuffer.slice(0, closeIndex)
        this.contentBuffer = this.contentBuffer.slice(closeIndex + THINKING_CLOSE_TAG.length)
        if (chunk) events.push({ type: "thinking", thinking: chunk } satisfies KiroParsedEvent)
        if (events.length) {
          const lastThinking = [...events].reverse().find((event) => event.type === "thinking") as
            | Extract<KiroParsedEvent, { type: "thinking" }>
            | undefined
          if (lastThinking) lastThinking.isLast = true
        }
        this.inThinking = false
        continue
      }

      const openIndex = this.contentBuffer.indexOf(THINKING_OPEN_TAG)
      if (openIndex < 0) {
        const safeTail = Math.min(this.contentBuffer.length, THINKING_OPEN_TAG.length)
        const flushUntil = this.contentBuffer.length > THINKING_OPEN_TAG.length ? this.contentBuffer.length - THINKING_OPEN_TAG.length : 0
        if (flushUntil > 0) {
          const chunk = this.contentBuffer.slice(0, flushUntil)
          this.contentBuffer = this.contentBuffer.slice(flushUntil)
          if (chunk) events.push({ type: "content", content: chunk } satisfies KiroParsedEvent)
        }
        if (this.contentBuffer.length > 0 && safeTail === this.contentBuffer.length && !THINKING_OPEN_TAG.startsWith(this.contentBuffer)) {
          events.push({ type: "content", content: this.contentBuffer } satisfies KiroParsedEvent)
          this.contentBuffer = ""
        }
        break
      }

      const before = this.contentBuffer.slice(0, openIndex)
      if (before) events.push({ type: "content", content: before } satisfies KiroParsedEvent)
      this.contentBuffer = this.contentBuffer.slice(openIndex + THINKING_OPEN_TAG.length)
      this.inThinking = true
      events.push({ type: "thinking", thinking: "", isFirst: true } satisfies KiroParsedEvent)
    }

    return coalesceThinkingMarkers(events)
  }

  private startTool(value: Record<string, unknown>) {
    const events = this.flushCurrentTool()
    this.currentTool = {
      id: typeof value.toolUseId === "string" ? value.toolUseId : crypto.randomUUID(),
      name: value.name,
      input: stringifyToolInput(value.input),
    }
    if (value.stop === true) events.push(...this.flushCurrentTool())
    return events
  }

  private appendToolInput(input: unknown) {
    if (!this.currentTool) return []
    this.currentTool.input += stringifyToolInput(input)
    return []
  }

  private flushCurrentTool() {
    if (!this.currentTool) return []
    const rawInput = this.currentTool.input

    // --- Truncation detection for tool input ---
    const truncInfo = detectToolInputTruncation(rawInput)
    const toolUse = {
      id: this.currentTool.id,
      name: this.currentTool.name,
      input: parseToolInput(rawInput),
    }
    if (truncInfo.detected) {
      saveToolTruncation(toolUse.id, toolUse.name, truncInfo)
    }

    this.currentTool = undefined
    this.toolUses.push(toolUse)
    return [{ type: "tool_use", toolUse } satisfies KiroParsedEvent]
  }
}

function coalesceThinkingMarkers(events: KiroParsedEvent[]) {
  const result: KiroParsedEvent[] = []
  for (const event of events) {
    if (event.type !== "thinking") {
      result.push(event)
      continue
    }

    const previous = result.at(-1)
    if (previous?.type === "thinking") {
      previous.thinking += event.thinking
      previous.isFirst = previous.isFirst || event.isFirst
      previous.isLast = previous.isLast || event.isLast
      continue
    }

    result.push(event)
  }
  return result.filter((event) => event.type !== "thinking" || event.thinking.length > 0 || event.isFirst || event.isLast)
}

function findMatchingBrace(input: string, start: number) {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < input.length; index += 1) {
    const char = input[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\" && inString) {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === "{") depth += 1
    if (char === "}") {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return -1
}

function stringifyToolInput(input: unknown) {
  if (typeof input === "string") return input
  if (input == null) return ""
  return JSON.stringify(input)
}

function parseToolInput(input: string): JsonObject {
  if (!input.trim()) return {}
  try {
    const parsed = JSON.parse(input)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
