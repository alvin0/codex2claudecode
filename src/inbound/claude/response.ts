import type { Canonical_ContentBlock, Canonical_Event, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import type { ClaudeMessagesRequest, JsonObject } from "../types"

import { parseJsonObject } from "./sse"
import { claudeStreamErrorEvent } from "./errors"
import { responseOutputTextToClaudeBlocks } from "./content"

export async function canonicalResponseToClaudeMessage(response: Canonical_Response, request: ClaudeMessagesRequest) {
  return {
    id: response.id.replace(/^resp_/, "msg_"),
    type: "message",
    role: "assistant",
    model: response.model || request.model,
    content: response.content.flatMap(canonicalContentToClaudeBlocks),
    stop_reason: response.stopReason,
    stop_sequence: null,
    usage: canonicalUsageToClaudeUsage(response.usage),
  }
}

export function claudeCanonicalStreamResponse(response: Canonical_StreamResponse, request: ClaudeMessagesRequest, options?: { heartbeatMs?: number; onCancel?: (reason: unknown) => void }) {
  const encoder = new TextEncoder()
  const messageId = response.id.replace(/^resp_/, "msg_")
  const model = response.model || request.model
  const heartbeatMs = options?.heartbeatMs ?? 5000
  let closed = false
  let iterator: AsyncIterator<Canonical_Event> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let started = false
  let textOpen = false
  let thinkingOpen = false
  let thinkingSignature = ""
  let contentIndex = 0
  let outputTokens = 0
  let serverToolUse: { web_search_requests?: number; web_fetch_requests?: number } | undefined
  let stopReason = "end_turn"

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

  return new Response(
    new ReadableStream({
      async start(controller) {
        function send(event: string, data: JsonObject) {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          } catch {
            closed = true
            clearHeartbeat()
            cancelIterator()
          }
        }

        function closeController() {
          if (closed) return
          closed = true
          clearHeartbeat()
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
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
            },
          })
        }

        function startTextBlock() {
          if (textOpen) return
          textOpen = true
          send("content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: { type: "text", text: "" },
          })
        }

        function stopTextBlock() {
          if (!textOpen) return
          send("content_block_stop", { type: "content_block_stop", index: contentIndex })
          textOpen = false
          contentIndex += 1
        }

        function startThinkingBlock() {
          if (thinkingOpen) return
          stopTextBlock()
          thinkingOpen = true
          send("content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: { type: "thinking", thinking: "", signature: thinkingSignature },
          })
        }

        function stopThinkingBlock() {
          if (!thinkingOpen) return
          if (thinkingSignature) {
            send("content_block_delta", {
              type: "content_block_delta",
              index: contentIndex,
              delta: { type: "signature_delta", signature: thinkingSignature },
            })
          }
          send("content_block_stop", { type: "content_block_stop", index: contentIndex })
          thinkingOpen = false
          contentIndex += 1
        }

        function sendServerToolBlocks(blocks: JsonObject[]) {
          for (const block of blocks) {
            stopTextBlock()
            stopThinkingBlock()
            const isServerToolUse = block.type === "server_tool_use" || block.type === "mcp_tool_use"
            send("content_block_start", {
              type: "content_block_start",
              index: contentIndex,
              content_block: isServerToolUse
                ? {
                    type: block.type,
                    id: block.id,
                    name: block.name,
                    ...(block.type === "mcp_tool_use" && { server_name: block.server_name }),
                    input: {},
                  }
                : block,
            })
            if (isServerToolUse && block.input) {
              send("content_block_delta", {
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "input_json_delta", partial_json: "" },
              })
              send("content_block_delta", {
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
              })
            }
            send("content_block_stop", { type: "content_block_stop", index: contentIndex })
            contentIndex += 1
          }
        }

        sendMessageStart()

        try {
          iterator = response.events[Symbol.asyncIterator]()
          if (heartbeatMs > 0) {
            heartbeat = setInterval(() => {
              if (thinkingOpen) {
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: contentIndex,
                  delta: { type: "thinking_delta", thinking: "" },
                })
              } else {
                send("ping", { type: "ping" })
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
              startThinkingBlock()
              send("content_block_delta", {
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "thinking_delta", thinking: event.text ?? event.label ?? "" },
              })
              continue
            }
            if (event.type === "text_delta") {
              stopThinkingBlock()
              startTextBlock()
              send("content_block_delta", {
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "text_delta", text: event.delta },
              })
              continue
            }
            if (event.type === "text_done" && !textOpen) {
              stopThinkingBlock()
              startTextBlock()
              send("content_block_delta", {
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "text_delta", text: event.text },
              })
              continue
            }
            if (event.type === "tool_call_done") {
              stopThinkingBlock()
              stopTextBlock()
              send("content_block_start", {
                type: "content_block_start",
                index: contentIndex,
                content_block: {
                  type: "tool_use",
                  id: event.callId,
                  name: event.name,
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
                delta: { type: "input_json_delta", partial_json: event.arguments },
              })
              send("content_block_stop", { type: "content_block_stop", index: contentIndex })
              contentIndex += 1
              stopReason = "tool_use"
              continue
            }
            if (event.type === "server_tool_block") {
              sendServerToolBlocks(event.blocks)
              continue
            }
            if (event.type === "usage") {
              outputTokens = event.usage.outputTokens ?? outputTokens
              if (event.usage.serverToolUse) {
                serverToolUse = {
                  ...(event.usage.serverToolUse.webSearchRequests ? { web_search_requests: event.usage.serverToolUse.webSearchRequests } : {}),
                  ...(event.usage.serverToolUse.webFetchRequests ? { web_fetch_requests: event.usage.serverToolUse.webFetchRequests } : {}),
                }
              }
              continue
            }
            if (event.type === "completion") {
              stopReason = event.stopReason ?? stopReason
              continue
            }
            if (event.type === "message_stop") {
              stopReason = event.stopReason ?? stopReason
              continue
            }
            if (event.type === "error") {
              stopThinkingBlock()
              stopTextBlock()
              send("error", JSON.parse(claudeStreamErrorEvent(event.message).split("data: ")[1].trim()))
              closeController()
              return
            }
          }

          stopThinkingBlock()
          stopTextBlock()
          send("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: {
              output_tokens: outputTokens,
              ...(serverToolUse ? { server_tool_use: serverToolUse } : {}),
            },
          })
          send("message_stop", { type: "message_stop" })
          closeController()
        } catch (error) {
          send("error", JSON.parse(claudeStreamErrorEvent(error instanceof Error ? error.message : String(error)).split("data: ")[1].trim()))
          closeController()
        } finally {
          clearHeartbeat()
        }
      },
      cancel(reason) {
        closed = true
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
  return {
    input_tokens: usage.inputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: usage.outputTokens,
    ...(usage.serverToolUse
      ? {
          server_tool_use: {
            ...(usage.serverToolUse.webSearchRequests ? { web_search_requests: usage.serverToolUse.webSearchRequests } : {}),
            ...(usage.serverToolUse.webFetchRequests ? { web_fetch_requests: usage.serverToolUse.webFetchRequests } : {}),
            ...(usage.serverToolUse.mcpCalls ? { mcp_calls: usage.serverToolUse.mcpCalls } : {}),
          },
        }
      : {}),
  }
}
