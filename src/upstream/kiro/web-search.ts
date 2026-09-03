// Kiro web search, executed over the provider's `POST /mcp` endpoint.
//
// Renamed from `src/upstream/kiro/mcp.ts` (task 26.1, Requirement 17.1). The old name described the
// transport, not the behavior: nothing here implements MCP toolset support — no `tools/list`
// discovery, no client-declared servers, no tool-name mangling. It builds the Kiro-side
// `web_search` tool declaration, calls it, and renders the results as Claude server-tool blocks.
// The real MCP toolset work lands in `src/core/mcp/` with a Kiro bridge at
// `src/upstream/kiro/mcp-toolset.ts` (tasks 31–35), which would have collided on the old name.
//
// Content is otherwise unchanged by the rename. `parseMcpWebSearchResults` and `KiroMcpError` keep
// their names because they parse the `/mcp` JSON-RPC envelope, which is genuinely what they read.
import type { Canonical_Event } from "../../core/canonical"
import type { JsonObject } from "../../core/types"
import { KiroMcpError } from "./types"

export interface KiroWebSearchExecution {
  toolUseId: string
  results: JsonObject
  summary: string
}

export interface KiroServerToolHandlers {
  webSearch?: (query: string) => Promise<KiroWebSearchExecution | undefined>
  webSearchFallbackQuery?: string
}

export function kiroWebSearchTool(): JsonObject {
  return {
    type: "function",
    name: "web_search",
    description: "Search the web for current information, URL lookup, article/page summaries, news, product information, and external facts. Always provide a non-empty query string; if the user provided a URL, use that URL as the query.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. Use the provided URL verbatim when the user asks about a URL." },
      },
      required: ["query"],
    },
  }
}

export function extractWebSearchQuery(argumentsJson: string) {
  try {
    const parsed = JSON.parse(argumentsJson) as { query?: unknown }
    return typeof parsed.query === "string" ? parsed.query.trim() : ""
  } catch {
    return ""
  }
}

export function webSearchSummary(query: string, results: JsonObject) {
  const lines = [`<web_search>`, `Search results for "${query}":`, ""]
  const items = Array.isArray(results.results) ? results.results : []

  if (!items.length) {
    lines.push("No results found.")
  } else {
    for (const [index, raw] of items.entries()) {
      const item = raw && typeof raw === "object" ? raw as JsonObject : {}
      const title = typeof item.title === "string" && item.title ? item.title : "Untitled"
      const url = typeof item.url === "string" ? item.url : ""
      const snippet = typeof item.snippet === "string" ? item.snippet : ""
      const published = typeof item.publishedDate === "number" ? publishedDate(item.publishedDate) : undefined

      lines.push(`${index + 1}. ${title}`)
      if (published) lines.push(`   Published: ${published}`)
      if (url) lines.push(`   URL: ${url}`)
      if (snippet) lines.push(`   ${snippet}`)
      lines.push("")
    }
  }

  lines.push("</web_search>")
  return `${lines.join("\n")}\n`
}

export function webSearchBlocks(toolUseId: string, query: string, results: JsonObject): JsonObject[] {
  const items = Array.isArray(results.results) ? results.results : []
  return [
    {
      type: "server_tool_use",
      id: toolUseId,
      name: "web_search",
      input: { query },
    },
    {
      type: "web_search_tool_result",
      tool_use_id: toolUseId,
      content: items.flatMap((raw) => {
        if (!raw || typeof raw !== "object") return []
        const item = raw as JsonObject
        return [
          {
            type: "web_search_result",
            title: typeof item.title === "string" ? item.title : "",
            url: typeof item.url === "string" ? item.url : "",
            encrypted_content: typeof item.snippet === "string" ? item.snippet : "",
            page_age: null,
          },
        ]
      }),
    },
  ]
}

export function parseMcpWebSearchResults(payload: unknown): JsonObject {
  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as JsonObject : {}
  if (body.error) throw new KiroMcpError(`Kiro MCP web_search failed: ${JSON.stringify(body.error)}`)

  const result = body.result && typeof body.result === "object" && !Array.isArray(body.result) ? body.result as JsonObject : {}
  const content = Array.isArray(result.content) ? result.content : []
  const first = content[0] && typeof content[0] === "object" ? content[0] as JsonObject : {}
  const text = typeof first.text === "string" ? first.text : "{}"
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    throw new KiroMcpError(`Kiro MCP web_search returned malformed result text: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  return parsed as JsonObject
}

/**
 * Execute a `web_search` the **model emitted**, and render it as server-tool blocks.
 *
 * This path is deliberately outside `KIRO_WEB_SEARCH_HEURISTICS` and stays active in both flag
 * states (task 27.1, Requirements 17.6, 17.7). The flag gates *guessing* — the intent preflight
 * and the synthesized client tool calls in `src/upstream/kiro/index.ts`, which produce a tool call
 * the model never asked for. A call that arrives here already exists in the model's output, so
 * suppressing it would drop a real request, which is the opposite of what native mode is for.
 *
 * Anything that is not a `web_search`, or arrives with no handler and no usable query, is passed
 * through untouched as `tool_call_done` — never swallowed.
 */
export async function* maybeHandleKiroServerTool(
  call: { callId: string; name: string; arguments: string },
  handlers?: KiroServerToolHandlers,
): AsyncIterable<Canonical_Event> {
  if (call.name !== "web_search" || !handlers?.webSearch) {
    yield { type: "tool_call_done", callId: call.callId, name: call.name, arguments: call.arguments }
    return
  }

  const query = extractWebSearchQuery(call.arguments) || handlers.webSearchFallbackQuery?.trim() || ""
  if (!query) {
    yield { type: "tool_call_done", callId: call.callId, name: call.name, arguments: call.arguments }
    return
  }

  const execution = await handlers.webSearch(query)
  if (!execution) {
    yield { type: "tool_call_done", callId: call.callId, name: call.name, arguments: call.arguments }
    return
  }

  yield { type: "server_tool_block", blocks: webSearchBlocks(execution.toolUseId, query, execution.results) }
}

function publishedDate(timestampMs: number) {
  const date = new Date(timestampMs)
  if (Number.isNaN(date.getTime())) return
  return date.toISOString()
}
