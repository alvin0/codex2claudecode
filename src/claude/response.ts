import type { ClaudeMessagesRequest, JsonObject } from "../types"

import { countClaudeServerToolCalls, codexOutputItemsToClaudeContent, codexServerToolCallToClaudeBlocks, isServerToolOutputItem } from "./server-tools"
import { consumeCodexSse, parseJsonObject, parseSseJson } from "./sse"
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

export function claudeStreamResponse(response: Response, request: ClaudeMessagesRequest) {
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
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let closed = false
  const upstreamAbort = new AbortController()

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
          if (contentIndex === 0) sendEmptyTextBlock()
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

        try {
          sendMessageStart()
          heartbeat = setInterval(() => send("ping", { type: "ping" }), heartbeatMs)
          try {
            await consumeCodexSse(response.body, (event) => {
              const data = parseSseJson(event)
              if (!data) return

              if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
                if (pendingServerCalls.length) {
                  deferredText += data.delta
                  return
                }
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
                sendTextFallback(data.text)
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
            }, { signal: upstreamAbort.signal })
          } finally {
            clearHeartbeat()
          }
        } catch (error) {
          stopOpenTextBlock()
          sendRaw(claudeStreamErrorEvent(error instanceof Error ? error.message : String(error)))
          closeController()
          return
        }

        stopOpenTextBlock()
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
