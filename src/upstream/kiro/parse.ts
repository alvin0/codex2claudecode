import { countTokens } from "gpt-tokenizer"

import type { Canonical_ContentBlock, Canonical_Event, Canonical_FeatureNotice, Canonical_Response, Canonical_StreamResponse, Canonical_ToolCallBlock } from "../../core/canonical"
import type { JsonObject } from "../../core/types"
import { canonicalUsageFromWireUsage, mergeCanonicalUsage, mergeServerToolUse } from "../../core/usage"
import { DEFAULT_MAX_INPUT_TOKENS } from "./constants"
import { findEventStart } from "./event-frames"
import { maybeHandleKiroServerTool, type KiroServerToolHandlers } from "./web-search"
import { maybeHandleKiroWebFetch, webFetchRequestsFromBlocks, type KiroWebFetchHandlers } from "./web-fetch"
import type { KiroMcpSession } from "./mcp-toolset"
import { parseKiroMeteringUsage } from "./metering"
import type { KiroParsedEvent, KiroToolCall } from "./types"

/**
 * The server-tool handlers one Kiro turn can carry.
 *
 * Two independent bags, intersected rather than merged into a new shape: `web-search.ts` owns
 * `webSearch` / `webSearchFallbackQuery` and `web-fetch.ts` owns `webFetch`, and each module's
 * interceptor reads only its own members. A turn may supply either, both, or neither — the tool-list
 * computation in `./index.ts` decides which, per declared tool, so a `web_fetch` a client never
 * declared is never intercepted.
 *
 * The MCP session is deliberately **not** a member. It is stateful (it holds the expanded name map
 * and the completed-call counter) and it is created before the payload is built rather than
 * assembled from closures at the call site, so it travels as its own parameter.
 */
