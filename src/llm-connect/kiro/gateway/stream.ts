import type { ChatCompletionRequest, ClaudeMessagesRequest, JsonObject } from "../../../types"
import { codexWebCallToClaudeBlocks } from "../../../claude/web"

import { collectKiroEvents, streamKiroEvents, FirstTokenTimeoutError } from "./parser"
import type { KiroCollectedResponse } from "./types"
import { getCachedWebSearchSummary } from "./web-result-cache"
import { buildWebResultAnswer, extractWebResultAnswerFromMessages, extractWebResultSummaryFromMessages } from "./web-result-text"

export async function collectKiroResponse(response: Response): Promise<KiroCollectedResponse> {
  const events = await collectKiroEvents(response)
  const state: KiroCollectedResponse = { content: "", events, completed: false }
  const seenToolUseIds = new Set<string>()

  for (const event of events) {
    if (event.type === "content") state.content += event.content
    if (event.type === "thinking") state.thinking = `${state.thinking ?? ""}${event.thinking}`
    if (event.type === "tool_use") {
      if (shouldFilterKiroToolUse(event.toolUse) || seenToolUseIds.has(event.toolUse.id)) continue
      seenToolUseIds.add(event.toolUse.id)
      state.toolUses = [...(state.toolUses ?? []), event.toolUse]
    }
    if (event.type === "web_search") state.webSearches = [...(state.webSearches ?? []), {
      toolUseId: event.toolUseId,
      query: event.query,
      results: event.results,
      summary: event.summary,
    }]
    if (event.type === "usage") {
      state.usage = event.usage
      state.completed = true
    }
    if (event.type === "context_usage") {
      state.contextUsagePercentage = event.contextUsagePercentage
      state.completed = true
    }
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
        let hasEmittedTextOrTool = false
        let webSearchRequests = 0
        let filteredToolCalls = 0
        let lastUsage: Record<string, unknown> | undefined
        let sawCompletionSignal = false
        let preThinkingBuffer = ""
        let suppressedThinkingText = ""
        const emittedToolUseIds = new Set<string>()

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
          hasEmittedTextOrTool = true
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

        let streamError: Error | undefined
        try {
          for await (const event of streamKiroEvents(response)) {
            if (closed) break

            if (event.type === "thinking") {
              if (event.thinking) suppressedThinkingText += event.thinking
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
                const recoveredContent = recoverSuppressedThinkingAnswer(suppressedThinkingText, event.content)
                suppressedThinkingText = ""
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text: recoveredContent },
                })
              }
              continue
            }

            if (event.type === "tool_use") {
              closeThinkingBlock()

              if (emittedToolUseIds.has(event.toolUse.id) || shouldFilterKiroToolUse(event.toolUse)) {
                console.warn(
                  `[kiro-stream] filtering out unsupported/empty tool call: ${event.toolUse.name} ` +
                  `(input keys: ${Object.keys(event.toolUse.input).length})`,
                )
                filteredToolCalls++
                continue
              }
              emittedToolUseIds.add(event.toolUse.id)

              closeTextBlock()
              suppressedThinkingText = ""
              hasToolUse = true
              hasEmittedTextOrTool = true
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
              sawCompletionSignal = true
              continue
            }

            if (event.type === "context_usage") {
              sawCompletionSignal = true
              continue
            }
          }
        } catch (error) {
          streamError = error instanceof Error ? error : new Error(String(error))
          if (error instanceof FirstTokenTimeoutError) {
            console.error(`[kiro-stream] first token timeout: ${error.message}`)
          } else {
            console.error(`[kiro-stream] error during streaming: ${error instanceof Error ? error.message : String(error)}`)
          }
        }

        // If we only got pre-thinking content and no thinking block ever
        // opened, flush the buffer as a normal text block now.
        if (preThinkingBuffer && !thinkingEverOpened) {
          ensureTextBlock()
        }

        closeThinkingBlock()
        closeTextBlock()

        // Anthropic streaming spec requires at least one text content
        // block in the response.  When the model only produced thinking
        // (no text, no tool_use), emit an empty text block so Claude Code
        // does not receive a message with zero content blocks.
        //
        // If the stream was interrupted by an error, include a brief
        // notice so the user knows something went wrong rather than
        // seeing a completely blank response.
        //
        // If the model only produced thinking (e.g. it wanted to use a
        // tool that isn't available, like web_fetch after a web_search),
        // emit a helpful notice instead of a blank response.
        const cachedWebSummary = getCachedWebSearchSummary(request, extractLastUserText(request))
        const fallbackWebAnswer =
          extractWebResultAnswerFromMessages(request.messages, extractLastUserText(request)) ||
          cachedWebSummary

        if (hasEmittedTextOrTool && !hasToolUse && filteredToolCalls > 0 && webSearchRequests === 0) {
          const fallbackText =
            fallbackWebAnswer ||
            extractWebResultSummaryFromMessages(request.messages) ||
            "The web search completed, but no readable result content was available to summarize."

          send("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "text", text: "" },
          })
          send("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "text_delta", text: `\n\n${fallbackText}` },
          })
          send("content_block_stop", { type: "content_block_stop", index: blockIndex })
          blockIndex += 1
        }

        if (!hasEmittedTextOrTool && !hasToolUse && webSearchRequests === 0) {
          let fallbackText = ""
          if (streamError) {
            fallbackText = "[Stream interrupted] The response was cut short due to a connection issue. Please try again."
          } else if (filteredToolCalls > 0) {
            // Model tried to use unsupported tools (e.g. WebFetch after
            // a web search).  This typically means the search results
            // contained enough data but the model wanted more detail.
            // Return the available result text instead of ending with a
            // placeholder that sounds like a continuation.
            fallbackText =
              fallbackWebAnswer ||
              extractWebResultSummaryFromMessages(request.messages) ||
              "The web search completed, but no readable result content was available to summarize."
          } else if (cachedWebSummary) {
            fallbackText = cachedWebSummary
          } else if (thinkingEverOpened) {
            fallbackText =
              "I wasn't able to generate a complete response. " +
              "Please try rephrasing your question or providing more context."
          }

          send("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "text", text: "" },
          })
          if (fallbackText) {
            send("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "text_delta", text: fallbackText },
            })
          }
          send("content_block_stop", { type: "content_block_stop", index: blockIndex })
          blockIndex += 1
        }

        const contentWasTruncated = !sawCompletionSignal && hasEmittedTextOrTool && !hasToolUse && filteredToolCalls === 0
        const stopReason = hasToolUse ? "tool_use" : contentWasTruncated ? "max_tokens" : "end_turn"

        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {
            ...anthroUsage(lastUsage),
            ...(webSearchRequests > 0
              ? { server_tool_use: { web_search_requests: webSearchRequests } }
              : {}),
          },
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

