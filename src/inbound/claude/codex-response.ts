import type { ClaudeMessagesRequest, JsonObject } from "../types"

import type { Canonical_Usage } from "../../core/canonical"
import { canonicalUsageFromWireUsage, mergeCanonicalUsage } from "../../core/usage"
import { countClaudeServerToolCalls, codexOutputItemsToClaudeContent, codexServerToolCallToClaudeBlocks, isServerToolOutputItem } from "./server-tools"
import { consumeCodexSse, StreamIdleTimeoutError, parseJsonObject, parseSseJson } from "./sse"
import { claudeStreamErrorEvent } from "./errors"
import { countClaudeInputTokens } from "./convert"

export async function collectClaudeMessage(response: Response, request: ClaudeMessagesRequest) {
  const state = {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    model: request.model,
    text: "",
    content: [] as JsonObject[],
    messageContent: undefined as JsonObject[] | undefined,
    toolUses: [] as Array<{ id: string; name: string; input: unknown }>,
    inputTokens: initialInputTokens(request),
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    mcpCalls: 0,
    stopReason: "end_turn",
  }

  await consumeCodexSse(response.body, (event) => {
    const data = parseSseJson(event)
    if (!data) return

    if (data.type === "response.created") {
      const item = data.response as { id?: unknown; model?: unknown } | undefined
      if (typeof item?.id === "string") state.id = item.id.replace(/^resp_/, "msg_")
      if (typeof item?.model === "string") state.model = item.model
      return
    }

    if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
      state.text += data.delta
      return
    }

    if (data.type === "response.output_text.done" && typeof data.text === "string") {
      state.text = data.text
      return
    }

    if (data.type === "response.output_item.done") {
      const item = data.item as
        | {
            type?: unknown
            id?: unknown
            call_id?: unknown
            name?: unknown
            arguments?: unknown
            action?: unknown
            content?: unknown
          }
        | undefined
      if (isServerToolOutputItem(item)) {
        const blocks = codexServerToolCallToClaudeBlocks(item)
        if (blocks.length) state.content.push(...blocks)
        addServerToolUseCounts(state, countClaudeServerToolCalls([item]))
        return
      }
      if (item?.type === "message" && Array.isArray(item.content)) {
        state.messageContent = codexOutputItemsToClaudeContent([{ type: "message", content: item.content }])
        return
      }
      if (item?.type === "function_call" && typeof item.call_id === "string") {
        state.toolUses.push({
          id: item.call_id,
          name: typeof item.name === "string" ? item.name : "unknown",
          input: parseJsonObject(typeof item.arguments === "string" ? item.arguments : "{}"),
        })
        state.stopReason = "tool_use"
      }
      return
    }

    if (data.type === "response.completed") {
      const item = jsonObjectOrEmpty(data.response) as {
        output?: unknown
        usage?: unknown
        incomplete_details?: { reason?: unknown } | null
      }
      const content = codexOutputItemsToClaudeContent(item.output)
      const serverToolCalls = countClaudeServerToolCalls(item.output)
      if (content.length) state.content = content
      mergeServerToolUseCounts(state, serverToolCalls)
      applyWireUsage(state, item.usage)
      if (item.incomplete_details?.reason === "max_output_tokens") state.stopReason = "max_tokens"
    }

    if (data.type === "response.incomplete") {
      const item = jsonObjectOrEmpty(data.response) as { usage?: unknown }
      applyWireUsage(state, item.usage)
      state.stopReason = "max_tokens"
    }

    if (data.type === "response.failed") {
      const item = jsonObjectOrEmpty(data.response) as { usage?: unknown }
      applyWireUsage(state, item.usage)
      state.stopReason = "end_turn"
    }
  })

  return {
    id: state.id,
    type: "message",
    role: "assistant",
    model: state.model,
    content: [
      ...state.content,
      ...(state.messageContent ?? (state.text ? [{ type: "text", text: state.text }] : [])),
      ...state.toolUses.map((tool) => ({
        type: "tool_use",
        id: tool.id,
        name: tool.name,
        input: tool.input,
      })),
    ],
    stop_reason: state.stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: state.inputTokens,
      cache_creation_input_tokens: state.cacheCreationInputTokens,
      cache_read_input_tokens: state.cacheReadInputTokens,
      output_tokens: state.outputTokens,
      ...(state.webSearchRequests || state.webFetchRequests || state.mcpCalls
        ? {
            server_tool_use: {
              ...(state.webSearchRequests && { web_search_requests: state.webSearchRequests }),
              ...(state.webFetchRequests && { web_fetch_requests: state.webFetchRequests }),
              ...(state.mcpCalls && { mcp_calls: state.mcpCalls }),
            },
          }
        : {}),
    },
  }
}

