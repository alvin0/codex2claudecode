import { CANONICAL_WEB_FETCH_TOOL_TYPE, isCanonicalWebFetchToolType } from "../../core/canonical-tools"
import type { ClaudeTool, JsonObject } from "../types"

import type { ClaudeServerToolAdapter } from "./server-tool-adapter"
import { responseOutputTextToClaudeBlocks } from "./content"

export { responseOutputTextToClaudeBlocks as codexMessageContentToClaudeBlocks } from "./content"

export function codexWebCallToClaudeBlocks(
  item: { id?: unknown; action?: unknown },
  fallbackSources?: Array<{ url: string; title: string; encrypted_content: string }>,
) {
  const action = item.action && typeof item.action === "object" ? (item.action as JsonObject) : {}
  const name = action.type === "open_page" ? "web_fetch" : "web_search"
  const id = claudeServerToolId(typeof item.id === "string" ? item.id : crypto.randomUUID())
  const input = name === "web_fetch" ? { url: typeof action.url === "string" ? action.url : "" } : { query: codexWebSearchQuery(action) }
  const sources = codexWebSources(action)

  return {
    name,
    id,
    input,
    content: [
      {
        type: "server_tool_use",
        id,
        name,
        input,
      },
      name === "web_fetch"
        ? {
            type: "web_fetch_tool_result",
            tool_use_id: id,
            content: {
              type: "web_fetch_result",
              url: typeof action.url === "string" ? action.url : "",
              content: {
                type: "document",
                source: {
                  type: "text",
                  media_type: "text/plain",
                  data: "",
                },
                ...(typeof action.title === "string" && { title: action.title }),
              },
              retrieved_at: new Date().toISOString(),
            },
          }
        : {
            type: "web_search_tool_result",
            tool_use_id: id,
            content: (sources.length ? sources : (fallbackSources ?? [])).map((source) => ({
              type: "web_search_result",
              url: source.url,
              title: source.title,
              encrypted_content: source.encrypted_content,
            })),
          },
    ],
  }
}

function codexWebSearchQuery(action: JsonObject) {
  if (typeof action.query === "string") return action.query
  if (Array.isArray(action.queries)) return action.queries.filter((query) => typeof query === "string").join("\n")
  return ""
}

function codexWebSources(action: JsonObject) {
  if (!Array.isArray(action.sources)) return []
  return action.sources.flatMap((source) => {
    if (!source || typeof source !== "object") return []
    const item = source as { type?: unknown; name?: unknown; url?: unknown; title?: unknown }
    if (item.type === "api" && typeof item.name === "string") {
      return [
        {
          url: codexApiSourceUrl(action, item.name),
          title: item.name,
          encrypted_content: "",
        },
      ]
    }
    if (typeof item.url !== "string") return []
    return [
      {
        url: item.url,
        title: typeof item.title === "string" ? item.title : item.url,
        encrypted_content: "",
      },
    ]
  })
}

function codexApiSourceUrl(action: JsonObject, name: string) {
  const query = codexWebSearchQuery(action)
  const finance = query.match(/^finance:\s*([A-Za-z0-9.-]+)/i)
  if (name === "oai-finance" && finance) return `https://www.google.com/finance/quote/${finance[1].toUpperCase()}-USD`
  return `https://www.google.com/search?q=${encodeURIComponent(query || name)}`
}

export function claudeWebResultHasContent(block: JsonObject) {
  if (block.type === "web_search_tool_result") return Array.isArray(block.content) && block.content.length > 0
  if (block.type !== "web_fetch_tool_result") return false
  const content = block.content
  if (!content || typeof content !== "object") return false
  const result = content as { content?: unknown }
  if (!result.content || typeof result.content !== "object") return false
  const document = result.content as { source?: unknown }
  if (!document.source || typeof document.source !== "object") return false
  const source = document.source as { data?: unknown }
  return typeof source.data === "string" && source.data.length > 0
}

function claudeServerToolId(id: string) {
  if (id.startsWith("srvtoolu_")) return id
  return `srvtoolu_${id.replace(/[^A-Za-z0-9]/g, "")}`
}

export function codexOutputItemsToClaudeContent(output: unknown) {
  if (!Array.isArray(output)) return []
  const citationSources = codexCitationSourcesFromOutput(output)
  return output.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const outputItem = item as { type?: unknown; id?: unknown; action?: unknown; content?: unknown }
    if (outputItem.type === "web_search_call") {
      const blocks = codexWebCallToClaudeBlocks(outputItem, citationSources)
      return claudeWebResultHasContent(blocks.content[1]) ? blocks.content : []
    }
    if (outputItem.type === "message" && Array.isArray(outputItem.content)) {
      return outputItem.content.flatMap((content) => responseOutputTextToClaudeBlocks(content))
    }
    return []
  })
}

export function countCodexWebCalls(output: unknown) {
  if (!Array.isArray(output)) return { webSearchRequests: 0, webFetchRequests: 0 }
  return output.reduce(
    (acc, item) => {
      if (!item || typeof item !== "object") return acc
      const outputItem = item as { type?: unknown; action?: unknown }
      if (outputItem.type !== "web_search_call") return acc
      const action = outputItem.action && typeof outputItem.action === "object" ? (outputItem.action as JsonObject) : {}
      return action.type === "open_page"
        ? { ...acc, webFetchRequests: acc.webFetchRequests + 1 }
        : { ...acc, webSearchRequests: acc.webSearchRequests + 1 }
    },
    { webSearchRequests: 0, webFetchRequests: 0 },
  )
}