function recoverSuppressedThinkingAnswer(thinking: string, content: string) {
  const answerTail = extractAnswerTailFromThinking(thinking)
  if (answerTail) return mergeOverlappingText(answerTail, content)
  const genericContinuation = extractGenericThinkingContinuation(thinking, content)
  if (!genericContinuation) return content
  return stitchThinkingContinuation(genericContinuation, content)
}

function shouldFilterKiroToolUse(toolUse: { name: string; input: JsonObject }) {
  const isEmptyInput = Object.keys(toolUse.input).length === 0
  const isUnsupportedTool = /^WebFetch$/i.test(toolUse.name)
  return isUnsupportedTool || (isEmptyInput && toolUse.name !== "WebSearch")
}

function extractGenericThinkingContinuation(thinking: string, content: string) {
  const trimmedContent = content.replace(/^\s+/, "")
  if (!trimmedContent || !/^[\p{Ll}\p{Lo}\p{M}]/u.test(trimmedContent)) return ""

  const normalized = thinking
    .replace(/\s+/g, " ")
    .trim()
  if (!normalized) return ""

  const tail = normalized.slice(-120)
  const boundary = Math.max(
    tail.lastIndexOf(". "),
    tail.lastIndexOf("! "),
    tail.lastIndexOf("? "),
    tail.lastIndexOf("\n"),
  )
  const clause = (boundary >= 0 ? tail.slice(boundary + 1) : tail).trimStart()
  const lastToken = clause.match(/([\p{L}\p{N}_-]{1,32})$/u)?.[1] ?? ""
  if (!lastToken || lastToken.length > 3) return ""
  return clause
}