/**
 * Upstream Responses API event types that indicate the model is actively
 * processing but has not yet produced text output.  When the thinking block
 * is open we forward a human-readable label for each of these so Claude Code
 * sees continuous SSE activity instead of silence.
 *
 * Events with a non-empty label get that label sent as thinking_delta.
 * Events with an empty label are either forwarded verbatim (if in
 * UPSTREAM_THINKING_TEXT_EVENTS) or silently consumed.
 */
const UPSTREAM_THINKING_EVENTS: Record<string, string> = {
  "response.queued": "**Queue** waiting for Codex slot",
  "response.created": "**Codex** session opened",
  "response.in_progress": "**Stream** events flowing",
  "response.output_item.added": "Preparing output",
  "response.content_part.added": "Preparing content",
  "response.reasoning_summary_part.added": "**Reasoning** sketching next step",
  "response.reasoning_summary_text.delta": "",
  "response.reasoning_summary_text.done": "",
  "response.reasoning_summary_part.done": "",
  "response.reasoning_text.delta": "",
  "response.reasoning_text.done": "",
  "response.file_search_call.in_progress": "**Search** scanning files",
  "response.file_search_call.searching": "**Search** scanning files",
  "response.file_search_call.completed": "",
  "response.web_search_call.in_progress": "**Search** querying web",
  "response.web_search_call.searching": "**Search** querying web",
  "response.web_search_call.completed": "",
  "response.code_interpreter_call.in_progress": "**Code** running interpreter",
  "response.code_interpreter_call.interpreting": "**Code** running interpreter",
  "response.code_interpreter_call_code.delta": "",
  "response.code_interpreter_call_code.done": "",
  "response.code_interpreter_call.completed": "",
  "response.mcp_call.in_progress": "**MCP** preparing tool call",
  "response.mcp_call.completed": "",
  "response.mcp_call.failed": "",
  "response.mcp_list_tools.in_progress": "**MCP** refreshing tool list",
  "response.mcp_list_tools.completed": "",
  "response.mcp_list_tools.failed": "",
  "response.mcp_call_arguments.delta": "",
  "response.mcp_call_arguments.done": "",
  "response.function_call_arguments.delta": "",
  "response.function_call_arguments.done": "",
  "response.image_generation_call.in_progress": "**Image** preparing generation",
  "response.image_generation_call.generating": "**Image** rendering pixels",
  "response.image_generation_call.completed": "",
}

/** Event types whose `delta`, `text`, or `code` field should be forwarded verbatim into the thinking block. */
const UPSTREAM_THINKING_TEXT_EVENTS = new Set([
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.code_interpreter_call_code.delta",
  "response.code_interpreter_call_code.done",
])

