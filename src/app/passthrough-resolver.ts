import type { PassthroughDecider, UpstreamProviderKind } from "../core/interfaces"

/**
 * Every input the passthrough policy is allowed to read.
 *
 * There are no headers here on purpose: client identity (`originator`,
 * `user-agent`) is log-only, and keeping it out of this shape makes that
 * structural rather than a convention someone can quietly break.
 */
export interface PassthroughInputs {
  routePath: string
  providerKind: UpstreamProviderKind
  stream: boolean
  flagEnabled: boolean
}

/**
 * Passthrough is exactly a four-way conjunction. Anything else is canonical.
 *
 * `stream === true` is required because `stream: false` on `/v1/responses`
 * would hand the client raw Codex SSE instead of JSON, and a non-streaming
 * response has no SSE termination to key off.
 */
export function resolvePassthrough(inputs: PassthroughInputs): boolean {
  return inputs.routePath === "/v1/responses"
    && inputs.providerKind === "codex"
    && inputs.stream === true
    && inputs.flagEnabled === true
}

/** Pre-binds the two values known at composition time. */
export function passthroughDecider(
  bound: { providerKind: UpstreamProviderKind, flagEnabled: boolean },
): PassthroughDecider {
  return (routePath, stream) => resolvePassthrough({ ...bound, routePath, stream })
}
