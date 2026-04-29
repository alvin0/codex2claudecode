/**
 * Provider capability metadata interfaces and defaults.
 *
 * Only provider-agnostic types and defaults live here.
 * Concrete provider capabilities belong in their respective
 * upstream provider directories.
 */

export interface ProviderCapabilities {
  streaming: boolean
  passthrough: boolean
  usageSupport: boolean
  environmentsSupport: boolean
  usageEndpointSupport: boolean
  tokenCountingSupport: boolean
  modelListingSupport: boolean
  retryPolicy: RetryPolicy
  timeoutPolicy: TimeoutPolicy
  logBodyDefault: boolean
}

export interface RetryPolicy {
  maxRetries: number
  baseDelayMs: number
  retryableStatuses: number[]
}

export interface TimeoutPolicy {
  requestTimeoutMs: number
  streamIdleTimeoutMs: number
  firstTokenTimeoutMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  retryableStatuses: [408, 409, 429, 500, 502, 503, 504],
}

export const DEFAULT_TIMEOUT_POLICY: TimeoutPolicy = {
  requestTimeoutMs: 0,
  streamIdleTimeoutMs: 300_000,
  firstTokenTimeoutMs: 0,
}
