import type { JsonObject } from "../types"

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

export function codexMessageContentToClaudeBlocks(content: unknown): JsonObject[] {
  if (!content || typeof content !== "object") return []
  const item = content as { type?: unknown; text?: unknown; annotations?: unknown }
  if (item.type !== "output_text" || typeof item.text !== "string") return []
  return [
    {
      type: "text",
      text: item.text,
      ...(Array.isArray(item.annotations) && {
        citations: item.annotations.flatMap((annotation) => codexAnnotationToClaudeCitation(annotation, item.text)),
      }),
    },
  ]
}

export function codexOutputItemsToClaudeContent(output: unknown) {
  if (!Array.isArray(output)) return []
  const citationSources = codexCitationSourcesFromOutput(output)
  return output.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const outputItem = item as { type?: unknown; content?: unknown }
    if (outputItem.type === "web_search_call") {
      const blocks = codexWebCallToClaudeBlocks(outputItem, citationSources)
      return claudeWebResultHasContent(blocks.content[1]) ? blocks.content : []
    }
    if (outputItem.type === "message" && Array.isArray(outputItem.content)) {
      return outputItem.content.flatMap((content) => codexMessageContentToClaudeBlocks(content))
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

function codexAnnotationToClaudeCitation(annotation: unknown, text: string) {
  if (!annotation || typeof annotation !== "object") return []
  const item = annotation as {
    type?: unknown
    url?: unknown
    title?: unknown
    start_index?: unknown
    end_index?: unknown
    url_citation?: {
      url?: unknown
      title?: unknown
      start_index?: unknown
      end_index?: unknown
    }
  }
  const citation = item.url_citation ?? item
  if (item.type !== "url_citation" || typeof citation.url !== "string") return []
  return [
    {
      type: "web_search_result_location",
      url: citation.url,
      title: typeof citation.title === "string" ? citation.title : citation.url,
      encrypted_index: "",
      cited_text:
        typeof citation.start_index === "number" && typeof citation.end_index === "number"
          ? text.slice(citation.start_index, citation.end_index)
          : "",
    },
  ]
}
