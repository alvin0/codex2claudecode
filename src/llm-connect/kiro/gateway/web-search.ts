import { LOG_BODY_PREVIEW_LIMIT } from "../../../constants"
import type { KiroStandaloneClient } from "../client"
import type { ClaudeMessagesRequest, JsonObject, RequestProxyLog } from "../../../types"

import { cacheWebSearchResult } from "./web-result-cache"

export interface McpSearchResult {
  title?: string
  url?: string
  snippet?: string
  publishedDate?: number
}

export interface McpSearchResponse {
  results?: McpSearchResult[]
  totalResults?: number
  query?: string
}

export function hasWebSearchTool(body: ClaudeMessagesRequest) {
  return Array.isArray(body.tools) && body.tools.some((tool) => isWebSearchTool(tool))
}

function isWebSearchTool(tool: JsonObject) {
  return [tool.name, tool.type].some(
    (value) => typeof value === "string" && /^web_(search|fetch)(?:_\d+)?$/i.test(value),
  )
}

/**
 * Extract a clean search query from the last user message.
 *
 * Claude Code sends very long user messages that include system prompts,
 * IDE context, file contents, etc.  We strip those wrapper tags and
 * extract only the meaningful user text so the MCP web_search call
 * receives a focused query.
 */
export function extractQueryFromMessages(messages: ClaudeMessagesRequest["messages"]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== "user") continue
    const content = msg.content
    if (typeof content === "string") {
      const cleaned = stripContextTags(content).trim()
      if (cleaned) return cleaned
    }
    if (!Array.isArray(content)) continue
    // Walk blocks in reverse so the last plain-text block wins
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j]
      if (typeof block === "string") {
        const cleaned = stripContextTags(block).trim()
        if (cleaned) return cleaned
        continue
      }
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const cleaned = stripContextTags((block as { text?: string }).text ?? "").trim()
        if (cleaned) return cleaned
      }
    }
  }
  return undefined
}

/**
 * Remove system-reminder, IDE context, and other wrapper tags that
 * Claude Code injects into user messages.  This ensures the MCP
 * web_search call receives a clean, focused query.
 */
function stripContextTags(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "")
    .replace(/<context_window[\s\S]*?<\/context_window>/g, "")
    .replace(/<environment_details>[\s\S]*?<\/environment_details>/g, "")
    .replace(/<tool_results>[\s\S]*?<\/tool_results>/g, "")
    .replace(/<attached_files>[\s\S]*?<\/attached_files>/g, "")
    // Claude Code wraps the actual query in "Perform a web search for the query: ..."
    .replace(/^Perform a web search for the query:\s*/i, "")
    .trim()
}