export function claudeStreamResponse(response: Response, request: ClaudeMessagesRequest, options?: { onStreamError?: (error: string) => void }) {
  const encoder = new TextEncoder()
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`
  const heartbeatMs = 5000
  let started = false
  let contentStarted = false
  let contentIndex = 0
  let inputTokens = initialStreamInputTokens(request)
  let outputTokens = 0
  let cacheCreationInputTokens = 0
  let cacheReadInputTokens = 0
  let webSearchRequests = 0
  let webFetchRequests = 0
  let mcpCalls = 0
  const pendingServerCalls: unknown[] = []
  let deferredText = ""
  let stopReason = "end_turn"
  let emittedText = ""
  let emittedAnyContent = false
  let receivedTerminalEvent = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let closed = false
  const upstreamAbort = new AbortController()

  // Thinking block state: emits a synthetic thinking content block while
  // upstream is processing (no text deltas yet) so Claude Code sees
  // continuous SSE activity instead of silence.  Upstream lifecycle events
  // (response.created, response.in_progress, reasoning summaries, etc.)
  // are forwarded as thinking_delta content.
  let thinkingBlockOpen = false
  let thinkingStarted = false
  const thinkingSignature = `sig_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`
  const outputItems = new Map<string, CodexOutputItemState>()

  function clearHeartbeat() {
    if (!heartbeat) return
    clearInterval(heartbeat)
    heartbeat = undefined
  }

  function abortUpstream(reason: unknown) {
    if (upstreamAbort.signal.aborted) return
    upstreamAbort.abort(reason)
  }

  return new Response(
    new ReadableStream({
      async start(controller) {
        function sendRaw(raw: string) {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(raw))
          } catch (error) {
            closed = true
            clearHeartbeat()
            abortUpstream(error)
          }
        }

        function send(event: string, data: JsonObject) {
          sendRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }

        function closeController() {
          if (closed) return
          closed = true
          controller.close()
        }

        function sendMessageStart() {
          if (started) return
          started = true
          send("message_start", {
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              model: request.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: inputTokens,
                cache_creation_input_tokens: cacheCreationInputTokens,
                cache_read_input_tokens: cacheReadInputTokens,
                output_tokens: outputTokens,
              },
            },
          })
        }

        // ── Thinking block helpers ──────────────────────────────────

        function openThinkingBlock() {
          if (thinkingStarted) return
          thinkingStarted = true
          thinkingBlockOpen = true
          send("content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: { type: "thinking", thinking: "", signature: thinkingSignature },
          })
        }

        function sendThinkingDelta(text: string) {
          if (!thinkingBlockOpen) return
          send("content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "thinking_delta", thinking: text },
          })
        }

        function closeThinkingBlock() {
          if (!thinkingBlockOpen) return
          thinkingBlockOpen = false
          send("content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "signature_delta", signature: thinkingSignature },
          })
          send("content_block_stop", { type: "content_block_stop", index: contentIndex })
          contentIndex += 1
        }

        /**
         * Forward an upstream event into the thinking block.  If the event
         * carries text content (reasoning summary, code interpreter code)
         * we send the actual text; otherwise we send a short status label.
         */
        function forwardToThinking(eventType: string, data: JsonObject) {
          if (!thinkingBlockOpen) return

          // Events with verbatim text content
          if (UPSTREAM_THINKING_TEXT_EVENTS.has(eventType)) {
            const text = typeof data.delta === "string" ? data.delta
              : typeof data.text === "string" ? data.text
              : typeof data.code === "string" ? data.code
              : ""
            if (text) sendThinkingDelta(text)
            return
          }

          // Status label events — prefer concrete upstream payload details when present.
          const label = dynamicThinkingLabel(eventType, data, outputItems) ?? UPSTREAM_THINKING_EVENTS[eventType]
          if (label) sendThinkingDelta(formatThinkingLabel(label))
        }

        // ── Text / content helpers ──────────────────────────────────

        function markTextEmitted(text: string) {
          emittedText += text
          emittedAnyContent = true
        }

        function remainingText(text: string) {
          if (!emittedText) return text
          return text.startsWith(emittedText) ? text.slice(emittedText.length) : ""
        }

        function stopOpenTextBlock() {
          if (!contentStarted) return
          send("content_block_stop", { type: "content_block_stop", index: contentIndex })
          contentIndex += 1
          contentStarted = false
        }

        function sendEmptyTextBlock() {
          send("content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: { type: "text", text: "" },
          })
          send("content_block_stop", { type: "content_block_stop", index: contentIndex })
          contentIndex += 1
          emittedAnyContent = true
        }

        function sendTextBlock(text: string) {
          if (!text) return
          send("content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: { type: "text", text: "" },
          })
          send("content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "text_delta", text },
          })
          send("content_block_stop", { type: "content_block_stop", index: contentIndex })
          contentIndex += 1
          markTextEmitted(text)
        }

        function sendTextFallback(text: string) {
          const next = remainingText(text)
          if (!next) return
          if (!contentStarted) {
            sendTextBlock(next)
            return
          }
          send("content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "text_delta", text: next },
          })
          markTextEmitted(next)
        }

        function sendWebResultBlock(block: JsonObject) {
          send("content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: block,
          })
          send("content_block_stop", { type: "content_block_stop", index: contentIndex })
          contentIndex += 1
          emittedAnyContent = true
        }

        function sendServerToolUseBlock(block: JsonObject) {
          if (!emittedAnyContent) sendEmptyTextBlock()
          const isMcp = block.type === "mcp_tool_use"
          send("content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: {
              type: isMcp ? "mcp_tool_use" : "server_tool_use",
              id: block.id,
              name: block.name,
              ...(isMcp && { server_name: block.server_name }),
              input: {},
            },
          })
          send("content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "input_json_delta", partial_json: "" },
          })
          send("content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
          })
          send("content_block_stop", { type: "content_block_stop", index: contentIndex })
          contentIndex += 1
          emittedAnyContent = true
        }

        function sendContentBlocks(blocks: JsonObject[]) {
          blocks.forEach((block) => {
            if (block.type === "text" && typeof block.text === "string") {
              sendTextFallback(block.text)
              return
            }
            stopOpenTextBlock()
            if (block.type === "server_tool_use" || block.type === "mcp_tool_use") sendServerToolUseBlock(block)
            else sendWebResultBlock(block)
          })
        }

        // ── Main stream loop ────────────────────────────────────────

        try {
          sendMessageStart()
          openThinkingBlock()
          heartbeat = setInterval(() => {
            if (thinkingBlockOpen) {
              sendThinkingDelta("")
            } else {
              send("ping", { type: "ping" })
            }
          }, heartbeatMs)
          try {
            await consumeCodexSse(response.body, (event) => {
              const data = parseSseJson(event)
              if (!data) return
              const eventType = typeof data.type === "string" ? data.type : ""
              trackOutputItemState(eventType, data, outputItems)

              // ── Forward lifecycle / reasoning events into thinking ──
              if (thinkingBlockOpen && eventType in UPSTREAM_THINKING_EVENTS) {
                forwardToThinking(eventType, data)
                // Verbatim text events are fully consumed here.
                if (UPSTREAM_THINKING_TEXT_EVENTS.has(eventType)) return
                // All other intercepted events are informational — consume them.
                return
              }

              if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
                if (pendingServerCalls.length) {
                  deferredText += data.delta
                  return
                }
                closeThinkingBlock()
                if (!contentStarted) {
                  contentStarted = true
                  send("content_block_start", {
                    type: "content_block_start",
                    index: contentIndex,
                    content_block: { type: "text", text: "" },
                  })
                }
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: contentIndex,
                  delta: { type: "text_delta", text: data.delta },
                })
                markTextEmitted(data.delta)
                return
              }

              if (data.type === "response.output_text.done" && typeof data.text === "string") {
                if (pendingServerCalls.length) {
                  deferredText += remainingText(data.text)
                  return
                }
                closeThinkingBlock()
                sendTextFallback(data.text)
                return
              }

              if (data.type === "response.output_item.done") {
                closeThinkingBlock()
                const item = data.item as
                  | {
                      type?: unknown
                      id?: unknown
                      call_id?: unknown
                      name?: unknown
                      arguments?: unknown
                      action?: unknown
                      content?: unknown
                      output?: unknown
                    }
                  | undefined
                if (isServerToolOutputItem(item)) {
                  const blocks = codexServerToolCallToClaudeBlocks(item)
                  const resultBlocks = blocks.filter((block) => block.type !== "server_tool_use" && block.type !== "mcp_tool_use")
                  addServerToolUseCounts({ webSearchRequests, webFetchRequests, mcpCalls }, countClaudeServerToolCalls([item]), (counts) => {
                    webSearchRequests = counts.webSearchRequests
                    webFetchRequests = counts.webFetchRequests
                    mcpCalls = counts.mcpCalls
                  })

                  if (resultBlocks.length) {
                    stopOpenTextBlock()
                    blocks.forEach((block) => {
                      if (block.type === "server_tool_use" || block.type === "mcp_tool_use") sendServerToolUseBlock(block)
                      else sendWebResultBlock(block)
                    })
                    return
                  }
                  pendingServerCalls.push(item)
                  return
                }
                if (item?.type === "message" && Array.isArray(item.content)) {
                  sendContentBlocks(codexOutputItemsToClaudeContent([{ type: "message", content: item.content }]))
                  return
                }
                if (item?.type !== "function_call" || typeof item.call_id !== "string") return

                stopOpenTextBlock()

                send("content_block_start", {
                  type: "content_block_start",
                  index: contentIndex,
                  content_block: {
                    type: "tool_use",
                    id: item.call_id,
                    name: typeof item.name === "string" ? item.name : "unknown",
                    input: {},
                  },
                })
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: contentIndex,
                  delta: {
                    type: "input_json_delta",
                    partial_json: "",
                  },
                })
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: contentIndex,
                  delta: {
                    type: "input_json_delta",
                    partial_json: typeof item.arguments === "string" ? item.arguments : "{}",
                  },
                })
                send("content_block_stop", { type: "content_block_stop", index: contentIndex })
                contentIndex += 1
                emittedAnyContent = true
                stopReason = "tool_use"
                return
              }

              if (data.type === "response.completed") {
                closeThinkingBlock()
                receivedTerminalEvent = true
                const item = jsonObjectOrEmpty(data.response) as {
                  output?: unknown
                  usage?: unknown
                  incomplete_details?: { reason?: unknown } | null
                }
                const usage = canonicalUsageFromWireUsage(item.usage)
                inputTokens = usage.inputTokens ?? inputTokens
                outputTokens = usage.outputTokens ?? outputTokens
                cacheCreationInputTokens = usage.cacheCreationInputTokens ?? cacheCreationInputTokens
                cacheReadInputTokens = usage.cacheReadInputTokens ?? cacheReadInputTokens
                const mergedCounts = mergedServerToolUseCounts({ webSearchRequests, webFetchRequests, mcpCalls }, usage.serverToolUse)
                webSearchRequests = mergedCounts.webSearchRequests
                webFetchRequests = mergedCounts.webFetchRequests
                mcpCalls = mergedCounts.mcpCalls
                const outputCounts = mergedServerToolUseCounts({ webSearchRequests, webFetchRequests, mcpCalls }, countClaudeServerToolCalls(item.output))
                webSearchRequests = outputCounts.webSearchRequests
                webFetchRequests = outputCounts.webFetchRequests
                mcpCalls = outputCounts.mcpCalls
                if (pendingServerCalls.length) {
                  const content = codexOutputItemsToClaudeContent(item.output)
                  content.forEach((block) => {
                    if (block.type === "server_tool_use" || block.type === "mcp_tool_use") sendServerToolUseBlock(block)
                    else if (block.type !== "text") sendWebResultBlock(block)
                  })
                  const text = content
                    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
                    .join("")
                  sendTextBlock(text || deferredText)
                  pendingServerCalls.length = 0
                  deferredText = ""
                }
                if (!emittedAnyContent) sendContentBlocks(codexOutputItemsToClaudeContent(item.output))
                if (item.incomplete_details?.reason === "max_output_tokens") stopReason = "max_tokens"
              }

              // Upstream ended early — surface the reason to the client.
              if (data.type === "response.incomplete") {
                closeThinkingBlock()
                receivedTerminalEvent = true
                const item = jsonObjectOrEmpty(data.response) as {
                  incomplete_details?: { reason?: unknown } | null
                  usage?: unknown
                }
                const usage = canonicalUsageFromWireUsage(item.usage)
                inputTokens = usage.inputTokens ?? inputTokens
                outputTokens = usage.outputTokens ?? outputTokens
                cacheCreationInputTokens = usage.cacheCreationInputTokens ?? cacheCreationInputTokens
                cacheReadInputTokens = usage.cacheReadInputTokens ?? cacheReadInputTokens
                const mergedCounts = mergedServerToolUseCounts({ webSearchRequests, webFetchRequests, mcpCalls }, usage.serverToolUse)
                webSearchRequests = mergedCounts.webSearchRequests
                webFetchRequests = mergedCounts.webFetchRequests
                mcpCalls = mergedCounts.mcpCalls
                stopReason = "max_tokens"
              }

              // Upstream generation failed — send the error to the client.
              if (data.type === "response.failed") {
                closeThinkingBlock()
                receivedTerminalEvent = true
                const item = jsonObjectOrEmpty(data.response) as {
                  error?: { message?: unknown }
                  usage?: unknown
                }
                const usage = canonicalUsageFromWireUsage(item.usage)
                inputTokens = usage.inputTokens ?? inputTokens
                outputTokens = usage.outputTokens ?? outputTokens
                cacheCreationInputTokens = usage.cacheCreationInputTokens ?? cacheCreationInputTokens
                cacheReadInputTokens = usage.cacheReadInputTokens ?? cacheReadInputTokens
                const mergedCounts = mergedServerToolUseCounts({ webSearchRequests, webFetchRequests, mcpCalls }, usage.serverToolUse)
                webSearchRequests = mergedCounts.webSearchRequests
                webFetchRequests = mergedCounts.webFetchRequests
                mcpCalls = mergedCounts.mcpCalls
                const errorMsg = typeof item.error?.message === "string" ? item.error.message : "Upstream generation failed"
                console.error(`[stream] upstream failed: ${errorMsg}`)
                options?.onStreamError?.(errorMsg)
                stopOpenTextBlock()
                sendRaw(claudeStreamErrorEvent(errorMsg))
                closeController()
                abortUpstream(errorMsg)
                return
              }
            }, { signal: upstreamAbort.signal })
          } finally {
            clearHeartbeat()
          }
        } catch (error) {
          closeThinkingBlock()
          stopOpenTextBlock()
          const isIdleTimeout = error instanceof StreamIdleTimeoutError
          const message = isIdleTimeout
            ? `Stream timeout: upstream stopped sending data. ${error.message}`
            : error instanceof Error ? error.message : String(error)
          if (isIdleTimeout) console.warn(`[stream] ${message}`)
          else console.error(`[stream] error: ${message}`)
          options?.onStreamError?.(message)
          sendRaw(claudeStreamErrorEvent(message))
          closeController()
          return
        }

        closeThinkingBlock()
        stopOpenTextBlock()
        if (!receivedTerminalEvent && stopReason === "end_turn") {
          stopReason = "max_tokens"
          const msg = "Stream ended without completion event (possible truncation)"
          console.warn(`[stream] ${msg}`)
          options?.onStreamError?.(msg)
        }
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {
            input_tokens: inputTokens,
            cache_creation_input_tokens: cacheCreationInputTokens,
            cache_read_input_tokens: cacheReadInputTokens,
            output_tokens: outputTokens,
            ...(webSearchRequests || webFetchRequests || mcpCalls
              ? {
                  server_tool_use: {
                    ...(webSearchRequests && { web_search_requests: webSearchRequests }),
                    ...(webFetchRequests && { web_fetch_requests: webFetchRequests }),
                    ...(mcpCalls && { mcp_calls: mcpCalls }),
                  },
                }
              : {}),
          },
        })
        send("message_stop", { type: "message_stop" })
        closeController()
      },
      cancel() {
        closed = true
        clearHeartbeat()
        abortUpstream("client disconnected")
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    },
  )
}

function jsonObjectOrEmpty(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

interface ServerToolUseCounter {
  webSearchRequests: number
  webFetchRequests: number
  mcpCalls: number
}

function applyWireUsage(state: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number } & ServerToolUseCounter, wireUsage: unknown) {
  const usage = canonicalUsageFromWireUsage(wireUsage)
  mergeCanonicalUsage(state, usage)
  mergeServerToolUseCounts(state, usage.serverToolUse)
}

function addServerToolUseCounts(
  state: ServerToolUseCounter,
  counts: Partial<ServerToolUseCounter> | undefined,
  commit?: (next: ServerToolUseCounter) => void,
) {
  const next = {
    webSearchRequests: state.webSearchRequests + (counts?.webSearchRequests ?? 0),
    webFetchRequests: state.webFetchRequests + (counts?.webFetchRequests ?? 0),
    mcpCalls: state.mcpCalls + (counts?.mcpCalls ?? 0),
  }
  if (commit) commit(next)
  else {
    state.webSearchRequests = next.webSearchRequests
    state.webFetchRequests = next.webFetchRequests
    state.mcpCalls = next.mcpCalls
  }
}

function mergeServerToolUseCounts(state: ServerToolUseCounter, counts: Canonical_Usage["serverToolUse"] | undefined) {
  const merged = mergedServerToolUseCounts(state, counts)
  state.webSearchRequests = merged.webSearchRequests
  state.webFetchRequests = merged.webFetchRequests
  state.mcpCalls = merged.mcpCalls
}

function mergedServerToolUseCounts(state: ServerToolUseCounter, counts: Canonical_Usage["serverToolUse"] | undefined): ServerToolUseCounter {
  return {
    webSearchRequests: Math.max(state.webSearchRequests, counts?.webSearchRequests ?? 0),
    webFetchRequests: Math.max(state.webFetchRequests, counts?.webFetchRequests ?? 0),
    mcpCalls: Math.max(state.mcpCalls, counts?.mcpCalls ?? 0),
  }
}

function initialStreamInputTokens(request: ClaudeMessagesRequest) {
  return initialInputTokens(request)
}

function initialInputTokens(request: ClaudeMessagesRequest) {
  const hasCountableInput = request.messages.length > 0
    || Boolean(request.system)
    || Boolean(request.tools?.length)
    || Boolean(request.mcp_servers?.length)
    || Boolean(request.tool_choice)
    || Boolean(request.thinking)
    || Boolean(request.output_config)
  return hasCountableInput ? countClaudeInputTokens(request) : 0
}

interface CodexOutputItemState {
  type?: string
  name?: string
  arguments: string
}

function dynamicThinkingLabel(type: string, data: JsonObject, outputItems: Map<string, CodexOutputItemState>) {
  if (type === "response.output_item.added") return outputItemAddedLabel(jsonObjectOrEmpty(data.item) as JsonObject)
  if (type === "response.content_part.added") return contentPartAddedLabel(jsonObjectOrEmpty(data.part) as JsonObject)
  if (type === "response.function_call_arguments.done") return functionCallArgumentsLabel(data, outputItems)
  return undefined
}

function trackOutputItemState(type: string, data: JsonObject, outputItems: Map<string, CodexOutputItemState>) {
  if (type === "response.output_item.added") {
    const item = jsonObjectOrEmpty(data.item) as JsonObject
    const entry: CodexOutputItemState = {
      type: typeof item.type === "string" ? item.type : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
      arguments: typeof item.arguments === "string" ? item.arguments : "",
    }
    for (const key of outputItemKeys(data, item)) outputItems.set(key, entry)
    return
  }

  if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
    const item = jsonObjectOrEmpty(data.item) as JsonObject
    const keys = outputItemKeys(data, item)
    const entry = keys.map((key) => outputItems.get(key)).find(Boolean) ?? {
      type: typeof item.type === "string" ? item.type : "function_call",
      name: typeof item.name === "string" ? item.name : undefined,
      arguments: "",
    }
    if (typeof item.name === "string") entry.name = item.name
    if (typeof data.delta === "string") entry.arguments += data.delta
    if (typeof data.arguments === "string") entry.arguments = data.arguments
    if (typeof item.arguments === "string") entry.arguments = item.arguments
    for (const key of keys) outputItems.set(key, entry)
  }
}

function outputItemKeys(data: JsonObject, item: JsonObject) {
  return [
    data.item_id,
    item.id,
    item.call_id,
    typeof item.call_id === "string" ? `call:${item.call_id}` : undefined,
  ].filter((key, index, keys): key is string => typeof key === "string" && key.length > 0 && keys.indexOf(key) === index)
}

function functionCallArgumentsLabel(data: JsonObject, outputItems: Map<string, CodexOutputItemState>) {
  const item = jsonObjectOrEmpty(data.item) as JsonObject
  const entry = outputItemKeys(data, item).map((key) => outputItems.get(key)).find(Boolean)
  const name = entry?.name ?? (typeof item.name === "string" ? item.name : "tool")
  const args = typeof data.arguments === "string" ? data.arguments
    : typeof item.arguments === "string" ? item.arguments
    : entry?.arguments ?? ""
  const summary = summarizeToolArguments(args, name)
  return summary ? formatThinkingLabel(`**Tool request** \`${name}\`:\n${summary}`) : formatThinkingLabel(`**Tool** preparing \`${name}\``)
}