export const webServerToolAdapter: ClaudeServerToolAdapter = {
  name: "web",
  matchesTool(tool) {
    return isClaudeWebTool(tool)
  },
  resolveTool(tool) {
    const toolName = tool.name
    if (typeof toolName !== "string") throw new Error("Web tools require name")
    const mapped = claudeWebToolToResponsesTool(tool)
    return {
      tool: mapped,
      // Both members below are deliberately **not** narrowed to the search tool now that `mapped.type`
      // can be a fetch. They were written as `mapped.type === "web_search"` when that condition was
      // always true, so narrowing them here would be a second, unrequested behaviour change riding
      // along with the type fix: a fetch-only request would lose the sources `include` and the
      // web-tool line in `instructions` that it gets today.
      include: ["web_search_call.action.sources"],
      toolChoiceName: toolName,
      // Still the search choice, for either kind. A forced `tool_choice` naming a fetch tool is a
      // separate question from what the tool list carries, and no upstream reads a fetch-typed tool
      // choice yet; changing it here would swap one unsupported wire value for another.
      toolChoice: { type: "web_search" },
      hasWebTool: true,
    }
  },
  matchesOutputItem(item) {
    return Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "web_search_call")
  },
  outputItemToBlocks(item) {
    if (!item || typeof item !== "object") return []
    const blocks = codexWebCallToClaudeBlocks(item as { id?: unknown; action?: unknown })
    return claudeWebResultHasContent(blocks.content[1]) ? blocks.content : []
  },
  outputToContent(output) {
    const content = codexOutputItemsToClaudeContent(output)
    return {
      content,
      blocks: content.filter((block) => block.type !== "text"),
      textBlocks: content.filter((block) => block.type === "text"),
    }
  },
  countCalls(output) {
    return countCodexWebCalls(output)
  },
}

function isClaudeWebTool(tool: ClaudeTool) {
  return tool?.type !== "mcp_toolset" && typeof tool.type === "string" && /^web[_-]?(search|fetch)(?:_\d+)?$/i.test(tool.type)
}

/**
 * Whether this Claude web tool is the fetch one.
 *
 * Reads the same predicate the canonical vocabulary exposes rather than a second regex of its own,
 * so "Claude sent a fetch tool" and "this canonical tool is a fetch" cannot drift apart across the
 * boundary this module converts.
 */
function isClaudeWebFetchTool(tool: ClaudeTool) {
  return isCanonicalWebFetchToolType(tool.type)
}

/**
 * A Claude web tool, as the canonical tool the rest of the pipeline reads.
 *
 * The `type` is the whole point of this function. A `web_search_*` tool becomes `web_search` and a
 * `web_fetch_*` tool becomes {@link CANONICAL_WEB_FETCH_TOOL_TYPE} — the client's dated type name is
 * dropped, but the *kind* of tool it asked for is not. Collapsing a fetch into a search here (which
 * is what this function used to do) meant no upstream could tell the two apart: the fetch never
 * reached a fetch-capable upstream as a fetch, and nothing on the request recorded the swap, which
 * is the silent substitution Requirement 10.1 forbids. Where a substitution is still the right
 * answer — an upstream whose wire protocol has no fetch tool — it now happens at that upstream's
 * boundary, which is the layer that knows its own vocabulary and declares the policy for it.
 *
 * Everything else is unchanged and shared by both kinds: `allowed_domains` travels as `filters` and
 * `user_location` is normalized once, because a client may scope either kind of web tool.
 */
function claudeWebToolToResponsesTool(tool: ClaudeTool) {
  return {
    type: isClaudeWebFetchTool(tool) ? CANONICAL_WEB_FETCH_TOOL_TYPE : "web_search",
    ...(Array.isArray(tool.allowed_domains) && tool.allowed_domains.length > 0
      ? { filters: { allowed_domains: tool.allowed_domains } }
      : {}),
    ...(tool.user_location && typeof tool.user_location === "object"
      ? { user_location: claudeUserLocationToResponsesUserLocation(tool.user_location as JsonObject) }
      : {}),
  }
}

function claudeUserLocationToResponsesUserLocation(userLocation: JsonObject) {
  return {
    type: "approximate",
    approximate: Object.fromEntries(
      ["city", "region", "country", "timezone"].flatMap((key) =>
        typeof userLocation[key] === "string" ? [[key, userLocation[key]] as const] : [],
      ),
    ),
  }
}

function codexCitationSourcesFromOutput(output: unknown[]) {
  return output
    .flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const outputItem = item as { type?: unknown; content?: unknown }
      if (outputItem.type !== "message" || !Array.isArray(outputItem.content)) return []
      return outputItem.content.flatMap((content) => {
        if (!content || typeof content !== "object") return []
        const block = content as { annotations?: unknown }
        if (!Array.isArray(block.annotations)) return []
        return block.annotations.flatMap(codexAnnotationSource)
      })
    })
    .filter((source, index, sources) => sources.findIndex((item) => item.url === source.url) === index)
}

function codexAnnotationSource(annotation: unknown) {
  if (!annotation || typeof annotation !== "object") return []
  const item = annotation as {
    type?: unknown
    url?: unknown
    title?: unknown
    url_citation?: {
      url?: unknown
      title?: unknown
    }
  }
  const citation = item.url_citation ?? item
  if (item.type !== "url_citation" || typeof citation.url !== "string") return []
  return [
    {
      url: citation.url,
      title: typeof citation.title === "string" ? citation.title : citation.url,
      encrypted_content: "",
    },
  ]
}