export type KiroServerToolBundle = KiroServerToolHandlers & KiroWebFetchHandlers

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

  /** Telemetry: number of malformed events skipped during parsing. */
  skippedMalformedEvents = 0
  /** Telemetry: number of oversized buffer trims performed. */
  oversizedBufferTrims = 0
  /** Telemetry: number of duplicate content events suppressed. */
  duplicateContentSkips = 0

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
        if ("content" in event && event.content === this.lastContent) {
          this.duplicateContentSkips += 1
          continue
        }
        if ("content" in event) this.lastContent = event.content
        this.accumulate(event)
        events.push(event)
      } catch (error) {
        this.skippedMalformedEvents += 1
        console.warn(`Skipping malformed Kiro event-stream JSON (length=${raw.length}): ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return events
  }

  /** Return safe diagnostic metadata (no raw content). */
  diagnostics() {
    return {
      bufferLength: this.buffer.length,
      skippedMalformedEvents: this.skippedMalformedEvents,
      oversizedBufferTrims: this.oversizedBufferTrims,
      duplicateContentSkips: this.duplicateContentSkips,
      pendingToolCall: this.active ? { name: this.active.name, callId: this.active.callId } : undefined,
      completedToolCalls: this.completed.length,
    }
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
    this.skippedMalformedEvents = 0
    this.oversizedBufferTrims = 0
    this.duplicateContentSkips = 0
  }

  private trimNoiseBuffer() {
    if (this.buffer.length > STREAM_NO_EVENT_KEEP_CHARS) this.buffer = this.buffer.slice(-STREAM_NO_EVENT_KEEP_CHARS)
  }

  private trimOversizedPendingEvent() {
    if (this.buffer.length <= MAX_PENDING_EVENT_CHARS) return
    this.oversizedBufferTrims += 1
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
  serverTools?: KiroServerToolBundle,
  initialServerToolBlocks: JsonObject[] = [],
  prefaceText = "",
  maxInputTokens = DEFAULT_MAX_INPUT_TOKENS,
  mcp?: KiroMcpSession,
): Canonical_StreamResponse {
  const id = `resp_${crypto.randomUUID().replace(/-/g, "")}`
  return {
    type: "canonical_stream",
    status: response.status,
    id,
    model: fallbackModel,
    // The payload was built before this stream opened, so the input count is already known and
    // does not have to wait for the first `usage` frame. Handing it over here is what lets an
    // inbound renderer open with the same number it will close on.
    usage: { inputTokens: inputTokenEstimate },
    events: {
      async *[Symbol.asyncIterator]() {
        yield* iterateKiroEvents(response.body, inputTokenEstimate, effectiveTools, serverTools, true, initialServerToolBlocks, prefaceText, maxInputTokens, mcp)
      },
    },
  }
}

export async function collectKiroResponse(
  response: Response,
  fallbackModel: string,
  effectiveTools: JsonObject[],
  inputTokenEstimate: number,
  serverTools?: KiroServerToolBundle,
  initialServerToolBlocks: JsonObject[] = [],
  prefaceText = "",
  maxInputTokens = DEFAULT_MAX_INPUT_TOKENS,
  mcp?: KiroMcpSession,
): Promise<Canonical_Response> {
  const content: Canonical_ContentBlock[] = []
  let pendingText = ""
  let pendingThinking: { thinking: string; signature?: string } | undefined
  let outputTokens = 0
  let inputTokens = inputTokenEstimate
  let cacheCreationInputTokens: number | undefined
  let cacheReadInputTokens: number | undefined
  let outputReasoningTokens: number | undefined
  let providerCredits: number | undefined
  /** Notices in emission order, one entry per event. Stays empty when none arrive. */
  const featureNotices: Canonical_FeatureNotice[] = []
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

  for await (const event of iterateKiroEvents(response.body, inputTokenEstimate, effectiveTools, serverTools, false, initialServerToolBlocks, prefaceText, maxInputTokens, mcp)) {
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
      // Accumulated off `event.usage` rather than `mergedUsage`, because `mergedUsage` is rebuilt
      // per event and so cannot carry a running total. Summed for the same reason
      // `mergeCanonicalUsage()` sums it: several upstream calls can each report spend.
      if (typeof event.usage.providerCredits === "number") providerCredits = (providerCredits ?? 0) + event.usage.providerCredits
      serverToolUse = mergeServerToolUse(serverToolUse, event.usage.serverToolUse)
    }
    if (event.type === "message_stop") stopReason = event.stopReason as Canonical_Response["stopReason"]
    // Token- and content-neutral (Requirement 8.4), the same isolation the metering branch in
    // `iterateKiroEvents` buys with its `continue`: here the discriminated union does it, since
    // `feature_notice` matches none of the branches above. No flush, no content push, no usage
    // or stop-reason write — a notice between two text deltas must not split the text block.
    // Appended verbatim, one entry per event, in emission order (Requirement 8.2). No dedupe
    // here: collapsing repeats by `(feature, detail)` is the inbound renderer's job.
    if (event.type === "feature_notice") featureNotices.push({ feature: event.feature, policy: event.policy, detail: event.detail })
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
      ...(providerCredits !== undefined ? { providerCredits } : {}),
      ...(serverToolUse && (serverToolUse.webSearchRequests || serverToolUse.webFetchRequests || serverToolUse.mcpCalls) ? { serverToolUse } : {}),
    },
    // Omitted rather than empty (Requirement 8.3), the same conditional-spread idiom the
    // optional usage members above use.
    ...(featureNotices.length ? { featureNotices } : {}),
  }
}

async function* iterateKiroEvents(
  stream: ReadableStream<Uint8Array> | null,
  inputTokenEstimate: number,
  effectiveTools: JsonObject[] = [],
  serverTools?: KiroServerToolBundle,
  emitBracketToolCalls = true,
  initialServerToolBlocks: JsonObject[] = [],
  prefaceText = "",
  maxInputTokens = DEFAULT_MAX_INPUT_TOKENS,
  mcp?: KiroMcpSession,
): AsyncIterable<Canonical_Event> {
  const parser = new AwsEventStreamParser()
  const thinking = new ThinkingBlockExtractor()
  let text = prefaceText
  let usageOutputTokens: number | undefined
  let upstreamInputTokens: number | undefined
  const upstreamUsage: Canonical_Response["usage"] = { inputTokens: inputTokenEstimate, outputTokens: 0 }
  /** Running total of the metering frames' credits. Stays `undefined` when no metering frame arrives. */
  let providerCredits: number | undefined
  let contextUsage: number | undefined
  let stopReason = "end_turn"
  let sawToolCall = false
  let sawThinking = false
  let sentThinkingSignature = false
  let thinkingBlockIndex: number | undefined
  let nextBlockIndex = 0
  const initialServerToolUse = serverToolUseFromBlocks(initialServerToolBlocks)
  let webSearchRequests = initialServerToolUse?.webSearchRequests ?? 0
  /**
   * Completed `web_fetch` calls this turn (Requirement 18.3).
   *
   * Seeded from the preface blocks for the same reason `webSearchRequests` is, and fed from
   * `webFetchRequestsFromBlocks()` rather than from a counter incremented next to the fetch — the
   * block is the evidence a fetch completed, so counting blocks cannot drift from what the client
   * receives. A failed fetch yields an `error` event and no block, so it is not counted.
   */
  let webFetchRequests = initialServerToolUse?.webFetchRequests ?? 0
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

  /**
   * Run one model-emitted call past the interceptors, in order, and yield whatever comes out.
   *
   * The three handlers are chained rather than nested, because each one's "not mine" answer is the
   * same event: the call re-emitted verbatim as `tool_call_done`. So a passthrough from the
   * web-search handler is the signal to offer the call to the web-fetch handler, and a passthrough
   * from that one is the client tool call. The MCP session is asked **first** and by name rather
   * than by passthrough detection, because it is the one handler that can claim an arbitrary tool
   * name — an expanded `mcp__server__tool` — so there is nothing to compare against.
   *
   * Chaining on the identity of the re-emitted call, not merely on the event type, so a handler that
   * legitimately emits a *different* tool call is not mistaken for a passthrough.
   */
  async function* handleKiroToolCall(call: KiroToolCall): AsyncIterable<Canonical_Event> {
    if (mcp?.handles(call.name)) {
      yield* mcp.handleToolCall(call)
      return
    }
    for await (const event of maybeHandleKiroServerTool(call, serverTools)) {
      if (isPassthroughOf(event, call)) {
        yield* maybeHandleKiroWebFetch(call, serverTools)
        continue
      }
      yield event
    }
  }

  async function* emitToolCall(call: KiroToolCall): AsyncIterable<Canonical_Event> {
    let emittedClientTool = false
    for await (const event of handleKiroToolCall(call)) {
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
      if (event.type === "server_tool_block") {
        webFetchRequests += webFetchRequestsFromBlocks(event.blocks)
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
          // Skip Kiro sentinel "(empty)" content — Kiro sends this when the model
          // produces no text before a tool call. It's not real content.
          if (event.content === "(empty)") continue
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
        // Metering branch (design D1). Must stay **before** the token-usage branch:
        // `{"unit":"credit","unitPlural":"credits","usage":0.0148}` carries a numeric `usage`, so
        // reaching the branch below would read 0.0148 as an output-token count — measured as
        // `outputTokens: 0.0148` / `inputTokens: 1296.9852`, which Requirement 5.4 forbids.
        // The `continue` is what buys Requirement 5.4: a metering frame contributes to
        // `providerCredits` and to nothing else — not output tokens, not input-token estimation,
        // not context usage, not the stop reason, not tool-call draining.
        const credits = parseKiroMeteringUsage(event)
        if (credits !== undefined) {
          providerCredits = (providerCredits ?? 0) + credits
          continue
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
  // Three sources, folded left to right: whatever upstream reported, what this turn's server-tool
  // interception observed, and what the MCP session executed. Each member is still omitted when it
  // is zero, so a turn that used none of them keeps reporting no `serverToolUse` at all.
  const serverToolUse = mergeServerToolUse(
    mergeServerToolUse(
      upstreamUsage.serverToolUse,
      webSearchRequests || webFetchRequests
        ? {
            ...(webSearchRequests ? { webSearchRequests } : {}),
            ...(webFetchRequests ? { webFetchRequests } : {}),
          }
        : undefined,
    ),
    mcp?.serverToolUseDelta(),
  )
  yield {
    type: "usage",
    usage: {
      inputTokens: upstreamInputTokens ?? estimateInputTokens(contextUsage, outputTokens, inputTokenEstimate, maxInputTokens),
      outputTokens,
      ...(upstreamUsage.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: upstreamUsage.cacheCreationInputTokens } : {}),
      ...(upstreamUsage.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: upstreamUsage.cacheReadInputTokens } : {}),
      ...(upstreamUsage.outputReasoningTokens !== undefined ? { outputReasoningTokens: upstreamUsage.outputReasoningTokens } : {}),
      ...(providerCredits !== undefined ? { providerCredits } : {}),
      ...(serverToolUse ? { serverToolUse } : {}),
    },
  }
  yield { type: "message_stop", stopReason }
}

/**
 * Whether `event` is an interceptor re-emitting `call` untouched — the documented "not mine" answer
 * of both {@link maybeHandleKiroServerTool} and {@link maybeHandleKiroWebFetch}.
 *
 * All three fields are compared, so a handler that emits some *other* tool call is not read as a
 * declined one and does not get offered to the next handler in the chain.
 */
function isPassthroughOf(event: Canonical_Event, call: KiroToolCall) {
  return event.type === "tool_call_done" && event.callId === call.callId && event.name === call.name && event.arguments === call.arguments
}

function closingTagPrefixSuffixLength(value: string, closeTag: string) {
  const max = Math.min(value.length, closeTag.length - 1)
  for (let length = max; length > 0; length -= 1) {
    if (closeTag.startsWith(value.slice(-length))) return length
  }
  return 0
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

function estimateInputTokens(contextUsage: number | undefined, outputTokens: number, fallback: number, maxInputTokens = DEFAULT_MAX_INPUT_TOKENS) {
  if (typeof contextUsage === "number" && contextUsage > 0) return Math.max(0, Math.floor((contextUsage / 100) * maxInputTokens) - outputTokens)
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
