import type { Canonical_ContentBlock, Canonical_Event, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import type { ClaudeMessagesRequest, JsonObject } from "../types"

import { parseJsonObject } from "./sse"
import { claudeErrorBody } from "./errors"
import { responseOutputTextToClaudeBlocks } from "./content"
import { countClaudeInputTokens } from "./convert"
import { mergeCanonicalUsage, mergeServerToolUse } from "../../core/usage"
import { ClaudeSseWriter } from "./sse-writer"

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
              writer.textDelta(event.delta)
              continue
            }
            if (event.type === "text_done" && !writer.isTextOpen) {
              if (!event.text) continue
              writer.stopThinkingBlock(thinkingSignature)
              writer.startTextBlock()
              writer.textDelta(event.text)
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
