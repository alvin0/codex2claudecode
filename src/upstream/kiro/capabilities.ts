import type { ProviderCapabilities } from "../../core/provider-capabilities"
import { DEFAULT_RETRY_POLICY } from "../../core/provider-capabilities"

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
    firstTokenTimeoutMs: 2000,
  },
  logBodyDefault: true,
}
