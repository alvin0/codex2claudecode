import { describe, expect, test } from "bun:test"
import { createUsageEstimate, mergeUsageEstimates } from "../../src/core/usage-source"

describe("UsageEstimate", () => {
  test("createUsageEstimate creates estimate with source", () => {
    const estimate = createUsageEstimate(100, 50, "upstream_exact")
    expect(estimate).toEqual({ inputTokens: 100, outputTokens: 50, source: "upstream_exact" })
  })

  test("createUsageEstimate includes cache fields when provided", () => {
    const estimate = createUsageEstimate(100, 50, "upstream_exact", {
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 20,
    })
    expect(estimate.cacheCreationInputTokens).toBe(10)
    expect(estimate.cacheReadInputTokens).toBe(20)
  })

  test("mergeUsageEstimates prefers more accurate source", () => {
    const current = createUsageEstimate(100, 50, "fallback_bytes")
    const merged = mergeUsageEstimates(current, { inputTokens: 200, source: "upstream_exact" })
    expect(merged.source).toBe("upstream_exact")
    expect(merged.inputTokens).toBe(200)
    expect(merged.outputTokens).toBe(50)
  })

  test("mergeUsageEstimates keeps current values when update is less accurate", () => {
    const current = createUsageEstimate(100, 50, "upstream_exact")
    const merged = mergeUsageEstimates(current, { inputTokens: 200, source: "fallback_bytes" })
    expect(merged.source).toBe("upstream_exact")
    expect(merged.inputTokens).toBe(100)
    expect(merged.outputTokens).toBe(50)
  })

  test("mergeUsageEstimates updates individual fields", () => {
    const current = createUsageEstimate(100, 50, "local_count")
    const merged = mergeUsageEstimates(current, { outputTokens: 75 })
    expect(merged.inputTokens).toBe(100)
    expect(merged.outputTokens).toBe(75)
    expect(merged.source).toBe("local_count")
  })
})
