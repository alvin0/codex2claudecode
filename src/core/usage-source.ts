/**
 * Tracks the source and accuracy of usage/token estimates.
 *
 * Providers should set the source when reporting usage to make
 * it clear whether tokens are exact upstream counts, local estimates,
 * or fallback approximations.
 */
export type UsageSource =
  | "upstream_exact"
  | "local_count"
  | "context_percentage_estimate"
  | "fallback_tokenizer"
  | "fallback_bytes"
  | "unavailable"

export interface UsageEstimate {
  inputTokens: number
  outputTokens: number
  source: UsageSource
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

/**
 * Create a usage estimate with explicit source tracking.
 */
export function createUsageEstimate(
  inputTokens: number,
  outputTokens: number,
  source: UsageSource,
  options?: { cacheCreationInputTokens?: number; cacheReadInputTokens?: number },
): UsageEstimate {
  return {
    inputTokens,
    outputTokens,
    source,
    ...(options?.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: options.cacheCreationInputTokens } : {}),
    ...(options?.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: options.cacheReadInputTokens } : {}),
  }
}

/**
 * Merge two usage estimates, preferring the more accurate source.
 * Source priority: upstream_exact > local_count > context_percentage_estimate > fallback_tokenizer > fallback_bytes > unavailable
 */
export function mergeUsageEstimates(current: UsageEstimate, update: Partial<UsageEstimate>): UsageEstimate {
  const result = { ...current }
  const updateWins = update.source !== undefined && sourcePriority(update.source) >= sourcePriority(current.source)
  if (updateWins) {
    result.source = update.source!
    if (typeof update.inputTokens === "number") result.inputTokens = update.inputTokens
    if (typeof update.outputTokens === "number") result.outputTokens = update.outputTokens
    if (typeof update.cacheCreationInputTokens === "number") result.cacheCreationInputTokens = update.cacheCreationInputTokens
    if (typeof update.cacheReadInputTokens === "number") result.cacheReadInputTokens = update.cacheReadInputTokens
  } else if (!update.source) {
    if (typeof update.inputTokens === "number") result.inputTokens = update.inputTokens
    if (typeof update.outputTokens === "number") result.outputTokens = update.outputTokens
    if (typeof update.cacheCreationInputTokens === "number") result.cacheCreationInputTokens = update.cacheCreationInputTokens
    if (typeof update.cacheReadInputTokens === "number") result.cacheReadInputTokens = update.cacheReadInputTokens
  }
  return result
}

/**
 * Log a safe diagnostic when falling back from exact upstream usage to an estimate.
 * Only logs when the source is a fallback type, not upstream_exact.
 */
export function logUsageFallback(source: UsageSource, context: { provider?: string; model?: string; inputTokens?: number } = {}) {
  if (source === "upstream_exact" || source === "unavailable") return
  const parts = [`Usage estimate source: ${source}`]
  if (context.provider) parts.push(`provider=${context.provider}`)
  if (context.model) parts.push(`model=${context.model}`)
  if (typeof context.inputTokens === "number") parts.push(`inputTokens=${context.inputTokens}`)
  console.warn(parts.join(", "))
}

function sourcePriority(source: UsageSource): number {
  switch (source) {
    case "upstream_exact": return 5
    case "local_count": return 4
    case "context_percentage_estimate": return 3
    case "fallback_tokenizer": return 2
    case "fallback_bytes": return 1
    case "unavailable": return 0
  }
}
