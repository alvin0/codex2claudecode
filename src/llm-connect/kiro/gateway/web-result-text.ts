import type { ClaudeMessagesRequest } from "../../../types"

export function extractWebResultSummaryFromMessages(messages: ClaudeMessagesRequest["messages"]) {
  const results = messages.flatMap((message) => extractWebResultItems(message.content))
  return summarizeWebResultItems(results)
}

export function extractWebResultAnswerFromMessages(
  messages: ClaudeMessagesRequest["messages"],
  query?: string,
) {
  const results = messages.flatMap((message) => extractWebResultItems(message.content))
  return buildWebResultAnswer(query, results, countWebSearchCalls(messages))
}

export function normalizeClaudeCodeWebSearchText(text: string) {
  const parsed = parseClaudeCodeWebSearchText(text)
  if (!parsed) return text

  const summary = summarizeClaudeCodeWebSearchLinks(parsed.query, parsed.links)
  if (!summary) return text

  const leading = text.slice(0, parsed.start).trimEnd()
  const trailing = text.slice(parsed.end).trimStart()
  return [leading, summary, trailing].filter(Boolean).join("\n\n")
}

export function webToolResultToText(block: { type?: unknown; content?: unknown }) {
  if (block.type === "web_search_tool_result") {
    return summarizeWebResultItems(Array.isArray(block.content) ? block.content : []) ?? ""
  }

  if (block.type !== "web_fetch_tool_result") return ""
  const content = block.content && typeof block.content === "object" ? (block.content as Record<string, unknown>) : {}
  const url = typeof content.url === "string" ? content.url : ""
  const document = content.content && typeof content.content === "object" ? (content.content as Record<string, unknown>) : {}
  const title = typeof document.title === "string" ? document.title : ""
  const source = document.source && typeof document.source === "object" ? (document.source as Record<string, unknown>) : {}
  const data = typeof source.data === "string" ? source.data : ""
  return [title, url, data].filter(Boolean).join("\n")
}

export function webSearchResultToText(item: unknown) {
  if (!item || typeof item !== "object") return ""
  const result = item as Record<string, unknown>
  const title = typeof result.title === "string" ? result.title : ""
  const url = typeof result.url === "string" ? result.url : ""
  const rawSnippet =
    typeof result.encrypted_content === "string"
      ? result.encrypted_content
      : typeof result.text === "string"
        ? result.text
        : ""
  const snippet = summarizeSnippet(rawSnippet)
  const price = extractPriceSnippet(rawSnippet)
  const pageAge = formatPageAge(result.page_age)
  const heading = [title, url].filter(Boolean).join(" - ")
  return [heading ? `${heading}${pageAge}` : "", price ?? snippet].filter(Boolean).join(": ")
}

export function buildWebResultAnswer(query: string | undefined, items: unknown[], maxSources = 3) {
  const ranked = rankWebResults(items)
  if (!ranked.length) return undefined

  const bestPrice = ranked
    .map((entry) => ({ entry, price: extractPriceSnippet(rawSnippetFromItem(entry.item)) }))
    .find((entry) => entry.price)

  const topSources = ranked
    .map((entry) => sourceLinkFromItem(entry.item))
    .filter((entry): entry is { title: string; url: string } => Boolean(entry))
  const uniqueTopSources: Array<{ title: string; url: string }> = []
  const seenSources = new Set<string>()
  for (const source of topSources) {
    const key = normalizeText(source.url) || `${normalizeText(source.title)}|${normalizeText(source.url)}`
    if (seenSources.has(key)) continue
    seenSources.add(key)
    uniqueTopSources.push(source)
    if (uniqueTopSources.length >= Math.max(1, maxSources)) break
  }

  if (bestPrice?.price) {
    const priceText = formatPriceForAnswer(bestPrice.price)
    const sourcesLabel = isVietnameseQuery(query) ? "Nguon" : "Sources"
    const sources = uniqueTopSources.length
      ? `\n\n${sourcesLabel}:\n${uniqueTopSources.map((source) => `- [${source.title}](${source.url})`).join("\n")}`
      : ""

    if (isVietnameseQuery(query)) {
      return `Gia Bitcoin hien tai khoang **${priceText}**.${sources}`
    }
    return `Bitcoin is currently about **${priceText}**.${sources}`
  }

  return summarizeWebResultItems(items)
}

