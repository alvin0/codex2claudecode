import type { KiroStandaloneClient } from "../client"
import type { ClaudeMessagesRequest, JsonObject } from "../../../types"

interface McpSearchResult {
  title?: string
  url?: string
  snippet?: string
  publishedDate?: number
}

interface McpSearchResponse {
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

function extractQueryFromMessages(messages: ClaudeMessagesRequest["messages"]) {
  // Extract query from the last user message (supports multi-turn)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== "user") continue
    const content = msg.content
    if (typeof content === "string") return content.trim() || undefined
    if (!Array.isArray(content)) continue
    const text = content
      .map((block) => {
        if (typeof block === "string") return block
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          return (block as { text?: string }).text ?? ""
        }
        return ""
      })
      .join("")
    const trimmed = text.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

async function callMcpWebSearch(
  client: Pick<KiroStandaloneClient, "mcpCall">,
  query: string,
): Promise<McpSearchResponse | undefined> {
  const result = await client.mcpCall("tools/call", {
    name: "web_search",
    arguments: { query },
  })
  if (!result) return undefined

  const mcpResult = result.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined
  if (!mcpResult || mcpResult.isError) return undefined

  const textContent = mcpResult.content?.[0]?.text
  if (!textContent) return undefined

  try {
    return JSON.parse(textContent) as McpSearchResponse
  } catch {
    return undefined
  }
}

export async function handleKiroWebSearch(
  client: Pick<KiroStandaloneClient, "mcpCall">,
  body: ClaudeMessagesRequest,
) {
  const query = extractQueryFromMessages(body.messages)
  if (!query) {
    return Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "Cannot extract search query from messages" } },
      { status: 400 },
    )
  }

  const results = await callMcpWebSearch(client, query)
  if (!results) {
    return Response.json(
      { type: "error", error: { type: "api_error", message: "Web search failed. Please try again." } },
      { status: 500 },
    )
  }

  const toolUseId = `srvtoolu_${crypto.randomUUID().replace(/-/g, "")}`
  const searchContent = (results.results ?? []).map((r) => ({
    type: "web_search_result",
    url: r.url ?? "",
    title: r.title ?? "",
    encrypted_content: r.snippet ?? "",
    page_age: r.publishedDate ? new Date(r.publishedDate).toISOString() : null,
  }))

  // Build a text summary from search results for the final text block
  const summaryParts: string[] = []
  for (const r of results.results ?? []) {
    const parts = [r.title, r.url, r.snippet].filter(Boolean)
    if (parts.length) summaryParts.push(parts.join(" - "))
  }
  const summaryText = summaryParts.length
    ? `Based on the search results:\n\n${summaryParts.join("\n\n")}`
    : "No search results found."

  if (body.stream) {
    return streamWebSearchResponse(body, toolUseId, query, searchContent, summaryText)
  }

  // Non-streaming: return full Anthropic web search response format
  // Reference: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool
  return Response.json({
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content: [
      { type: "server_tool_use", id: toolUseId, name: "web_search", input: { query } },
      { type: "web_search_tool_result", tool_use_id: toolUseId, content: searchContent },
      { type: "text", text: summaryText },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      server_tool_use: { web_search_requests: 1 },
    },
  })
}

/**
 * Stream web search response in Anthropic SSE format.
 *
 * Follows the exact streaming format from the Anthropic web search docs:
 *   1. server_tool_use block (search query via input_json_delta)
 *   2. web_search_tool_result block (results in content_block_start, no deltas)
 *   3. text block (summary streamed via text_delta)
 *
 * Reference: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool#streaming
 */
function streamWebSearchResponse(
  body: ClaudeMessagesRequest,
  toolUseId: string,
  query: string,
  searchContent: JsonObject[],
  summaryText: string,
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

        // Block 0: server_tool_use (the search query)
        send("content_block_start", {
          type: "content_block_start", index: blockIndex,
          content_block: { type: "server_tool_use", id: toolUseId, name: "web_search", input: {} },
        })
        send("content_block_delta", {
          type: "content_block_delta", index: blockIndex,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) },
        })
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++

        // Block 1: web_search_tool_result (results delivered in content_block_start)
        send("content_block_start", {
          type: "content_block_start", index: blockIndex,
          content_block: { type: "web_search_tool_result", tool_use_id: toolUseId, content: searchContent },
        })
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++

        // Block 2: text (summary of results)
        send("content_block_start", {
          type: "content_block_start", index: blockIndex,
          content_block: { type: "text", text: "" },
        })
        const chunkSize = 100
        for (let i = 0; i < summaryText.length; i += chunkSize) {
          send("content_block_delta", {
            type: "content_block_delta", index: blockIndex,
            delta: { type: "text_delta", text: summaryText.slice(i, i + chunkSize) },
          })
        }
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })

        // message_delta + message_stop
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {
            output_tokens: 0,
            server_tool_use: { web_search_requests: 1 },
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
