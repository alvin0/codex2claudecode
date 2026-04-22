import type { ChatCompletionRequest, ClaudeMessagesRequest, JsonObject } from "../../../types"
import { codexWebCallToClaudeBlocks } from "../../../claude/web"

import { collectKiroEvents, streamKiroEvents } from "./parser"
import type { KiroCollectedResponse } from "./types"

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

function extractLastUserText(request: ClaudeMessagesRequest): string | undefined {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const msg = request.messages[i]
    if (msg?.role !== "user") continue
    const content = msg.content
    if (typeof content === "string") {
      const cleaned = stripSystemTags(content).trim()
      if (cleaned) return cleaned
      continue
    }
    if (!Array.isArray(content)) continue
    // Walk blocks in reverse so the last plain-text block wins
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j]
      if (!block || typeof block !== "object") continue
      const b = block as { type?: string; text?: string; cache_control?: unknown }
      if (b.type !== "text" || typeof b.text !== "string") continue
      const cleaned = stripSystemTags(b.text).trim()
      if (cleaned) return cleaned
    }
  }
  return undefined
}

/** Remove <system-reminder>, <ide_opened_file>, and similar wrapper tags. */
function stripSystemTags(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "")
    .replace(/<context_window[\s\S]*?<\/context_window>/g, "")
    .trim()
}

export type McpCallFn = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>

