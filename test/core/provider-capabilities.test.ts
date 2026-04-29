import { describe, expect, test } from "bun:test"
import { DEFAULT_RETRY_POLICY, DEFAULT_TIMEOUT_POLICY } from "../../src/core/provider-capabilities"
import { CODEX_CAPABILITIES } from "../../src/upstream/codex/capabilities"
import { KIRO_CAPABILITIES } from "../../src/upstream/kiro/capabilities"

describe("ProviderCapabilities", () => {
  test("Codex capabilities match expected defaults", () => {
    expect(CODEX_CAPABILITIES.streaming).toBe(true)
    expect(CODEX_CAPABILITIES.passthrough).toBe(true)
    expect(CODEX_CAPABILITIES.usageSupport).toBe(true)
    expect(CODEX_CAPABILITIES.environmentsSupport).toBe(true)
    expect(CODEX_CAPABILITIES.usageEndpointSupport).toBe(true)
    expect(CODEX_CAPABILITIES.tokenCountingSupport).toBe(true)
    expect(CODEX_CAPABILITIES.modelListingSupport).toBe(false)
  })

  test("Kiro capabilities match expected defaults", () => {
    expect(KIRO_CAPABILITIES.streaming).toBe(true)
    expect(KIRO_CAPABILITIES.passthrough).toBe(false)
    expect(KIRO_CAPABILITIES.usageSupport).toBe(true)
    expect(KIRO_CAPABILITIES.environmentsSupport).toBe(false)
    expect(KIRO_CAPABILITIES.usageEndpointSupport).toBe(false)
    expect(KIRO_CAPABILITIES.tokenCountingSupport).toBe(false)
    expect(KIRO_CAPABILITIES.modelListingSupport).toBe(true)
  })

  test("Kiro has first-token timeout configured", () => {
    expect(KIRO_CAPABILITIES.timeoutPolicy.firstTokenTimeoutMs).toBe(2000)
    expect(CODEX_CAPABILITIES.timeoutPolicy.firstTokenTimeoutMs).toBe(0)
  })

  test("retry policies include standard retryable statuses", () => {
    expect(CODEX_CAPABILITIES.retryPolicy.retryableStatuses).toContain(429)
    expect(CODEX_CAPABILITIES.retryPolicy.retryableStatuses).toContain(503)
    expect(KIRO_CAPABILITIES.retryPolicy.retryableStatuses).toContain(429)
  })

  test("default policies are provider-agnostic", () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3)
    expect(DEFAULT_TIMEOUT_POLICY.streamIdleTimeoutMs).toBe(300_000)
  })
})
