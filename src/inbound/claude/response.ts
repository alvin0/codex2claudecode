import type { Canonical_ContentBlock, Canonical_Event, Canonical_FeatureNotice, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import type { ClaudeMessagesRequest, JsonObject } from "../types"

import { parseJsonObject } from "./sse"
import { claudeErrorBody } from "./errors"
import { responseOutputTextToClaudeBlocks } from "./content"
import { countClaudeInputTokens } from "./convert"
import { prependClaudeWarning, renderClaudeFeatureWarning } from "./notice"
import { mergeCanonicalUsage, mergeServerToolUse } from "../../core/usage"
import type { StreamTelemetryCollector } from "../../core/stream-telemetry"
import { ClaudeSseWriter } from "./sse-writer"

export async function canonicalResponseToClaudeMessage(response: Canonical_Response, request: ClaudeMessagesRequest) {
  return {
    id: response.id.replace(/^resp_/, "msg_"),
    type: "message",
    role: "assistant",
    model: response.model || request.model,
    content: withClaudeWarning(response.content.flatMap(canonicalContentToClaudeBlocks), renderClaudeFeatureWarning(response.featureNotices ?? [])),
    stop_reason: response.stopReason,
    stop_sequence: null,
    usage: canonicalUsageToClaudeUsage(response.usage),
  }
}

/**
 * Places a rendered warning as leading text of the first text block — the non-streaming half of
 * the `payloadTrimWarning` channel (design D2). Identity on an empty warning, so a response with
 * no degrade notice, and one carrying only `emulate` notices, render byte-identically to the
 * pre-change output (Requirement 9.2).
 *
 * A response with no text block gets one created ahead of its other blocks; that is the only way
 * the notice reaches a client on a tool-call-only response, and a text block is not a new block
 * type, SSE event name, or header (Requirement 9.6).
 */
function withClaudeWarning(content: JsonObject[], warning: string): JsonObject[] {
  if (!warning) return content
  const index = content.findIndex((block) => block.type === "text" && typeof block.text === "string")
  if (index < 0) return [{ type: "text", text: warning }, ...content]
  const block = content[index] as JsonObject
  const warned = [...content]
  warned[index] = { ...block, text: prependClaudeWarning(String(block.text), warning) }
  return warned
}

/**
 * The bytes that turn already-emitted `text` into `text` + separator + `warning`, for a notice
 * that arrived too late to lead the text block. `prependClaudeWarning()` owns that separator, so
 * the segment is derived from it rather than restating `"\n\n"` here — Requirement 9.5 keeps the
 * notice wording, punctuation included, inside `notice.ts`. The argument order is deliberate:
 * what gets prepended is the text the client already saw.
 */
function trailingWarningSegment(text: string, warning: string) {
  return prependClaudeWarning(warning, text).slice(text.length)
}

export function claudeCanonicalStreamResponse(response: Canonical_StreamResponse, request: ClaudeMessagesRequest, options?: { heartbeatMs?: number; onCancel?: (reason: unknown) => void; telemetry?: StreamTelemetryCollector }) {
  const messageId = response.id.replace(/^resp_/, "msg_")
  const model = response.model || request.model
  const heartbeatMs = options?.heartbeatMs ?? 5000
  let iterator: AsyncIterator<Canonical_Event> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let thinkingSignature = ""
  let inputTokens = initialStreamInputTokens(request)
  let outputTokens = 0
  let cacheCreationInputTokens = 0
  let cacheReadInputTokens = 0
  let serverToolUse: Canonical_Response["usage"]["serverToolUse"] | undefined
  let stopReason = "end_turn"
  let writer: ClaudeSseWriter
  // Notices decided while the payload was built arrive before any content, so they wait here
  // until the first text delta goes out (design D2's `pendingWarning`). Ones decided mid-stream
  // keep waiting until the stream ends and then trail the current text block.
  const pendingNotices: Canonical_FeatureNotice[] = []
  // Every text byte the client has seen, so the placement helpers can tell "nothing spoken yet"
  // from "already spoke". Stays empty for a request that never emitted text.
  let streamedText = ""

  /** Renders and clears the queued notices. `""` when they were all `emulate` (Requirement 9.2). */
  function takePendingWarning() {
    if (!pendingNotices.length) return ""
    const warning = renderClaudeFeatureWarning(pendingNotices)
    pendingNotices.length = 0
    return warning
  }

  /** The single place text reaches the client, so warning placement sees exactly what it saw. */
  function emitText(text: string) {
    if (!text) return
    writer.textDelta(text)
    streamedText += text
  }

  /**
   * Returns `delta` with the queued warning in front of it, for the first text the stream emits —
   * the streaming half of the `payloadTrimWarning` path: ordinary `content_block_delta` with a
   * `text_delta`, no new event name and no new block type (Requirement 9.6). The warning and the
   * first model bytes ride one delta so `prependClaudeWarning()` stays the only owner of the
   * separator. Once text has been emitted this is the identity and the notices stay queued for
   * {@link flushTrailingWarning}, which keeps the warning to one segment (Requirement 9.4).
   */
  function withPendingWarning(delta: string) {
    if (streamedText) return delta
    return prependClaudeWarning(delta, takePendingWarning())
  }

  /**
   * Last chance for a notice decided after text was already emitted (design D2's ordering rule for
   * late notices): the warning trails the current text block rather than splitting it. Runs once,
   * after the event loop and before the open blocks are closed.
   */
  function flushTrailingWarning() {
    const warning = takePendingWarning()
    if (!warning) return
    if (writer.isTextOpen) {
      emitText(trailingWarningSegment(streamedText, warning))
      return
    }
    // No text block is open to trail, so one is created for the warning — the streaming
    // counterpart of the non-streaming "only if the response has none".
    writer.stopThinkingBlock(thinkingSignature)
    writer.startTextBlock()
    emitText(warning)
  }

  function clearHeartbeat() {
    if (!heartbeat) return
    clearInterval(heartbeat)
    heartbeat = undefined
  }

  function cancelIterator() {
    const current = iterator
    iterator = undefined
    void current?.return?.().catch(() => undefined)
  }

  function closeStream() {
    if (writer.isClosed) return
    clearHeartbeat()
    writer.close()
  }

  return new Response(
    new ReadableStream({
      async start(controller) {
        writer = new ClaudeSseWriter(controller)

        writer.messageStart({
          id: messageId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            cache_creation_input_tokens: cacheCreationInputTokens,
            cache_read_input_tokens: cacheReadInputTokens,
            output_tokens: outputTokens,
          },
        })

        try {
          iterator = response.events[Symbol.asyncIterator]()
          if (heartbeatMs > 0) {
            heartbeat = setInterval(() => {
              if (writer.isThinkingOpen) {
                writer.thinkingDelta("")
              } else {
                writer.ping()
              }
            }, heartbeatMs)
          }

          while (true) {
            const chunk = await iterator.next()
            if (chunk.done) break
            const event = chunk.value
            if (event.type === "message_start") continue
            if (event.type === "thinking_signature") {
              thinkingSignature = event.signature
              continue
            }
            if (event.type === "thinking_delta") {
              writer.startThinkingBlock(thinkingSignature)
              writer.thinkingDelta(event.text ?? event.label ?? "")
              continue
            }
            if (event.type === "text_delta") {
              if (!event.delta) continue
              writer.stopThinkingBlock(thinkingSignature)
              writer.startTextBlock()
              emitText(withPendingWarning(event.delta))
              continue
            }
            if (event.type === "text_done" && !writer.isTextOpen) {
              if (!event.text) continue
              writer.stopThinkingBlock(thinkingSignature)
              writer.startTextBlock()
              emitText(withPendingWarning(event.text))
              continue
            }
            if (event.type === "feature_notice") {
              // Token- and content-neutral (Requirement 8.4): the notice is only recorded and
              // queued here — nothing is started, stopped, or flushed — so a notice arriving
              // between two text deltas cannot split the text block.
              options?.telemetry?.recordFeatureNotice(event)
              pendingNotices.push({ feature: event.feature, policy: event.policy, detail: event.detail })
              continue
            }
            if (event.type === "tool_call_done") {
              writer.stopThinkingBlock(thinkingSignature)
              writer.toolUseBlock(event.callId, event.name, event.arguments)
              stopReason = "tool_use"
              continue
            }
            if (event.type === "server_tool_block") {
              writer.serverToolBlocks(event.blocks)
              continue
            }
            if (event.type === "usage") {
              const usage = { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }
              mergeCanonicalUsage(usage, event.usage)
              inputTokens = usage.inputTokens
              outputTokens = usage.outputTokens
              cacheCreationInputTokens = usage.cacheCreationInputTokens ?? 0
              cacheReadInputTokens = usage.cacheReadInputTokens ?? 0
              serverToolUse = mergeServerToolUse(serverToolUse, event.usage.serverToolUse)
              // Provider spend rides the usage channel but is not a token count, so it goes
              // to telemetry only and never into the Claude wire usage block.
              if (typeof event.usage.providerCredits === "number") options?.telemetry?.recordProviderCredits(event.usage.providerCredits)
              continue
            }
            if (event.type === "completion") {
              const usage = { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }
              mergeCanonicalUsage(usage, event.usage ?? {})
              inputTokens = usage.inputTokens
              outputTokens = usage.outputTokens
              cacheCreationInputTokens = usage.cacheCreationInputTokens ?? 0
              cacheReadInputTokens = usage.cacheReadInputTokens ?? 0
              serverToolUse = mergeServerToolUse(serverToolUse, event.usage?.serverToolUse)
              if (typeof event.usage?.providerCredits === "number") options?.telemetry?.recordProviderCredits(event.usage.providerCredits)
              stopReason = event.stopReason ?? stopReason
              continue
            }
            if (event.type === "message_stop") {
              stopReason = event.stopReason ?? stopReason
              continue
            }
            if (event.type === "error") {
              writer.closeOpenBlocks(thinkingSignature)
              writer.error(claudeErrorBody(event.message, 500))
              closeStream()
              return
            }
          }

          flushTrailingWarning()
          writer.closeOpenBlocks(thinkingSignature)
          const wireServerToolUse = claudeServerToolUse(serverToolUse)
          writer.messageDelta(stopReason, {
            input_tokens: inputTokens,
            cache_creation_input_tokens: cacheCreationInputTokens,
            cache_read_input_tokens: cacheReadInputTokens,
            output_tokens: outputTokens,
            ...(wireServerToolUse ? { server_tool_use: wireServerToolUse } : {}),
          })
          writer.messageStop()
          closeStream()
        } catch (error) {
          writer.error(claudeErrorBody(error instanceof Error ? error.message : String(error), 500))
          closeStream()
        } finally {
          clearHeartbeat()
          cancelIterator()
        }
      },
      cancel(reason) {
        clearHeartbeat()
        options?.onCancel?.(reason)
        const current = iterator
        iterator = undefined
        void current?.return?.({ type: "lifecycle", label: String(reason ?? "client disconnected") }).catch(() => undefined)
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    },
  )
}

function canonicalContentToClaudeBlocks(block: Canonical_ContentBlock): JsonObject[] {
  if (block.type === "text") return responseOutputTextToClaudeBlocks({ type: "output_text", text: block.text, annotations: block.annotations })
  if (block.type === "tool_call") {
    return [
      {
        type: "tool_use",
        id: block.callId,
        name: block.name,
        input: parseJsonObject(block.arguments),
      },
    ]
  }
  if (block.type === "server_tool") return block.blocks
  if (block.type === "thinking") return [{ type: "thinking", thinking: block.thinking, signature: block.signature }]
  return []
}

function canonicalUsageToClaudeUsage(usage: Canonical_Response["usage"]) {
  const serverToolUse = claudeServerToolUse(usage.serverToolUse)
  return {
    input_tokens: usage.inputTokens,
    cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
    cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
    output_tokens: usage.outputTokens,
    ...(serverToolUse ? { server_tool_use: serverToolUse } : {}),
  }
}

function claudeServerToolUse(usage: Canonical_Response["usage"]["serverToolUse"] | undefined) {
  if (!usage) return
  const wire = {
    ...(usage.webSearchRequests ? { web_search_requests: usage.webSearchRequests } : {}),
    ...(usage.webFetchRequests ? { web_fetch_requests: usage.webFetchRequests } : {}),
    ...(usage.mcpCalls ? { mcp_calls: usage.mcpCalls } : {}),
  }
  return Object.keys(wire).length ? wire : undefined
}

function initialStreamInputTokens(request: ClaudeMessagesRequest) {
  const hasCountableInput = request.messages.length > 0
    || Boolean(request.system)
    || Boolean(request.tools?.length)
    || Boolean(request.mcp_servers?.length)
    || Boolean(request.tool_choice)
    || Boolean(request.thinking)
    || Boolean(request.output_config)
  return hasCountableInput ? countClaudeInputTokens(request) : 0
}