function outputItemAddedLabel(item: JsonObject) {
  if (item.type === "function_call") {
    const name = typeof item.name === "string" && item.name ? item.name : "tool"
    return formatThinkingLabel(`**Tool** preparing \`${name}\``)
  }
  if (item.type === "mcp_call") {
    const name = typeof item.name === "string" && item.name ? item.name : "tool"
    return formatThinkingLabel(`**MCP** preparing \`${name}\``)
  }
  if (item.type === "mcp_list_tools") {
    const server = typeof item.server_label === "string" && item.server_label ? item.server_label : "MCP"
    return formatThinkingLabel(`**MCP** listing \`${server}\` tools`)
  }
  if (item.type === "web_search_call") return formatThinkingLabel("**Search** querying web")
  if (item.type === "message") {
    if (item.phase === "commentary") return formatThinkingLabel("**Commentary** drafting update")
    if (item.phase === "analysis") return formatThinkingLabel("**Thinking** mapping next move")
    return formatThinkingLabel("**Response** composing answer")
  }
  if (item.type === "reasoning") return formatThinkingLabel("**Reasoning** sketching next step")
  return undefined
}

function contentPartAddedLabel(part: JsonObject) {
  if (part.type === "output_text") return formatThinkingLabel("**Output** opening text stream")
  if (part.type === "reasoning_text") return formatThinkingLabel("**Reasoning** streaming notes")
  if (part.type === "refusal") return formatThinkingLabel("**Safety** preparing refusal")
  return undefined
}

