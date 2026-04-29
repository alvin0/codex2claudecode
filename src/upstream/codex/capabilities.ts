import type { ProviderCapabilities } from "../../core/provider-capabilities"
import { DEFAULT_RETRY_POLICY, DEFAULT_TIMEOUT_POLICY } from "../../core/provider-capabilities"

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  passthrough: true,
  usageSupport: true,
  environmentsSupport: true,
  usageEndpointSupport: true,
  tokenCountingSupport: true,
  modelListingSupport: false,
  retryPolicy: DEFAULT_RETRY_POLICY,
  timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
  logBodyDefault: true,
}
