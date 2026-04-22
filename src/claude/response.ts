import type { ClaudeMessagesRequest, JsonObject } from "../types"

import { countClaudeServerToolCalls, codexOutputItemsToClaudeContent, codexServerToolCallToClaudeBlocks, isServerToolOutputItem } from "./server-tools"
import { consumeCodexSse, StreamIdleTimeoutError, parseJsonObject, parseSseJson } from "./sse"
import { claudeStreamErrorEvent } from "./errors"

export async function collectClaudeMessage(response: Response, request: ClaudeMessagesRequest) {
  const state = {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    model: request.model,
    text: "",
    content: [] as JsonObject[],
    messageContent: undefined as JsonObject[] | undefined,
    toolUses: [] as Array<{ id: string; name: string; input: unknown }>,
    inputTokens: 0,
    outputTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
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
        usage?: { input_tokens?: unknown; output_tokens?: unknown }
        incomplete_details?: { reason?: unknown } | null
      }
      const content = codexOutputItemsToClaudeContent(item.output)
      const serverToolCalls = countClaudeServerToolCalls(item.output)
      if (content.length) state.content = content
      if (serverToolCalls.webSearchRequests || serverToolCalls.webFetchRequests) {
        state.webSearchRequests = serverToolCalls.webSearchRequests
        state.webFetchRequests = serverToolCalls.webFetchRequests
      }
      if (typeof item.usage?.input_tokens === "number") state.inputTokens = item.usage.input_tokens
      if (typeof item.usage?.output_tokens === "number") state.outputTokens = item.usage.output_tokens
      if (item.incomplete_details?.reason === "max_output_tokens") state.stopReason = "max_tokens"
    }

    if (data.type === "response.incomplete") {
      state.stopReason = "max_tokens"
    }

    if (data.type === "response.failed") {
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
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: state.outputTokens,
      ...(state.webSearchRequests || state.webFetchRequests
        ? {
            server_tool_use: {
              ...(state.webSearchRequests && { web_search_requests: state.webSearchRequests }),
              ...(state.webFetchRequests && { web_fetch_requests: state.webFetchRequests }),
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
  "response.queued": "Queued…",
  "response.created": "Initializing…",
  "response.in_progress": "Processing…",
  "response.output_item.added": "Preparing output…",
  "response.content_part.added": "Preparing content…",
  "response.reasoning_summary_part.added": "Reasoning…",
  "response.reasoning_summary_text.delta": "",
  "response.reasoning_summary_text.done": "",
  "response.reasoning_summary_part.done": "",
  "response.reasoning_text.delta": "",
  "response.reasoning_text.done": "",
  "response.file_search_call.in_progress": "Searching files…",
  "response.file_search_call.searching": "Searching files…",
  "response.file_search_call.completed": "",
  "response.web_search_call.in_progress": "Searching web…",
  "response.web_search_call.searching": "Searching web…",
  "response.web_search_call.completed": "",
  "response.code_interpreter_call.in_progress": "Running code…",
  "response.code_interpreter_call.interpreting": "Running code…",
  "response.code_interpreter_call_code.delta": "",
  "response.code_interpreter_call_code.done": "",
  "response.code_interpreter_call.completed": "",
  "response.mcp_call.in_progress": "Calling MCP tool…",
  "response.mcp_call.completed": "",
  "response.mcp_call.failed": "",
  "response.mcp_list_tools.in_progress": "Listing MCP tools…",
  "response.mcp_list_tools.completed": "",
  "response.mcp_list_tools.failed": "",
  "response.mcp_call_arguments.delta": "",
  "response.mcp_call_arguments.done": "",
  "response.function_call_arguments.delta": "",
  "response.function_call_arguments.done": "",
  "response.image_generation_call.in_progress": "Generating image…",
  "response.image_generation_call.generating": "Generating image…",
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
  let outputTokens = 0
  let webSearchRequests = 0
  let webFetchRequests = 0
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
              usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
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

          // Status label events — only send if label is non-empty
          const label = UPSTREAM_THINKING_EVENTS[eventType]
          if (label) sendThinkingDelta(label)
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
            },
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
                  if (item?.type === "web_search_call") {
                    const counts = countClaudeServerToolCalls([item])
                    webSearchRequests += counts.webSearchRequests
                    webFetchRequests += counts.webFetchRequests
                  }

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
                  usage?: { input_tokens?: unknown; output_tokens?: unknown }
                  incomplete_details?: { reason?: unknown } | null
                }
                if (typeof item.usage?.output_tokens === "number") outputTokens = item.usage.output_tokens
                if (!webSearchRequests && !webFetchRequests) {
                  const counts = countClaudeServerToolCalls(item.output)
                  webSearchRequests = counts.webSearchRequests
                  webFetchRequests = counts.webFetchRequests
                }
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
                  usage?: { output_tokens?: unknown }
                }
                if (typeof item.usage?.output_tokens === "number") outputTokens = item.usage.output_tokens
                stopReason = "max_tokens"
              }

              // Upstream generation failed — send the error to the client.
              if (data.type === "response.failed") {
                closeThinkingBlock()
                receivedTerminalEvent = true
                const item = jsonObjectOrEmpty(data.response) as {
                  error?: { message?: unknown }
                  usage?: { output_tokens?: unknown }
                }
                if (typeof item.usage?.output_tokens === "number") outputTokens = item.usage.output_tokens
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
            output_tokens: outputTokens,
            ...(webSearchRequests || webFetchRequests
              ? {
                  server_tool_use: {
                    ...(webSearchRequests && { web_search_requests: webSearchRequests }),
                    ...(webFetchRequests && { web_fetch_requests: webFetchRequests }),
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
