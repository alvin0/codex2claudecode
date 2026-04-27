import type { Canonical_Usage } from "./canonical"

type JsonRecord = Record<string, unknown>

export function canonicalUsageFromWireUsage(value: unknown): Partial<Canonical_Usage> {
  const usage = jsonRecord(value)
  const inputDetails = jsonRecord(usage.input_tokens_details)
  const promptDetails = jsonRecord(usage.prompt_tokens_details)
  const outputDetails = jsonRecord(usage.output_tokens_details)
  const completionDetails = jsonRecord(usage.completion_tokens_details)
  const cacheCreationDetails = jsonRecord(usage.cache_creation)
  const serverToolUseDetails = jsonRecord(usage.server_tool_use ?? usage.serverToolUse)

  const rawInputTokens = numberValue(usage.input_tokens) ?? numberValue(usage.prompt_tokens) ?? numberValue(usage.inputTokens)
  const cacheCreationInputTokens = numberValue(usage.cache_creation_input_tokens) ?? numberValue(usage.cacheCreationInputTokens) ?? sumNumericValues(cacheCreationDetails)
  const directCacheReadInputTokens = numberValue(usage.cache_read_input_tokens) ?? numberValue(usage.cacheReadInputTokens)
  const cacheReadInputTokens = directCacheReadInputTokens
    ?? numberValue(inputDetails.cached_tokens)
    ?? numberValue(promptDetails.cached_tokens)
  const outputTokens = numberValue(usage.output_tokens) ?? numberValue(usage.completion_tokens) ?? numberValue(usage.outputTokens)
  const outputReasoningTokens = numberValue(outputDetails.reasoning_tokens) ?? numberValue(completionDetails.reasoning_tokens) ?? numberValue(usage.outputReasoningTokens)
  const webSearchRequests = numberValue(serverToolUseDetails.web_search_requests) ?? numberValue(serverToolUseDetails.webSearchRequests)
  const webFetchRequests = numberValue(serverToolUseDetails.web_fetch_requests) ?? numberValue(serverToolUseDetails.webFetchRequests)
  const mcpCalls = numberValue(serverToolUseDetails.mcp_calls) ?? numberValue(serverToolUseDetails.mcpCalls)

  const result: Partial<Canonical_Usage> = {}
  if (typeof rawInputTokens === "number") {
    const isAnthropicSplit = typeof cacheCreationInputTokens === "number" || typeof directCacheReadInputTokens === "number"
    result.inputTokens = isAnthropicSplit ? rawInputTokens : Math.max(0, rawInputTokens - (cacheReadInputTokens ?? 0))
  }
  if (typeof outputTokens === "number") result.outputTokens = outputTokens
  if (typeof cacheCreationInputTokens === "number") result.cacheCreationInputTokens = cacheCreationInputTokens
  if (typeof cacheReadInputTokens === "number") result.cacheReadInputTokens = cacheReadInputTokens
  if (typeof outputReasoningTokens === "number") result.outputReasoningTokens = outputReasoningTokens
  if (typeof webSearchRequests === "number" || typeof webFetchRequests === "number" || typeof mcpCalls === "number") {
    result.serverToolUse = {
      ...(typeof webSearchRequests === "number" ? { webSearchRequests } : {}),
      ...(typeof webFetchRequests === "number" ? { webFetchRequests } : {}),
      ...(typeof mcpCalls === "number" ? { mcpCalls } : {}),
    }
  }
  return result
}

export function mergeCanonicalUsage(target: Canonical_Usage, usage: Partial<Canonical_Usage>) {
  if (typeof usage.inputTokens === "number") target.inputTokens = usage.inputTokens
  if (typeof usage.outputTokens === "number") target.outputTokens = usage.outputTokens
  if (typeof usage.cacheCreationInputTokens === "number") target.cacheCreationInputTokens = usage.cacheCreationInputTokens
  if (typeof usage.cacheReadInputTokens === "number") target.cacheReadInputTokens = usage.cacheReadInputTokens
  if (typeof usage.outputReasoningTokens === "number") target.outputReasoningTokens = usage.outputReasoningTokens
  if (usage.serverToolUse) {
    target.serverToolUse = {
      ...(target.serverToolUse ?? {}),
      ...maxServerToolUse(target.serverToolUse, usage.serverToolUse),
    }
  }
}

export function canonicalInputTokenTotal(usage: Partial<Canonical_Usage> | undefined) {
  return (usage?.inputTokens ?? 0) + (usage?.cacheCreationInputTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0)
}

function jsonRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function sumNumericValues(value: JsonRecord) {
  let total = 0
  for (const item of Object.values(value)) {
    if (typeof item === "number" && Number.isFinite(item)) total += item
  }
  return total > 0 ? total : undefined
}

function maxServerToolUse(left: Canonical_Usage["serverToolUse"] | undefined, right: NonNullable<Canonical_Usage["serverToolUse"]>) {
  const webSearchRequests = maxDefined(left?.webSearchRequests, right.webSearchRequests)
  const webFetchRequests = maxDefined(left?.webFetchRequests, right.webFetchRequests)
  const mcpCalls = maxDefined(left?.mcpCalls, right.mcpCalls)
  return {
    ...(webSearchRequests !== undefined ? { webSearchRequests } : {}),
    ...(webFetchRequests !== undefined ? { webFetchRequests } : {}),
    ...(mcpCalls !== undefined ? { mcpCalls } : {}),
  }
}

function maxDefined(...values: Array<number | undefined>) {
  const numbers = values.filter((value): value is number => typeof value === "number")
  return numbers.length ? Math.max(...numbers) : undefined
}