export function anthropicStreamResponse(
  response: Response,
  request: ClaudeMessagesRequest,
  options?: { mcpCall?: McpCallFn },
) {
  const encoder = new TextEncoder()
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`
  const thinkingSignature = `sig_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`
  const mcpCall = options?.mcpCall

  return new Response(
    new ReadableStream({
      async start(controller) {
        let closed = false
        const send = (event: string, data: JsonObject) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          } catch {
            closed = true
          }
        }

        // Anthropic streaming spec requires strict block ordering:
        //   thinking (index 0) → text (index 1) → tool_use (index 2+)
        // Each block: content_block_start → N×content_block_delta → content_block_stop
        // Thinking blocks need signature_delta before content_block_stop.
        //
        // Kiro API may emit content before <thinking> tags (e.g. leading
        // whitespace).  We buffer any pre-thinking content and prepend it to
        // the first real text block so the block order stays valid.

        let blockIndex = 0
        let thinkingBlockOpen = false
        let thinkingEverOpened = false
        let textBlockOpen = false
        let hasToolUse = false
        let webSearchRequests = 0
        let lastUsage: Record<string, unknown> | undefined
        let preThinkingBuffer = ""
        const searchedQueries = new Set<string>()

        function closeThinkingBlock() {
          if (!thinkingBlockOpen) return
          send("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "signature_delta", signature: thinkingSignature },
          })
          send("content_block_stop", { type: "content_block_stop", index: blockIndex })
          blockIndex += 1
          thinkingBlockOpen = false
        }

        function closeTextBlock() {
          if (!textBlockOpen) return
          send("content_block_stop", { type: "content_block_stop", index: blockIndex })
          blockIndex += 1
          textBlockOpen = false
        }

        function ensureTextBlock() {
          if (textBlockOpen) return
          textBlockOpen = true
          send("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "text", text: "" },
          })
          // Flush any content that arrived before the thinking block
          if (preThinkingBuffer) {
            send("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "text_delta", text: preThinkingBuffer },
            })
            preThinkingBuffer = ""
          }
        }

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

        try {
          for await (const event of streamKiroEvents(response)) {
            if (closed) break

            if (event.type === "thinking") {
              // Open thinking block on first thinking chunk
              if (!thinkingBlockOpen) {
                thinkingBlockOpen = true
                thinkingEverOpened = true
                send("content_block_start", {
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: { type: "thinking", thinking: "", signature: "" },
                })
              }
              if (event.thinking) {
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "thinking_delta", thinking: event.thinking },
                })
              }
              continue
            }

            if (event.type === "content") {
              // If thinking hasn't started yet, buffer content (Kiro may send
              // whitespace before <thinking> tags).
              if (!thinkingEverOpened) {
                preThinkingBuffer += event.content ?? ""
                continue
              }
              // Close thinking block before transitioning to text
              closeThinkingBlock()
              ensureTextBlock()
              if (event.content) {
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text: event.content },
                })
              }
              continue
            }

            if (event.type === "tool_use") {
              closeThinkingBlock()

              const toolName = event.toolUse.name
              const toolInput = event.toolUse.input
              let query = typeof toolInput.query === "string" ? toolInput.query : ""

              // Intercept WebSearch tool calls: call MCP API and inject
              // results as a text block.  Claude Code does not support
              // server_tool_use / web_search_tool_result block types from
              // a proxy, so we surface results as plain text that the model
              // can reference in its answer.
              if ((toolName === "WebSearch" || toolName === "web_search") && mcpCall) {
                // Fallback: extract query from the last user message when
                // the model omits it (Kiro sometimes sends empty input).
                if (!query) {
                  query = extractLastUserText(request) ?? ""
                }
                if (!query) continue // nothing to search

                // Deduplicate: skip if we already searched this exact query
                if (searchedQueries.has(query)) continue
                searchedQueries.add(query)

                // Call MCP API
                let summaryLines: string[] = []
                try {
                  const mcpResult = await mcpCall("tools/call", { name: "web_search", arguments: { query } })
                  const resultData = mcpResult?.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined
                  if (resultData && !resultData.isError && resultData.content?.[0]?.text) {
                    const parsed = JSON.parse(resultData.content[0].text) as { results?: Array<{ title?: string; url?: string; snippet?: string }> }
                    for (const r of parsed.results ?? []) {
                      const parts = [r.title, r.url, r.snippet].filter(Boolean)
                      if (parts.length) summaryLines.push(parts.join(" — "))
                    }
                  }
                } catch { /* MCP call failed */ }

                const summaryText = summaryLines.length
                  ? `[Web search: "${query}"]\n\n${summaryLines.join("\n\n")}`
                  : `[Web search: "${query}"]\n\nNo results found.`

                // Emit as a text block
                ensureTextBlock()
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text: summaryText },
                })
                continue
              }

              // Normal tool_use (non-WebSearch)
              closeTextBlock()
              hasToolUse = true
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
              continue
            }

            if (event.type === "usage") {
              lastUsage = event.usage
              continue
            }
          }
        } catch (error) {
          console.error(`[kiro-stream] error during streaming: ${error instanceof Error ? error.message : String(error)}`)
        }

        // If we only got pre-thinking content and no thinking block ever
        // opened, flush the buffer as a normal text block now.
        if (preThinkingBuffer && !thinkingEverOpened) {
          ensureTextBlock()
        }

        closeThinkingBlock()
        closeTextBlock()

        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: hasToolUse ? "tool_use" : "end_turn", stop_sequence: null },
          usage: anthroUsage(lastUsage),
        })
        send("message_stop", { type: "message_stop" })
        if (!closed) controller.close()
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
        let closed = false
        const send = (data: JsonObject | string) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`))
          } catch {
            closed = true
          }
        }

        let firstChunk = true
        const pendingToolUses: Array<{ id: string; name: string; input: JsonObject }> = []
        let lastUsage: Record<string, unknown> | undefined

        try {
          for await (const event of streamKiroEvents(response)) {
            if (closed) break

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
              continue
            }

            if (event.type === "tool_use") {
              pendingToolUses.push(event.toolUse)
              continue
            }

            if (event.type === "usage") {
              lastUsage = event.usage
              continue
            }
          }
        } catch (error) {
          console.error(`[kiro-stream] error during OpenAI streaming: ${error instanceof Error ? error.message : String(error)}`)
        }

        if (pendingToolUses.length) {
          send({
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: pendingToolUses.map((toolUse, index) => ({
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
          choices: [{ index: 0, delta: {}, finish_reason: pendingToolUses.length ? "tool_calls" : "stop" }],
          usage: openAiUsage(lastUsage),
        })
        send("[DONE]")
        if (!closed) controller.close()
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
