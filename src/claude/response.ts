import type { ClaudeMessagesRequest, JsonObject } from "../types"

import { consumeCodexSse, parseJsonObject, parseSseJson } from "./sse"
import { claudeWebResultHasContent, codexMessageContentToClaudeBlocks, codexOutputItemsToClaudeContent, codexWebCallToClaudeBlocks, countCodexWebCalls } from "./web"

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
      if (item?.type === "web_search_call") {
        const blocks = codexWebCallToClaudeBlocks(item)
        state.content.push(...blocks.content)
        if (blocks.name === "web_fetch") state.webFetchRequests += 1
        else state.webSearchRequests += 1
        return
      }
      if (item?.type === "message" && Array.isArray(item.content)) {
        state.messageContent = item.content.flatMap((content) => codexMessageContentToClaudeBlocks(content))
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
      const item = data.response as {
        output?: unknown
        usage?: { input_tokens?: unknown; output_tokens?: unknown }
        incomplete_details?: { reason?: unknown } | null
      }
      const content = codexOutputItemsToClaudeContent(item.output)
      const webCalls = countCodexWebCalls(item.output)
      if (content.length) state.content = content
      if (webCalls.webSearchRequests || webCalls.webFetchRequests) {
        state.webSearchRequests = webCalls.webSearchRequests
        state.webFetchRequests = webCalls.webFetchRequests
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
  let started = false
  let contentStarted = false
  let contentIndex = 0
  let inputTokens = 0
  let outputTokens = 0
  let webSearchRequests = 0
  let webFetchRequests = 0
  const pendingWebCalls: Array<{ id?: unknown; action?: unknown }> = []
  let deferredText = ""
  let stopReason = "end_turn"

  return new Response(
    new ReadableStream({
      async start(controller) {
        function send(event: string, data: JsonObject) {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        }

        function sendEmptyTextBlock() {
          send("content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: { type: "text", text: "" },
          })
          send("content_block_stop", { type: "content_block_stop", index: contentIndex })
          contentIndex += 1
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
        }

        function sendWebResultBlock(block: JsonObject) {
          send("content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: block,
          })
          send("content_block_stop", { type: "content_block_stop", index: contentIndex })
          contentIndex += 1
        }

        function sendServerToolUseBlock(block: JsonObject) {
          if (contentIndex === 0) sendEmptyTextBlock()
          send("content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: {
              type: "server_tool_use",
              id: block.id,
              name: block.name,
            },
          })
          send("content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
          })
          send("content_block_stop", { type: "content_block_stop", index: contentIndex })
          contentIndex += 1
        }

        await consumeCodexSse(response.body, (event) => {
          const data = parseSseJson(event)
          if (!data) return

          if (!started) {
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

          if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
            if (pendingWebCalls.length) {
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
            return
          }

          if (data.type === "response.output_item.done") {
            const item = data.item as
              | { type?: unknown; id?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown; action?: unknown }
              | undefined
            if (item?.type === "web_search_call") {
              const blocks = codexWebCallToClaudeBlocks(item)
              if (blocks.name === "web_fetch") webFetchRequests += 1
              else webSearchRequests += 1

              if (claudeWebResultHasContent(blocks.content[1])) {
                if (contentStarted) {
                  send("content_block_stop", { type: "content_block_stop", index: contentIndex })
                  contentIndex += 1
                  contentStarted = false
                }
                sendServerToolUseBlock(blocks.content[0])
                sendWebResultBlock(blocks.content[1])
                return
              }
              pendingWebCalls.push(item)
              return
            }
            if (item?.type !== "function_call" || typeof item.call_id !== "string") return

            if (contentStarted) {
              send("content_block_stop", { type: "content_block_stop", index: contentIndex })
              contentIndex += 1
              contentStarted = false
            }

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
            stopReason = "tool_use"
            return
          }

          if (data.type === "response.completed") {
            const item = data.response as {
              output?: unknown
              usage?: { input_tokens?: unknown; output_tokens?: unknown }
              incomplete_details?: { reason?: unknown } | null
            }
            if (typeof item.usage?.input_tokens === "number") inputTokens = item.usage.input_tokens
            if (typeof item.usage?.output_tokens === "number") outputTokens = item.usage.output_tokens
            if (!webSearchRequests && !webFetchRequests) {
              const webCalls = countCodexWebCalls(item.output)
              webSearchRequests = webCalls.webSearchRequests
              webFetchRequests = webCalls.webFetchRequests
            }
            if (pendingWebCalls.length) {
              const content = codexOutputItemsToClaudeContent(item.output)
              content.forEach((block, index) => {
                if (block.type !== "server_tool_use") return
                const result = content[index + 1]
                if (!result || !claudeWebResultHasContent(result)) return
                sendServerToolUseBlock(block)
                sendWebResultBlock(result)
              })
              const text = content
                .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
                .join("")
              sendTextBlock(text || deferredText)
              pendingWebCalls.length = 0
              deferredText = ""
            }
            if (item.incomplete_details?.reason === "max_output_tokens") stopReason = "max_tokens"
          }
        })

        if (!started) {
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

        if (contentStarted) send("content_block_stop", { type: "content_block_stop", index: contentIndex })
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
        controller.close()
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