function extractWebResultItems(content: unknown): unknown[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const block = item as { type?: unknown; content?: unknown }
    if (block.type === "web_search_tool_result") return Array.isArray(block.content) ? block.content : []
    if (block.type === "tool_result") return extractWebResultItems(block.content)
    return []
  })
}

function countWebSearchCalls(messages: ClaudeMessagesRequest["messages"]) {
  const serverToolUseIds = new Set<string>()
  const resultToolUseIds = new Set<string>()

  for (const message of messages) {
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const item of content) {
      if (!item || typeof item !== "object") continue
      const block = item as {
        type?: unknown
        id?: unknown
        name?: unknown
        tool_use_id?: unknown
      }

      if (
        block.type === "server_tool_use"
        && typeof block.id === "string"
        && typeof block.name === "string"
        && block.name === "web_search"
      ) {
        serverToolUseIds.add(block.id)
      }

      if (block.type === "web_search_tool_result" && typeof block.tool_use_id === "string") {
        resultToolUseIds.add(block.tool_use_id)
      }
    }
  }

  return serverToolUseIds.size || resultToolUseIds.size || 3
}

function parseClaudeCodeWebSearchText(text: string) {
  const match = text.match(
    /Web search results for query:\s*"([^"]+)"\s*Links:\s*(\[[\s\S]*?\])\s*REMINDER:\s*You MUST include the sources above in your response to the user using markdown hyperlinks\./i,
  )
  if (!match?.index) {
    if (!match) return undefined
  }

  const query = match[1]?.trim() ?? ""
  const rawLinks = match[2]?.trim() ?? "[]"
  try {
    const parsed = JSON.parse(rawLinks)
    if (!Array.isArray(parsed)) return undefined
    const links = parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const link = item as { title?: unknown; url?: unknown }
      if (typeof link.title !== "string" || typeof link.url !== "string") return []
      return [{ title: link.title, url: link.url }]
    })
    if (!links.length) return undefined
    return {
      query,
      links,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    }
  } catch {
    return undefined
  }
}