function summarizeToolArguments(argumentsJson: string, toolName: string) {
  const parsed = jsonObjectOrEmpty(parseJsonObject(argumentsJson)) as JsonObject
  const normalizedToolName = toolName.toLowerCase()

  if (Array.isArray(parsed.todos)) {
    return truncateLabel(
      parsed.todos
        .flatMap((todo) => {
          if (!todo || typeof todo !== "object") return []
          const item = todo as { content?: unknown; status?: unknown }
          if (typeof item.content !== "string" || !item.content) return []
          return [typeof item.status === "string" ? `[${item.status}] ${item.content}` : item.content]
        })
        .slice(0, 3)
        .map((content) => `- ${content}`)
        .join("\n"),
    )
  }

  if (normalizedToolName === "bash" || normalizedToolName === "powershell") {
    return summarizeFields(parsed, ["command", "description", "timeout", "workdir"])
  }

  const fieldSummary = summarizeFields(parsed, ["file_path", "path", "pattern", "query", "url", "prompt", "value", "workdir"])
  if (fieldSummary) return fieldSummary

  const keys = Object.keys(parsed)
  if (keys.length) return summarizeFields(parsed, keys.slice(0, 4))
  return truncateLabel(argumentsJson)
}

function summarizeFields(value: JsonObject, fields: string[]) {
  return truncateLabel(
    fields
      .flatMap((field) => {
        const fieldValue = value[field]
        if (fieldValue === undefined || fieldValue === null) return []
        if (typeof fieldValue === "string" || typeof fieldValue === "number" || typeof fieldValue === "boolean") {
          return [`- **${field}**: ${formatFieldValue(fieldValue)}`]
        }
        if (Array.isArray(fieldValue)) return [`- **${field}**: ${fieldValue.length} item${fieldValue.length === 1 ? "" : "s"}`]
        if (typeof fieldValue === "object") return [`- **${field}**: \`${JSON.stringify(fieldValue)}\``]
        return []
      })
      .join("\n"),
  )
}

function formatFieldValue(value: string | number | boolean) {
  if (typeof value === "number" || typeof value === "boolean") return `\`${String(value)}\``
  const escaped = value.replace(/`/g, "\\`")
  return `\`${escaped}\``
}

function truncateLabel(value: string) {
  const compact = value.replace(/[^\S\r\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
  return compact.length > 600 ? `${compact.slice(0, 588)} [truncated]` : compact
}

function formatThinkingLabel(value: string) {
  return `${value.trimEnd()}\n`
}
