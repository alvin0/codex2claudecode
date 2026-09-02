/**
 * Provider capability metadata interfaces and defaults.
 *
 * Only provider-agnostic types and defaults live here.
 * Concrete provider capabilities belong in their respective
 * upstream provider directories.
 */

/**
 * What the Gateway does with a client-supplied field an upstream cannot honor natively.
 *
 * There is no fifth path: `native` forwards the value, `emulate` reproduces the
 * behavior locally, `degrade` changes the semantics and says so, `reject` fails
 * the request with an alternative.
 */
export type FeaturePolicy = "native" | "emulate" | "degrade" | "reject"

export const FEATURE_POLICIES = ["native", "emulate", "degrade", "reject"] as const satisfies readonly FeaturePolicy[]

/**
 * The named features every upstream declares a `FeaturePolicy` for.
 *
 * Names describe client intent, never a wire field of any one provider.
 */
export type ProviderFeature =
  | "sampling"
  | "stopSequences"
  | "thinkingBudget"
  | "systemPrompt"
  | "promptCache"
  | "strictToolSchema"
  | "toolChoiceForced"
  | "structuredOutput"
  | "webSearch"
  | "webFetch"
  | "mcpToolset"

export const PROVIDER_FEATURES = [
  "sampling",
  "stopSequences",
  "thinkingBudget",
  "systemPrompt",
  "promptCache",
  "strictToolSchema",
  "toolChoiceForced",
  "structuredOutput",
  "webSearch",
  "webFetch",
  "mcpToolset",
] as const satisfies readonly ProviderFeature[]

/**
 * Compile-time guard against drift between each union and its runtime array.
 *
 * `satisfies` already rejects an array member outside the union; these aliases
 * reject a union member missing from the array, so the two cannot diverge in
 * either direction. Both must resolve to `never` for this file to compile.
 */
type AssertNever<T extends never> = T
type _EveryFeaturePolicyIsListed = AssertNever<Exclude<FeaturePolicy, (typeof FEATURE_POLICIES)[number]>>
type _EveryProviderFeatureIsListed = AssertNever<Exclude<ProviderFeature, (typeof PROVIDER_FEATURES)[number]>>

/** Whether a declared policy rests on a live measurement. */
export type FeatureEvidence = "measured" | "unmeasured"

/**
 * Hosted tool type names are client wire vocabulary; core keeps the keys opaque.
 *
 * Each upstream lists the type names it cares about in its own `capabilities.ts`,
 * so no provider-specific tool type name enters this module.
 */
export type HostedToolPolicyMap = Readonly<Record<string, FeaturePolicy>>

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
  /** Required — the compiler locates every declaration site. */
  features: Record<ProviderFeature, FeaturePolicy>
  /** Optional; an absent type resolves to a degrade notice, never a throw. */
  hostedTools?: HostedToolPolicyMap
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
