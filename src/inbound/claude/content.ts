import type { JsonObject } from "../types"

export function responseOutputTextToClaudeBlocks(content: unknown): JsonObject[] {
  if (!content || typeof content !== "object") return []
  const item = content as { type?: unknown; text?: unknown; annotations?: unknown }
  if (item.type !== "output_text" || typeof item.text !== "string") return []
  const text = item.text
  const citations = Array.isArray(item.annotations) ? item.annotations.flatMap((annotation) => annotationToClaudeCitation(annotation, text)) : undefined
  return [
    {
      type: "text",
      text,
      ...(citations?.length ? { citations } : {}),
    },
  ]
}

function annotationToClaudeCitation(annotation: unknown, text: string) {
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
