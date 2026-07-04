import type { ProviderCapabilities } from "../../core/provider-capabilities"
import { DEFAULT_RETRY_POLICY } from "../../core/provider-capabilities"
import { KIRO_FIRST_TOKEN_TIMEOUT_MS } from "./constants"

export const KIRO_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  passthrough: false,
  usageSupport: true,
  environmentsSupport: false,
  usageEndpointSupport: false,
  tokenCountingSupport: false,
  modelListingSupport: true,
  retryPolicy: {
    ...DEFAULT_RETRY_POLICY,
    maxRetries: 3,
  },
  timeoutPolicy: {
    requestTimeoutMs: 0,
    streamIdleTimeoutMs: 300_000,
    firstTokenTimeoutMs: KIRO_FIRST_TOKEN_TIMEOUT_MS,
  },
  logBodyDefault: true,
}