function summarizeClaudeCodeWebSearchLinks(query: string, links: Array<{ title: string; url: string }>) {
  const ranked = links
    .map((link) => ({ ...link, score: scoreClaudeCodeWebSearchLink(link, query) }))
    .sort((left, right) => right.score - left.score)

  const seen = new Set<string>()
  const deduped: Array<{ title: string; url: string }> = []
  for (const link of ranked) {
    const key = `${normalizeText(link.title)}|${normalizeText(link.url)}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(link)
    if (deduped.length >= 5) break
  }

  if (!deduped.length) return undefined
  const header = query ? `Web search results for "${query}":` : "Web search results:"
  return `${header}\n${deduped.map((link) => `- ${link.title} - ${link.url}`).join("\n")}`
}

function scoreClaudeCodeWebSearchLink(link: { title: string; url: string }, query: string) {
  const title = link.title.toLowerCase()
  const url = link.url.toLowerCase()
  const queryText = query.toLowerCase()

  let score = 0
  if (/\$\s?\d/.test(link.title)) score += 12
  if (/\bbtc\b|\bbitcoin\b/.test(title)) score += 6
  if (/price|usd|chart|market cap|live/.test(title)) score += 5
  if (/coinmarketcap|coingecko|coinbase|google\.com\/finance|coindesk|decrypt|crypto\.news/.test(url)) score += 4
  if (queryText && title.includes(queryText)) score += 2
  return score
}

export function summarizeWebResultItems(items: unknown[]) {
  const ranked = rankWebResults(items)

  if (!ranked.length) return undefined
  const deduped: string[] = []
  const seen = new Set<string>()
  for (const entry of ranked) {
    const key = normalizeText(entry.text)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(entry.text)
    if (deduped.length >= 4) break
  }
  return deduped.length ? `Web search results:\n${deduped.map((result) => `- ${result}`).join("\n")}` : undefined
}

function rankWebResults(items: unknown[]) {
  return items
    .map((item) => ({ item, score: resultScore(item), text: webSearchResultToText(item) }))
    .filter((entry) => entry.text)
    .sort((left, right) => right.score - left.score)
}

function resultScore(item: unknown) {
  if (!item || typeof item !== "object") return 0
  const result = item as Record<string, unknown>
  const title = typeof result.title === "string" ? result.title.toLowerCase() : ""
  const url = typeof result.url === "string" ? result.url.toLowerCase() : ""
  const rawSnippet =
    typeof result.encrypted_content === "string"
      ? result.encrypted_content
      : typeof result.text === "string"
        ? result.text
        : ""

  let score = 0
  if (extractPriceSnippet(rawSnippet)) score += 10
  if (/\bbtc\b|\bbitcoin\b/.test(title)) score += 5
  if (/price|chart|market cap|usd/.test(title)) score += 4
  if (/coinmarketcap|coingecko|coinbase|google\.com\/finance|coindesk|decrypt/.test(url)) score += 3
  if (rawSnippet.length > 0) score += 1
  return score
}

function extractPriceSnippet(snippet: string) {
  const normalized = snippet.replace(/\s+/g, " ").trim()
  if (!normalized) return undefined
  const priceMatches = [...normalized.matchAll(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?:\s*\(?[+-]?\d+(?:\.\d+)?%\)?)?/gi)]
  const scored = priceMatches
    .map((match) => {
      const value = match[0]?.trim() ?? ""
      const index = match.index ?? 0
      const context = normalized.slice(Math.max(0, index - 36), Math.min(normalized.length, index + value.length + 36))
      const localContext = normalized.slice(Math.max(0, index - 12), Math.min(normalized.length, index + value.length + 12))
      const normalizedContext = context.toLowerCase()
      const normalizedLocalContext = localContext.toLowerCase()
      const numericPart = value.match(/\d{1,3}(?:,\d{3})*(?:\.\d+)?/)?.[0] ?? ""
      const numericValue = Number(numericPart.replace(/,/g, ""))

      let score = 0
      if (Number.isFinite(numericValue) && numericValue >= 1000 && numericValue <= 500000) score += 6
      if (/bitcoin price|btc to usd|price today|\bbtc\b|\bbitcoin\b/i.test(context)) score += 8
      if (/usd\/btc/i.test(context)) score += 5
      if (/market cap|volume|fdv|supply|treasury|holdings/i.test(context)) score -= 10
      if (/\blow\b|\bhigh\b/.test(normalizedContext) && !/price|bitcoin/.test(normalizedContext)) score -= 12
      if (/\b24h\b/.test(normalizedContext) && !/price|bitcoin/.test(normalizedContext)) score -= 6
      if (/\blow\s*\$|\bhigh\s*\$/.test(normalizedLocalContext)) score -= 20
      if (/\bmarket cap\s*\$|\bvolume\s*\(/.test(normalizedLocalContext)) score -= 20
      if (/\$\s?\d+(?:\.\d+)?\s*[tb]\b/i.test(value)) score -= 12

      return { value, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)

  if (scored[0]?.value) return scored[0].value

  const patterns = [
    /bitcoin price[:\s]+\$?\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?:\s*\(?[+-]?\d+(?:\.\d+)?%\)?)?/i,
    /\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*usd\/btc\b/i,
  ]
  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (match) return match[0].trim()
  }
  return undefined
}

function summarizeSnippet(snippet: string) {
  const normalized = snippet.replace(/\s+/g, " ").replace(/[#*_`]+/g, "").trim()
  if (!normalized) return ""
  return normalized.length > 140 ? `${normalized.slice(0, 137).trimEnd()}...` : normalized
}

function formatPageAge(pageAge: unknown) {
  if (typeof pageAge !== "string") return ""
  const match = pageAge.match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? ` (${match[1]})` : ""
}

function normalizeText(text: string) {
  return text.trim().replace(/\s+/g, " ").toLowerCase()
}

function rawSnippetFromItem(item: unknown) {
  if (!item || typeof item !== "object") return ""
  const result = item as Record<string, unknown>
  return typeof result.encrypted_content === "string"
    ? result.encrypted_content
    : typeof result.text === "string"
      ? result.text
      : ""
}

function sourceLinkFromItem(item: unknown) {
  if (!item || typeof item !== "object") return undefined
  const result = item as Record<string, unknown>
  const title = typeof result.title === "string" ? result.title : ""
  const url = typeof result.url === "string" ? result.url : ""
  if (!title || !url) return undefined
  return { title, url }
}

function formatPriceForAnswer(price: string) {
  const normalized = price.replace(/\s+/g, " ").trim()
  if (/usd\/btc/i.test(normalized)) return normalized
  if (/%/.test(normalized)) return `${normalized} USD/BTC`
  return `${normalized} USD/BTC`
}

function isVietnameseQuery(query: string | undefined) {
  if (!query) return false
  return /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(query)
    || /\b(gia|giá|hien tai|hiện tại|bao nhieu|bao nhiêu)\b/i.test(query)
}
