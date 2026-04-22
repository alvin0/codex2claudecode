import type { ChatCompletionRequest, ClaudeMessagesRequest, JsonObject } from "../../../types"
import { codexWebCallToClaudeBlocks } from "../../../claude/web"

import { collectKiroEvents } from "./parser"
import type { KiroCollectedResponse, KiroParsedEvent } from "./types"

export async function collectKiroResponse(response: Response): Promise<KiroCollectedResponse> {
  const events = await collectKiroEvents(response)
  const state: KiroCollectedResponse = { content: "", events }

  for (const event of events) {
    if (event.type === "content") state.content += event.content
    if (event.type === "thinking") state.thinking = `${state.thinking ?? ""}${event.thinking}`
    if (event.type === "tool_use") state.toolUses = [...(state.toolUses ?? []), event.toolUse]
    if (event.type === "web_search") state.webSearches = [...(state.webSearches ?? []), {
      toolUseId: event.toolUseId,
      query: event.query,
      results: event.results,
      summary: event.summary,
    }]
    if (event.type === "usage") state.usage = event.usage
    if (event.type === "context_usage") state.contextUsagePercentage = event.contextUsagePercentage
  }

  return state
}

export function anthropicStreamResponse(response: Response, request: ClaudeMessagesRequest) {
  const encoder = new TextEncoder()
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`

  return new Response(
    new ReadableStream({
      async start(controller) {
        const collected = await collectKiroResponse(response)
        const send = (event: string, data: JsonObject) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        }

        let blockIndex = 0
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
            usage: anthroUsage(collected.usage),
          },
        })

        for (const event of collected.events ?? []) {
          if (event.type === "thinking") {
            send("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "thinking", thinking: "" },
            })
            if (event.thinking) {
              send("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "thinking_delta", thinking: event.thinking },
              })
            }
            send("content_block_stop", { type: "content_block_stop", index: blockIndex })
            blockIndex += 1
            continue
          }

          if (event.type === "content") {
            send("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "text", text: "" },
            })
            if (event.content) {
              send("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "text_delta", text: event.content },
              })
            }
            send("content_block_stop", { type: "content_block_stop", index: blockIndex })
            blockIndex += 1
            continue
          }

          if (event.type === "tool_use") {
            send("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: event.toolUse.id,
                name: event.toolUse.name,
                input: {},
              },
            })
            send("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(event.toolUse.input) },
            })
            send("content_block_stop", { type: "content_block_stop", index: blockIndex })
            blockIndex += 1
          }
        }

        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: collected.toolUses?.length ? "tool_use" : "end_turn", stop_sequence: null },
          usage: anthroUsage(collected.usage),
        })
        send("message_stop", { type: "message_stop" })
        controller.close()
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    },
  )
}

export function openAiStreamResponse(response: Response, request: ChatCompletionRequest) {
  const encoder = new TextEncoder()
  const id = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`
  const created = Math.floor(Date.now() / 1000)

  return new Response(
    new ReadableStream({
      async start(controller) {
        const collected = await collectKiroResponse(response)
        const send = (data: JsonObject | string) => {
          controller.enqueue(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`))
        }

        let firstChunk = true
        for (const event of collected.events ?? []) {
          if (event.type === "content") {
            send({
              id,
              object: "chat.completion.chunk",
              created,
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    ...(firstChunk ? { role: "assistant" } : {}),
                    content: event.content,
                  },
                  finish_reason: null,
                },
              ],
            })
            firstChunk = false
            continue
          }

          if (event.type === "thinking") {
            send({
              id,
              object: "chat.completion.chunk",
              created,
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    ...(firstChunk ? { role: "assistant" } : {}),
                    reasoning_content: event.thinking,
                  },
                  finish_reason: null,
                },
              ],
            })
            firstChunk = false
          }
        }

        if (collected.toolUses?.length) {
          send({
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: collected.toolUses.map((toolUse, index) => ({
                    index,
                    id: toolUse.id,
                    type: "function",
                    function: {
                      name: toolUse.name,
                      arguments: JSON.stringify(toolUse.input),
                    },
                  })),
                },
                finish_reason: null,
              },
            ],
          })
        }

        send({
          id,
          object: "chat.completion.chunk",
          created,
          model: request.model,
          choices: [{ index: 0, delta: {}, finish_reason: collected.toolUses?.length ? "tool_calls" : "stop" }],
          usage: openAiUsage(collected.usage),
        })
        send("[DONE]")
        controller.close()
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    },
  )
}

export function anthropicJsonResponse(collected: KiroCollectedResponse, request: ClaudeMessagesRequest) {
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: request.model,
    content: [
      ...(collected.thinking ? [{ type: "thinking", thinking: collected.thinking }] : []),
      ...(collected.content ? [{ type: "text", text: collected.content }] : []),
      ...(collected.toolUses ?? []).map((tool) => ({
        type: "tool_use",
        id: tool.id,
        name: tool.name,
        input: tool.input,
      })),
      ...(collected.webSearches ?? []).flatMap((search) =>
        codexWebCallToClaudeBlocks(
          { id: search.toolUseId, action: { query: search.query, sources: search.results } },
          search.results.map((result) => ({
            url: result.url,
            title: result.title,
            encrypted_content: result.encrypted_content ?? result.text ?? "",
          })),
        ).content,
      ),
    ],
    stop_reason: collected.toolUses?.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: anthroUsage(collected.usage),
  }
}

export function openAiJsonResponse(collected: KiroCollectedResponse, request: ChatCompletionRequest) {
  return {
    id: `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: collected.content,
          ...(collected.thinking ? { reasoning_content: collected.thinking } : {}),
          ...(collected.toolUses?.length
            ? {
                tool_calls: collected.toolUses.map((toolUse) => ({
                  id: toolUse.id,
                  type: "function",
                  function: {
                    name: toolUse.name,
                    arguments: JSON.stringify(toolUse.input),
                  },
                })),
              }
            : {}),
        },
        finish_reason: collected.toolUses?.length ? "tool_calls" : "stop",
      },
    ],
    usage: openAiUsage(collected.usage),
  }
}

function anthroUsage(usage?: Record<string, unknown>) {
  return {
    input_tokens: numberFromUsage(usage, "input_tokens", "inputTokens", "promptTokens"),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: numberFromUsage(usage, "output_tokens", "outputTokens", "completionTokens"),
  }
}

function openAiUsage(usage?: Record<string, unknown>) {
  return {
    prompt_tokens: numberFromUsage(usage, "prompt_tokens", "promptTokens", "inputTokens", "input_tokens"),
    completion_tokens: numberFromUsage(usage, "completion_tokens", "completionTokens", "outputTokens", "output_tokens"),
    total_tokens:
      numberFromUsage(usage, "prompt_tokens", "promptTokens", "inputTokens", "input_tokens") +
      numberFromUsage(usage, "completion_tokens", "completionTokens", "outputTokens", "output_tokens"),
  }
}

function numberFromUsage(usage: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = usage?.[key]
    if (typeof value === "number") return value
  }
  return 0
}