function stitchThinkingContinuation(prefix: string, suffix: string) {
  if (!prefix) return suffix
  if (!suffix) return prefix
  const leadingWhitespace = suffix.match(/^\s*/)?.[0] ?? ""
  const trimmedSuffix = suffix.slice(leadingWhitespace.length)
  if (trimmedSuffix && /[\p{L}\p{N}]$/u.test(prefix) && /^[\p{L}\p{N}]/u.test(trimmedSuffix)) {
    return `${prefix}${trimmedSuffix}`
  }
  if (leadingWhitespace) return `${prefix}${suffix}`
  return mergeOverlappingText(prefix, suffix)
}

function extractAnswerTailFromThinking(thinking: string) {
  const normalized = thinking.replace(/^\s+/, "")
  if (!normalized) return ""

  const patterns = [
    /(?:Gia|Giá)\s+Bitcoin[\s\S]{0,400}$/i,
    /Bitcoin is currently[\s\S]{0,400}$/i,
    /Để xem giá[\s\S]{0,300}$/i,
    /Nguon:\s*[\s\S]{0,300}$/i,
    /Sources:\s*[\s\S]{0,300}$/i,
  ]

  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (match?.[0]) return match[0]
  }

  return ""
}

function mergeOverlappingText(prefix: string, suffix: string) {
  if (!prefix) return suffix
  if (!suffix) return prefix
  if (prefix.includes(suffix)) return prefix
  if (suffix.includes(prefix)) return suffix

  const maxOverlap = Math.min(prefix.length, suffix.length)
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (prefix.slice(-length) === suffix.slice(0, length)) {
      return prefix + suffix.slice(length)
    }
  }
  if (/\s$/.test(prefix) || /^\s/.test(suffix)) {
    return prefix + suffix
  }
  if (/[A-Za-z0-9*_)>\]]$/.test(prefix) && /^[A-Za-z0-9*_(<\[]/.test(suffix)) {
    return `${prefix} ${suffix}`
  }
  return prefix + suffix
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
        const emittedToolUseIds = new Set<string>()
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
              if (emittedToolUseIds.has(event.toolUse.id) || shouldFilterKiroToolUse(event.toolUse)) continue
              emittedToolUseIds.add(event.toolUse.id)
              pendingToolUses.push(event.toolUse)
              continue
            }

            if (event.type === "usage") {
              lastUsage = event.usage
              continue
            }
          }
        } catch (error) {
          if (error instanceof FirstTokenTimeoutError) {
            console.error(`[kiro-stream] first token timeout (OpenAI): ${error.message}`)
          } else {
            console.error(`[kiro-stream] error during OpenAI streaming: ${error instanceof Error ? error.message : String(error)}`)
          }
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
  const lastUserText = extractLastUserText(request)
  const fallbackWebAnswer =
    extractWebResultAnswerFromMessages(request.messages, lastUserText) ||
    getCachedWebSearchSummary(request, lastUserText)
  const contentWasTruncated = collected.completed === false && Boolean(collected.content) && !(collected.toolUses?.length)
  const fallbackText =
    collected.content ||
    (
      !(collected.toolUses?.length) &&
      !(collected.webSearches?.length) &&
      (fallbackWebAnswer || (collected.thinking ? "I wasn't able to generate a complete response. Please try rephrasing your question or providing more context." : ""))
    ) ||
    ""

  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: request.model,
    content: [
      ...(fallbackText ? [{ type: "text", text: fallbackText }] : []),
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
    stop_reason: collected.toolUses?.length ? "tool_use" : contentWasTruncated ? "max_tokens" : "end_turn",
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