export async function callMcpWebSearch(
  client: Pick<KiroStandaloneClient, "mcpCall">,
  query: string,
): Promise<McpSearchResponse | undefined> {
  try {
    const result = await client.mcpCall("tools/call", {
      name: "web_search",
      arguments: { query },
    })
    if (!result) {
      console.warn(`[kiro-web-search] MCP web_search returned no result for query: "${query.slice(0, 100)}"`)
      return undefined
    }

    const mcpResult = result.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined
    if (!mcpResult || mcpResult.isError) {
      console.warn(`[kiro-web-search] MCP web_search error for query: "${query.slice(0, 100)}"`)
      return undefined
    }

    const textContent = mcpResult.content?.[0]?.text
    if (!textContent) {
      console.warn(`[kiro-web-search] MCP web_search returned empty content for query: "${query.slice(0, 100)}"`)
      return undefined
    }

    return JSON.parse(textContent) as McpSearchResponse
  } catch (error) {
    console.error(`[kiro-web-search] MCP web_search failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Build Anthropic-format search result content blocks from MCP results.
 */
export function buildSearchResultContent(results: McpSearchResponse) {
  return (results.results ?? []).map((r) => ({
    type: "web_search_result",
    url: r.url ?? "",
    title: r.title ?? "",
    encrypted_content: r.snippet ?? "",
    page_age: r.publishedDate ? new Date(r.publishedDate).toISOString() : null,
  }))
}

/**
 * Build a text summary from search results.
 */
export function buildSearchSummary(results: McpSearchResponse) {
  const summaryParts: string[] = []
  for (const r of results.results ?? []) {
    const parts = [r.title, r.url, r.snippet].filter(Boolean)
    if (parts.length) summaryParts.push(parts.join(" — "))
  }
  return summaryParts.length
    ? `Based on the search results:\n\n${summaryParts.join("\n\n")}`
    : "No search results found."
}

export async function handleKiroWebSearch(
  client: Pick<KiroStandaloneClient, "mcpCall">,
  body: ClaudeMessagesRequest,
  options?: { onProxy?: (entry: RequestProxyLog) => void },
) {
  const query = extractQueryFromMessages(body.messages)
  if (!query) {
    return Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "Cannot extract search query from messages" } },
      { status: 400 },
    )
  }

  const started = Date.now()
  const searchQueries = buildWebSearchQueries(query)
  const searchRuns: Array<{ toolUseId: string; query: string; content: JsonObject[] }> = []

  for (const searchQuery of searchQueries) {
    const results = await callMcpWebSearch(client, searchQuery)
    if (!results) continue

    searchRuns.push({
      toolUseId: `srvtoolu_${crypto.randomUUID().replace(/-/g, "")}`,
      query: searchQuery,
      content: buildSearchResultContent(results),
    })
  }

  if (!searchRuns.length) {
    options?.onProxy?.({
      label: "Kiro web_search",
      method: "POST",
      target: "/mcp",
      status: 500,
      durationMs: Date.now() - started,
      error: "Web search failed. Please try again.",
      requestBody: previewText(JSON.stringify({
        method: "tools/call",
        calls: searchQueries.map((item) => ({ name: "web_search", arguments: { query: item } })),
      })),
    })
    return Response.json(
      { type: "error", error: { type: "api_error", message: "Web search failed. Please try again." } },
      { status: 500 },
    )
  }

  const mergedSearchContent = searchRuns.flatMap((run) => run.content)
  const webSearchRequestCount = searchRuns.length
  cacheWebSearchResult(body, query, mergedSearchContent)
  options?.onProxy?.({
    label: "Kiro web_search",
    method: "POST",
    target: "/mcp",
    status: 200,
    durationMs: Date.now() - started,
    error: "-",
    requestBody: previewText(JSON.stringify({
      method: "tools/call",
      calls: searchRuns.map((run) => ({ name: "web_search", arguments: { query: run.query } })),
    })),
  })

  if (body.stream) {
    return streamWebSearchResponse(body, searchRuns, webSearchRequestCount)
  }

  // Non-streaming: return full Anthropic web search response format
  // Matches the Codex proxy format: empty text + server_tool_use + web_search_tool_result
  // Claude Code will send a follow-up request with search results for the model to synthesize.
  return Response.json({
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content: [
      { type: "text", text: "" },
      ...searchRuns.flatMap((run) => ([
        { type: "server_tool_use", id: run.toolUseId, name: "web_search", input: { query: run.query } },
        { type: "web_search_tool_result", tool_use_id: run.toolUseId, content: run.content },
      ])),
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      server_tool_use: { web_search_requests: webSearchRequestCount },
    },
  })
}

/**
 * Stream web search response in Anthropic SSE format.
 *
 * Matches the Codex proxy format:
 *   1. empty text block
 *   2. server_tool_use block (search query via input_json_delta)
 *   3. web_search_tool_result block (results in content_block_start)
 *
 * Claude Code will send a follow-up request with the search results
 * in context so the model can synthesize an answer.
 */
function streamWebSearchResponse(
  body: ClaudeMessagesRequest,
  searchRuns: Array<{ toolUseId: string; query: string; content: JsonObject[] }>,
  webSearchRequestCount: number,
) {
  const encoder = new TextEncoder()
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`

  function sse(event: string, data: JsonObject) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  }

  return new Response(
    new ReadableStream({
      start(controller) {
        const send = (event: string, data: JsonObject) => controller.enqueue(encoder.encode(sse(event, data)))
        let blockIndex = 0

        // message_start
        send("message_start", {
          type: "message_start",
          message: {
            id: messageId, type: "message", role: "assistant", model: body.model,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
          },
        })

        // Block 0: empty text block (matches Codex format)
        send("content_block_start", {
          type: "content_block_start", index: blockIndex,
          content_block: { type: "text", text: "" },
        })
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++

        for (const run of searchRuns) {
          send("content_block_start", {
            type: "content_block_start", index: blockIndex,
            content_block: { type: "server_tool_use", id: run.toolUseId, name: "web_search", input: {} },
          })
          send("content_block_delta", {
            type: "content_block_delta", index: blockIndex,
            delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: run.query }) },
          })
          send("content_block_stop", { type: "content_block_stop", index: blockIndex })
          blockIndex++

          send("content_block_start", {
            type: "content_block_start", index: blockIndex,
            content_block: { type: "web_search_tool_result", tool_use_id: run.toolUseId, content: run.content },
          })
          send("content_block_stop", { type: "content_block_stop", index: blockIndex })
          blockIndex++
        }

        // message_delta + message_stop
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {
            output_tokens: 0,
            server_tool_use: { web_search_requests: webSearchRequestCount },
          },
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

function buildWebSearchQueries(query: string) {
  const queries = [query]
  const normalized = query.trim().toLowerCase()

  if (/\b(bitcoin|btc)\b/.test(normalized) && /(gia|giá|price|usd|hien tai|hiện tại|live|current)/.test(normalized)) {
    queries.push("Bitcoin price USD live")
  }

  return queries.filter((item, index, list) => list.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === index)
}

function previewText(text: string) {
  return text.slice(0, LOG_BODY_PREVIEW_LIMIT)
}
