import { countTokens } from "gpt-tokenizer"

import type { Canonical_ContentBlock, Canonical_Event, Canonical_Response, Canonical_StreamResponse, Canonical_ToolCallBlock } from "../../core/canonical"
import type { JsonObject } from "../../core/types"
import { canonicalUsageFromWireUsage, mergeCanonicalUsage } from "../../core/usage"
import { DEFAULT_MAX_INPUT_TOKENS } from "./constants"
import { maybeHandleKiroServerTool, type KiroServerToolHandlers } from "./mcp"
import type { KiroParsedEvent, KiroToolCall } from "./types"

interface Accumulator {
  name: string
  callId: string
  text: string
  object: Record<string, unknown>
}

const STREAM_NO_EVENT_KEEP_CHARS = 1024
const MAX_PENDING_EVENT_CHARS = 1_000_000
const fallbackTokenEncoder = new TextEncoder()
const warnedKiroFallbackEstimators = new WeakSet<typeof console.warn>()

export class AwsEventStreamParser {
  private buffer = ""
  private lastContent?: string
  private active?: Accumulator
  private completed: KiroToolCall[] = []
  private decoder = new TextDecoder()
  private warnedOversizedBuffer = false

  feed(chunk: Uint8Array) {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    const events: KiroParsedEvent[] = []

    for (;;) {
      const start = findEventStart(this.buffer)
      if (start < 0) {
        this.trimNoiseBuffer()
        break
      }
      if (start > 0) this.buffer = this.buffer.slice(start)
      const end = findJsonEnd(this.buffer)
      if (end < 0) {
        this.trimOversizedPendingEvent()
        break
      }
      const raw = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end)
      try {
        const event = JSON.parse(raw) as KiroParsedEvent
        if ("content" in event && event.content === this.lastContent) continue
        if ("content" in event) this.lastContent = event.content
        this.accumulate(event)
        events.push(event)
      } catch (error) {
        console.warn(`Skipping malformed Kiro event-stream JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return events
  }

  getToolCalls() {
    return [...this.completed]
  }

  takeToolCalls() {
    const calls = [...this.completed]
    this.completed = []
    return calls
  }

  finishToolCalls() {
    this.decoder.decode()
    if (this.active) this.finalizeActive()
    return this.takeToolCalls()
  }

  reset() {
    this.buffer = ""
    this.lastContent = undefined
    this.active = undefined
    this.completed = []
    this.decoder.decode()
    this.decoder = new TextDecoder()
    this.warnedOversizedBuffer = false
  }

  private trimNoiseBuffer() {
    if (this.buffer.length > STREAM_NO_EVENT_KEEP_CHARS) this.buffer = this.buffer.slice(-STREAM_NO_EVENT_KEEP_CHARS)
  }

  private trimOversizedPendingEvent() {
    if (this.buffer.length <= MAX_PENDING_EVENT_CHARS) return
    if (!this.warnedOversizedBuffer) {
      console.warn(`Discarding oversized incomplete Kiro event-stream buffer (${this.buffer.length} characters)`)
      this.warnedOversizedBuffer = true
    }
    this.buffer = this.buffer.slice(-STREAM_NO_EVENT_KEEP_CHARS)
  }

  private accumulate(event: KiroParsedEvent) {
    if ("name" in event && "toolUseId" in event) {
      if (!this.active || this.active.callId !== event.toolUseId || this.active.name !== event.name) {
        if (this.active) this.finalizeActive()
        this.active = { name: event.name, callId: event.toolUseId, text: "", object: {} }
      }
      appendInput(this.active, event.input)
      if (event.stop) this.finalizeActive()
      return
    }
    if ("input" in event && this.active) {
      appendInput(this.active, event.input)
      return
    }
    if ("stop" in event && event.stop) this.finalizeActive()
  }

  private finalizeActive() {
    if (!this.active) return
    const args = this.active.text || (Object.keys(this.active.object).length ? JSON.stringify(this.active.object) : "{}")
    this.completed.push({ callId: this.active.callId, name: this.active.name, arguments: validJsonString(args) ? args : "{}" })
    this.active = undefined
  }
}

export class ThinkingBlockExtractor {
  private buffer = ""
  private mode: "detect" | "thinking" | "regular" = "detect"
  private openTag = ""

  feed(content: string): { thinking?: string; regular?: string } {
    if (!content) return {}
    if (this.mode === "regular") return { regular: content }
    this.buffer += content

    if (this.mode === "detect") {
      const tag = this.buffer.startsWith("<thinking>") ? "<thinking>" : this.buffer.startsWith("<think>") ? "<think>" : undefined
      if (tag) {
        this.openTag = tag
        this.buffer = this.buffer.slice(tag.length)
        this.mode = "thinking"
      } else if (this.buffer.length >= 30 || !"<thinking><think>".startsWith(this.buffer)) {
        const regular = this.buffer
        this.buffer = ""
        this.mode = "regular"
        return { regular }
      } else {
        return {}
      }
    }

    if (this.mode === "thinking") {
      return this.flushThinking()
    }

    return {}
  }

  finalize(): { thinking?: string; regular?: string } {
    if (!this.buffer) return {}
    const text = this.buffer
    this.buffer = ""
    return this.mode === "thinking" ? { thinking: text } : { regular: text }
  }

  private flushThinking(): { thinking?: string; regular?: string } {
    const closeTag = this.openTag === "<think>" ? "</think>" : "</thinking>"
    const close = this.buffer.indexOf(closeTag)
    if (close >= 0) {
      const thinking = this.buffer.slice(0, close)
      const regular = this.buffer.slice(close + closeTag.length)
      this.buffer = ""
      this.mode = "regular"
      return { ...(thinking ? { thinking } : {}), ...(regular ? { regular } : {}) }
    }

    const keep = closingTagPrefixSuffixLength(this.buffer, closeTag)
    if (keep === 0) {
      const thinking = this.buffer
      this.buffer = ""
      return thinking ? { thinking } : {}
    }
    if (keep < this.buffer.length) {
      const thinking = this.buffer.slice(0, -keep)
      this.buffer = this.buffer.slice(-keep)
      return thinking ? { thinking } : {}
    }
    return {}
  }
}

export function streamKiroResponse(
  response: Response,
  fallbackModel: string,
  effectiveTools: JsonObject[],
  inputTokenEstimate: number,
  serverTools?: KiroServerToolHandlers,
  initialServerToolBlocks: JsonObject[] = [],
  prefaceText = "",
): Canonical_StreamResponse {
  const id = `resp_${crypto.randomUUID().replace(/-/g, "")}`
  return {
    type: "canonical_stream",
    status: response.status,
    id,
    model: fallbackModel,
    events: {
      async *[Symbol.asyncIterator]() {
        yield* iterateKiroEvents(response.body, inputTokenEstimate, effectiveTools, serverTools, true, initialServerToolBlocks, prefaceText)
      },
    },
  }
}

export async function collectKiroResponse(
  response: Response,
  fallbackModel: string,
  effectiveTools: JsonObject[],
  inputTokenEstimate: number,
  serverTools?: KiroServerToolHandlers,
  initialServerToolBlocks: JsonObject[] = [],
  prefaceText = "",
): Promise<Canonical_Response> {
  const content: Canonical_ContentBlock[] = []
  let pendingText = ""
  let pendingThinking: { thinking: string; signature?: string } | undefined
  let outputTokens = 0
  let inputTokens = inputTokenEstimate
  let cacheCreationInputTokens: number | undefined
  let cacheReadInputTokens: number | undefined
  let outputReasoningTokens: number | undefined
  let serverToolUse: Canonical_Response["usage"]["serverToolUse"] | undefined
  let stopReason: Canonical_Response["stopReason"] = "end_turn"

  const flushText = () => {
    if (!pendingText) return
    const extracted = extractBracketToolCalls(pendingText, effectiveTools, content)
    if (extracted.blocks.length) content.push(...extracted.blocks)
    else if (!extracted.handled) content.push({ type: "text", text: pendingText })
    pendingText = ""
  }
  const flushThinking = () => {
    if (!pendingThinking) return
    content.push({ type: "thinking", thinking: pendingThinking.thinking, signature: pendingThinking.signature ?? `sig_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}` })
    pendingThinking = undefined
  }

  for await (const event of iterateKiroEvents(response.body, inputTokenEstimate, effectiveTools, serverTools, false, initialServerToolBlocks, prefaceText)) {
    if (event.type === "text_delta") {
      flushThinking()
      pendingText += event.delta
    }
    if (event.type === "thinking_delta") {
      flushText()
      pendingThinking ??= { thinking: "" }
      pendingThinking.thinking += event.text ?? event.label ?? ""
    }
    if (event.type === "thinking_signature") {
      pendingThinking ??= { thinking: "" }
      pendingThinking.signature = event.signature
    }
    if (event.type === "tool_call_done") {
      flushThinking()
      flushText()
      content.push({ type: "tool_call", id: `fc_${crypto.randomUUID().replace(/-/g, "")}`, callId: event.callId, name: event.name, arguments: event.arguments })
    }
    if (event.type === "server_tool_block") {
      flushThinking()
      flushText()
      content.push({ type: "server_tool", blocks: event.blocks })
    }
    if (event.type === "usage") {
      outputTokens = event.usage.outputTokens ?? outputTokens
      inputTokens = event.usage.inputTokens ?? inputTokens
      const mergedUsage: Canonical_Response["usage"] = { inputTokens, outputTokens }
      mergeCanonicalUsage(mergedUsage, event.usage)
      inputTokens = mergedUsage.inputTokens
      outputTokens = mergedUsage.outputTokens
      cacheCreationInputTokens = mergedUsage.cacheCreationInputTokens ?? cacheCreationInputTokens
      cacheReadInputTokens = mergedUsage.cacheReadInputTokens ?? cacheReadInputTokens
      outputReasoningTokens = mergedUsage.outputReasoningTokens ?? outputReasoningTokens
      serverToolUse = mergeServerToolUse(serverToolUse, event.usage.serverToolUse)
    }
    if (event.type === "message_stop") stopReason = event.stopReason as Canonical_Response["stopReason"]
  }

  flushThinking()
  flushText()
  const finalText = content.flatMap((block) => block.type === "text" ? [block.text] : []).join("")
  if (!outputTokens && finalText) outputTokens = estimateKiroFallbackTokens(finalText)

  return {
    type: "canonical_response",
    id: `resp_${crypto.randomUUID().replace(/-/g, "")}`,
    model: fallbackModel,
    stopReason: content.some((block) => block.type === "tool_call") ? "tool_use" : stopReason,
    content,
    usage: {
      inputTokens,
      outputTokens,
      ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
      ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
      ...(outputReasoningTokens !== undefined ? { outputReasoningTokens } : {}),
      ...(serverToolUse && (serverToolUse.webSearchRequests || serverToolUse.webFetchRequests || serverToolUse.mcpCalls) ? { serverToolUse } : {}),
    },
  }
}

async function* iterateKiroEvents(
  stream: ReadableStream<Uint8Array> | null,
  inputTokenEstimate: number,
  effectiveTools: JsonObject[] = [],
  serverTools?: KiroServerToolHandlers,
  emitBracketToolCalls = true,
  initialServerToolBlocks: JsonObject[] = [],
  prefaceText = "",
): AsyncIterable<Canonical_Event> {
  const parser = new AwsEventStreamParser()
  const thinking = new ThinkingBlockExtractor()
  let text = prefaceText
  let usageOutputTokens: number | undefined
  let upstreamInputTokens: number | undefined
  const upstreamUsage: Canonical_Response["usage"] = { inputTokens: inputTokenEstimate, outputTokens: 0 }
  let contextUsage: number | undefined
  let stopReason = "end_turn"
  let sawToolCall = false
  let sawThinking = false
  let sentThinkingSignature = false
  let thinkingBlockIndex: number | undefined
  let nextBlockIndex = 0
  const initialServerToolUse = serverToolUseFromBlocks(initialServerToolBlocks)
  let webSearchRequests = initialServerToolUse?.webSearchRequests ?? 0
  const emittedToolCalls: Canonical_ToolCallBlock[] = []
  const reader = stream?.getReader()
  if (prefaceText) yield { type: "text_delta", delta: prefaceText }
  if (initialServerToolBlocks.length) yield { type: "server_tool_block", blocks: initialServerToolBlocks }
  if (!reader) {
    yield {
      type: "usage",
      usage: {
        inputTokens: inputTokenEstimate,
        outputTokens: text ? estimateKiroFallbackTokens(text) : 0,
        ...(initialServerToolUse ? { serverToolUse: initialServerToolUse } : {}),
      },
    }
    yield { type: "message_stop", stopReason }
    return
  }

  async function* emitToolCall(call: KiroToolCall): AsyncIterable<Canonical_Event> {
    let emittedClientTool = false
    for await (const event of maybeHandleKiroServerTool(call, serverTools)) {
      if (event.type === "tool_call_done") {
        emittedClientTool = true
        emittedToolCalls.push({
          type: "tool_call",
          id: `fc_${crypto.randomUUID().replace(/-/g, "")}`,
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
        })
      }
      if (event.type === "server_tool_block" && event.blocks.some((block) => block.type === "web_search_tool_result")) {
        webSearchRequests += 1
      }
      if (event.type === "text_delta") {
        text += event.delta
      }
      yield event
    }
    if (emittedClientTool) {
      sawToolCall = true
      stopReason = "tool_use"
    }
  }

  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      for (const event of parser.feed(chunk.value)) {
        if ("content" in event) {
          const extracted = thinking.feed(event.content)
          if (extracted.thinking !== undefined) {
            sawThinking = true
            if (thinkingBlockIndex === undefined) {
              thinkingBlockIndex = nextBlockIndex++
              yield { type: "content_block_start", blockType: "thinking", index: thinkingBlockIndex, block: { type: "thinking", thinking: "", signature: "" } }
            }
            yield { type: "thinking_delta", text: extracted.thinking }
          }
          if (extracted.regular !== undefined) {
            if (sawThinking && !sentThinkingSignature) {
              yield { type: "thinking_signature", signature: `sig_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}` }
              yield { type: "content_block_stop", index: thinkingBlockIndex ?? 0 }
              sentThinkingSignature = true
            }
            text += extracted.regular
            yield { type: "text_delta", delta: extracted.regular }
          }
        }
        if ("usage" in event) {
          if (typeof event.usage === "number") {
            usageOutputTokens = event.usage
          } else if (event.usage && typeof event.usage === "object" && !Array.isArray(event.usage)) {
            const usage = canonicalUsageFromWireUsage(event.usage)
            mergeCanonicalUsage(upstreamUsage, usage)
            if (typeof usage.inputTokens === "number") upstreamInputTokens = usage.inputTokens
            if (typeof upstreamUsage.outputTokens === "number" && upstreamUsage.outputTokens > 0) usageOutputTokens = upstreamUsage.outputTokens
          }
        }
        const toolCalls = parser.takeToolCalls()
        if ("stop" in event && event.stop && !toolCalls.length && !sawToolCall) stopReason = "max_tokens"
        if ("contextUsagePercentage" in event && typeof event.contextUsagePercentage === "number") contextUsage = event.contextUsagePercentage
        for (const call of toolCalls) {
          yield* emitToolCall(call)
        }
      }
    }
  } catch (error) {
    yield { type: "error", message: error instanceof Error ? error.message : String(error) }
    return
  } finally {
    reader.releaseLock()
  }

  const tail = thinking.finalize()
  if (tail.thinking !== undefined) {
    sawThinking = true
    if (thinkingBlockIndex === undefined) {
      thinkingBlockIndex = nextBlockIndex++
      yield { type: "content_block_start", blockType: "thinking", index: thinkingBlockIndex, block: { type: "thinking", thinking: "", signature: "" } }
    }
    yield { type: "thinking_delta", text: tail.thinking }
  }
  if (sawThinking && !sentThinkingSignature) {
    yield { type: "thinking_signature", signature: `sig_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}` }
    yield { type: "content_block_stop", index: thinkingBlockIndex ?? 0 }
    sentThinkingSignature = true
  }
  if (tail.regular !== undefined) {
    text += tail.regular
    yield { type: "text_delta", delta: tail.regular }
  }
  for (const call of parser.finishToolCalls()) {
    yield* emitToolCall(call)
  }
  if (emitBracketToolCalls) {
    const bracketToolBlocks = extractBracketToolCalls(text, effectiveTools, emittedToolCalls).blocks.filter((block): block is Canonical_ToolCallBlock => block.type === "tool_call")
    for (const block of bracketToolBlocks) {
      yield* emitToolCall({ callId: block.callId, name: block.name, arguments: block.arguments })
    }
  }
  const outputTokens = usageOutputTokens ?? (text ? estimateKiroFallbackTokens(text) : 0)
  const serverToolUse = mergeServerToolUse(
    upstreamUsage.serverToolUse,
    webSearchRequests ? { webSearchRequests } : undefined,
  )
  yield {
    type: "usage",
    usage: {
      inputTokens: upstreamInputTokens ?? estimateInputTokens(contextUsage, outputTokens, inputTokenEstimate),
      outputTokens,
      ...(upstreamUsage.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: upstreamUsage.cacheCreationInputTokens } : {}),
      ...(upstreamUsage.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: upstreamUsage.cacheReadInputTokens } : {}),
      ...(upstreamUsage.outputReasoningTokens !== undefined ? { outputReasoningTokens: upstreamUsage.outputReasoningTokens } : {}),
      ...(serverToolUse ? { serverToolUse } : {}),
    },
  }
  yield { type: "message_stop", stopReason }
}

function closingTagPrefixSuffixLength(value: string, closeTag: string) {
  const max = Math.min(value.length, closeTag.length - 1)
  for (let length = max; length > 0; length -= 1) {
    if (closeTag.startsWith(value.slice(-length))) return length
  }
  return 0
}

function findEventStart(buffer: string) {
  const patterns = ["{\"contextUsagePercentage\":", "{\"content\":", "{\"name\":", "{\"input\":", "{\"stop\":", "{\"usage\":"]
  const indexes = patterns.map((pattern) => buffer.indexOf(pattern)).filter((index) => index >= 0)
  return indexes.length ? Math.min(...indexes) : -1
}

function findJsonEnd(value: string) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === "\"") inString = false
      continue
    }
    if (char === "\"") inString = true
    else if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

function appendInput(acc: Accumulator, input: string | Record<string, unknown>) {
  if (typeof input === "string") acc.text += input
  else Object.assign(acc.object, input)
}

function validJsonString(value: string) {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

function estimateInputTokens(contextUsage: number | undefined, outputTokens: number, fallback: number) {
  if (typeof contextUsage === "number" && contextUsage > 0) return Math.max(0, Math.floor((contextUsage / 100) * DEFAULT_MAX_INPUT_TOKENS) - outputTokens)
  return fallback
}

function estimateKiroFallbackTokens(text: string) {
  if (!warnedKiroFallbackEstimators.has(console.warn)) {
    console.warn("Conservatively estimating Kiro output tokens with max(gpt-tokenizer, byte length) because upstream usage was unavailable; counts are approximate")
    warnedKiroFallbackEstimators.add(console.warn)
  }
  return Math.max(countTokens(text), fallbackTokenEncoder.encode(text).length)
}

function serverToolUseFromBlocks(blocks: JsonObject[]): Canonical_Response["usage"]["serverToolUse"] | undefined {
  const webSearchRequests = blocks.filter((block) => block.type === "web_search_tool_result").length
  const webFetchRequests = blocks.filter((block) => block.type === "web_fetch_tool_result").length
  const mcpCalls = blocks.filter((block) => block.type === "mcp_tool_result").length
  if (!webSearchRequests && !webFetchRequests && !mcpCalls) return
  return {
    ...(webSearchRequests ? { webSearchRequests } : {}),
    ...(webFetchRequests ? { webFetchRequests } : {}),
    ...(mcpCalls ? { mcpCalls } : {}),
  }
}

function mergeServerToolUse(
  left: Canonical_Response["usage"]["serverToolUse"] | undefined,
  right: Canonical_Response["usage"]["serverToolUse"] | undefined,
): Canonical_Response["usage"]["serverToolUse"] | undefined {
  const webSearchRequests = maxDefined(left?.webSearchRequests, right?.webSearchRequests)
  const webFetchRequests = maxDefined(left?.webFetchRequests, right?.webFetchRequests)
  const mcpCalls = maxDefined(left?.mcpCalls, right?.mcpCalls)
  if (webSearchRequests === undefined && webFetchRequests === undefined && mcpCalls === undefined) return
  return {
    ...(webSearchRequests !== undefined ? { webSearchRequests } : {}),
    ...(webFetchRequests !== undefined ? { webFetchRequests } : {}),
    ...(mcpCalls !== undefined ? { mcpCalls } : {}),
  }
}

function maxDefined(...values: Array<number | undefined>) {
  const numbers = values.filter((value): value is number => typeof value === "number")
  return numbers.length ? Math.max(...numbers) : undefined
}

function extractBracketToolCalls(text: string, effectiveTools: JsonObject[], existingBlocks: Canonical_ContentBlock[] = []) {
  const toolNames = new Set(effectiveTools.flatMap((tool) => typeof tool.name === "string" ? [tool.name] : []))
  const existingToolCalls = existingBlocks.flatMap((block) => block.type === "tool_call" ? [block] : [])
  const existingKeys = new Set(existingToolCalls.map((block) => toolCallKey(block.name, block.arguments)))
  const emptyByName = new Map<string, Canonical_ToolCallBlock[]>()
  for (const block of existingToolCalls) {
    if (isEmptyJsonObject(block.arguments)) emptyByName.set(block.name, [...(emptyByName.get(block.name) ?? []), block])
  }
  const blocks: Canonical_ContentBlock[] = []
  let cursor = 0
  let handled = false
  for (const match of findBracketCalls(text)) {
    if (!toolNames.has(match.name)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(match.args)
    } catch {
      continue
    }
    const argumentsJson = JSON.stringify(parsed)
    const key = toolCallKey(match.name, argumentsJson)
    const before = text.slice(cursor, match.start)
    if (existingKeys.has(key)) {
      if (before) blocks.push({ type: "text", text: before })
      handled = true
      cursor = match.end
      continue
    }
    const emptyCandidates = emptyByName.get(match.name) ?? []
    if (!isEmptyJsonObject(argumentsJson) && emptyCandidates.length === 1) {
      const existing = emptyCandidates[0]
      if (before) blocks.push({ type: "text", text: before })
      existingKeys.delete(toolCallKey(existing.name, existing.arguments))
      existing.arguments = argumentsJson
      existingKeys.add(key)
      emptyByName.set(match.name, [])
      handled = true
      cursor = match.end
      continue
    }
    if (before) blocks.push({ type: "text", text: before })
    blocks.push({ type: "tool_call", id: `fc_${crypto.randomUUID().replace(/-/g, "")}`, callId: `toolu_${crypto.randomUUID().replace(/-/g, "")}`, name: match.name, arguments: argumentsJson } satisfies Canonical_ToolCallBlock)
    existingKeys.add(key)
    handled = true
    cursor = match.end
  }
  const tail = text.slice(cursor)
  if (tail) blocks.push({ type: "text", text: tail })
  return { blocks, handled }
}

function toolCallKey(name: string, argumentsJson: string) {
  return `${name}\u0000${normalizeJson(argumentsJson)}`
}

function normalizeJson(value: string) {
  try {
    return JSON.stringify(JSON.parse(value))
  } catch {
    return value
  }
}

function isEmptyJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value)
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0)
  } catch {
    return false
  }
}

function findBracketCalls(text: string) {
  const calls: Array<{ start: number; end: number; name: string; args: string }> = []
  let start = text.indexOf("[Called ")
  while (start >= 0) {
    const argsMarker = " with args: "
    const argsStart = text.indexOf(argsMarker, start)
    if (argsStart < 0) break
    const name = text.slice(start + "[Called ".length, argsStart).trim()
    const jsonStart = argsStart + argsMarker.length
    const jsonEnd = findJsonEnd(text.slice(jsonStart))
    if (jsonEnd > 0 && text[jsonStart + jsonEnd] === "]") {
      calls.push({ start, end: jsonStart + jsonEnd + 1, name, args: text.slice(jsonStart, jsonStart + jsonEnd) })
      start = text.indexOf("[Called ", jsonStart + jsonEnd + 1)
    } else {
      start = text.indexOf("[Called ", start + 1)
    }
  }
  return calls
}
