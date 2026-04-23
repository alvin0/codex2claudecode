import type { ClaudeMessagesRequest, JsonObject } from "../../../types"

import { buildWebResultAnswer } from "./web-result-text"

const MAX_CACHE_ENTRIES = 50
const CACHE_TTL_MS = 5 * 60 * 1000

interface CachedWebResult {
  at: number
  query: string
  sessionKey: string
  summary: string
}

const cachedResults: CachedWebResult[] = []

export function cacheWebSearchResult(body: ClaudeMessagesRequest, query: string, content: JsonObject[]) {
  const summary = webSearchContentToSummary(content)
  if (!summary) return

  cachedResults.push({
    at: Date.now(),
    query: normalizeQuery(query),
    sessionKey: sessionKeyFromRequest(body),
    summary,
  })
  pruneCache()
}

export function getCachedWebSearchSummary(body: ClaudeMessagesRequest, query?: string) {
  pruneCache()
  const sessionKey = sessionKeyFromRequest(body)
  const normalizedQuery = normalizeQuery(query ?? "")
  const candidates = cachedResults
    .filter((entry) => entry.sessionKey === sessionKey)
    .sort((left, right) => right.at - left.at)

  if (!candidates.length) return undefined
  if (normalizedQuery) {
    const exact = candidates.find((entry) => entry.query === normalizedQuery)
    if (exact) return exact.summary
  }
  return candidates[0]?.summary
}

function webSearchContentToSummary(content: JsonObject[]) {
  return buildWebResultAnswer(undefined, content) ?? ""
}

function pruneCache() {
  const cutoff = Date.now() - CACHE_TTL_MS
  for (let i = cachedResults.length - 1; i >= 0; i--) {
    if (cachedResults[i]!.at < cutoff) cachedResults.splice(i, 1)
  }
  if (cachedResults.length > MAX_CACHE_ENTRIES) {
    cachedResults.splice(0, cachedResults.length - MAX_CACHE_ENTRIES)
  }
}

function sessionKeyFromRequest(body: ClaudeMessagesRequest) {
  const metadata = body.metadata
  const userId = metadata && typeof metadata === "object" ? (metadata as JsonObject).user_id : undefined
  if (typeof userId !== "string") return "default"
  try {
    const parsed = JSON.parse(userId) as { session_id?: unknown; device_id?: unknown }
    if (typeof parsed.session_id === "string") return parsed.session_id
    if (typeof parsed.device_id === "string") return parsed.device_id
  } catch {
    return userId
  }
  return userId
}

function normalizeQuery(query: string) {
  return query.trim().replace(/\s+/g, " ").toLowerCase()
}
