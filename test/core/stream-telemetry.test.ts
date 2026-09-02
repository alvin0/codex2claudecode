import { describe, expect, test } from "bun:test"
import type { Canonical_FeatureNotice } from "../../src/core/canonical"
import { StreamTelemetryCollector } from "../../src/core/stream-telemetry"

describe("StreamTelemetryCollector", () => {
  test("initializes with defaults", () => {
    const collector = new StreamTelemetryCollector()
    const telemetry = collector.finalize()
    expect(telemetry.requestId).toBe("")
    expect(telemetry.streaming).toBe(false)
    expect(telemetry.textBlocks).toBe(0)
    expect(telemetry.clientCancelled).toBe(false)
    expect(telemetry.usageSource).toBe("unavailable")
    expect(telemetry.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("accepts init options", () => {
    const collector = new StreamTelemetryCollector({
      requestId: "req_1",
      provider: "kiro",
      model: "claude-sonnet-4",
      streaming: true,
    })
    const telemetry = collector.finalize()
    expect(telemetry.requestId).toBe("req_1")
    expect(telemetry.provider).toBe("kiro")
    expect(telemetry.model).toBe("claude-sonnet-4")
    expect(telemetry.streaming).toBe(true)
  })

  test("records block counts", () => {
    const collector = new StreamTelemetryCollector()
    collector.recordTextBlock()
    collector.recordTextBlock()
    collector.recordThinkingBlock()
    collector.recordClientToolCall()
    collector.recordServerToolCall()
    collector.recordServerToolCall()
    collector.recordStreamError()

    const telemetry = collector.finalize()
    expect(telemetry.textBlocks).toBe(2)
    expect(telemetry.thinkingBlocks).toBe(1)
    expect(telemetry.clientToolCalls).toBe(1)
    expect(telemetry.serverToolCalls).toBe(2)
    expect(telemetry.streamErrors).toBe(1)
  })

  test("marks first token time", () => {
    const collector = new StreamTelemetryCollector()
    collector.markFirstToken()
    const telemetry = collector.finalize()
    expect(telemetry.firstTokenMs).toBeGreaterThanOrEqual(0)
  })

  test("first token is only recorded once", () => {
    const collector = new StreamTelemetryCollector()
    collector.markFirstToken()
    const first = collector.finalize().firstTokenMs
    collector.markFirstToken()
    const second = collector.finalize().firstTokenMs
    expect(first).toBe(second)
  })

  test("stream cancellation is tracked separately", () => {
    const collector = new StreamTelemetryCollector()
    collector.clientCancelled = true
    collector.terminalEvent = "cancelled"
    const telemetry = collector.finalize()
    expect(telemetry.clientCancelled).toBe(true)
    expect(telemetry.terminalEvent).toBe("cancelled")
  })

  test("usage source is tracked", () => {
    const collector = new StreamTelemetryCollector()
    collector.usageSource = "upstream_exact"
    expect(collector.finalize().usageSource).toBe("upstream_exact")
  })

  test("first token retries are tracked", () => {
    const collector = new StreamTelemetryCollector()
    collector.firstTokenRetries = 2
    expect(collector.finalize().firstTokenRetries).toBe(2)
  })
})

describe("StreamTelemetryCollector provider credits", () => {
  test("omits providerCredits when nothing was recorded", () => {
    const collector = new StreamTelemetryCollector()
    const telemetry = collector.finalize()
    expect(telemetry.providerCredits).toBeUndefined()
    expect("providerCredits" in telemetry).toBe(true)
  })

  test("records a single reported amount", () => {
    const collector = new StreamTelemetryCollector()
    collector.recordProviderCredits(0.0148)
    expect(collector.finalize().providerCredits).toBe(0.0148)
  })

  test("sums repeated reports rather than replacing them", () => {
    const collector = new StreamTelemetryCollector()
    collector.recordProviderCredits(0.0148)
    collector.recordProviderCredits(0.0052)
    expect(collector.finalize().providerCredits).toBeCloseTo(0.02, 10)
  })

  test("a recorded zero is distinct from never recording", () => {
    const measuredFree = new StreamTelemetryCollector()
    measuredFree.recordProviderCredits(0)
    expect(measuredFree.finalize().providerCredits).toBe(0)
    expect(new StreamTelemetryCollector().finalize().providerCredits).toBeUndefined()
  })

  test("records negative amounts so a refund frame is not silently dropped", () => {
    const collector = new StreamTelemetryCollector()
    collector.recordProviderCredits(0.05)
    collector.recordProviderCredits(-0.02)
    expect(collector.finalize().providerCredits).toBeCloseTo(0.03, 10)
  })

  test("ignores non-finite values instead of poisoning the total", () => {
    const collector = new StreamTelemetryCollector()
    collector.recordProviderCredits(0.0148)
    collector.recordProviderCredits(Number.NaN)
    collector.recordProviderCredits(Number.POSITIVE_INFINITY)
    collector.recordProviderCredits(Number.NEGATIVE_INFINITY)
    expect(collector.finalize().providerCredits).toBe(0.0148)
  })

  test("a non-finite value alone leaves the total unmeasured", () => {
    const collector = new StreamTelemetryCollector()
    collector.recordProviderCredits(Number.NaN)
    expect(collector.finalize().providerCredits).toBeUndefined()
  })

  test("credits are excluded from every token counter", () => {
    const collector = new StreamTelemetryCollector()
    collector.recordProviderCredits(0.0148)
    const telemetry = collector.finalize()
    expect(telemetry.textBlocks).toBe(0)
    expect(telemetry.thinkingBlocks).toBe(0)
    expect(telemetry.clientToolCalls).toBe(0)
    expect(telemetry.serverToolCalls).toBe(0)
    expect(telemetry.streamErrors).toBe(0)
    expect(telemetry.usageSource).toBe("unavailable")
  })

  test("finalize stays idempotent — a later record does not change the snapshot", () => {
    const collector = new StreamTelemetryCollector()
    collector.recordProviderCredits(0.0148)
    const first = collector.finalize()
    collector.recordProviderCredits(1)
    const second = collector.finalize()
    expect(second).toBe(first)
    expect(second.providerCredits).toBe(0.0148)
  })
})

// Task 8.3 / Requirements 8.2, 8.3, 8.4 — the streaming half of notice collection. The
// non-streaming fold has the matching block in `test/core/canonical-accumulator.test.ts`.
describe("StreamTelemetryCollector feature notices", () => {
  const sampling: Canonical_FeatureNotice = { feature: "sampling", policy: "degrade", detail: "temperature=0.2 was not sent upstream" }
  const structured: Canonical_FeatureNotice = { feature: "structuredOutput", policy: "emulate", detail: "response_format emulated via a tool" }

  test("omits featureNotices entirely when nothing was recorded", () => {
    const telemetry = new StreamTelemetryCollector().finalize()
    expect(telemetry.featureNotices).toBeUndefined()
    expect("featureNotices" in telemetry).toBe(false)
  })

  test("preserves emission order", () => {
    const collector = new StreamTelemetryCollector()
    collector.recordFeatureNotice(structured)
    collector.recordFeatureNotice(sampling)
    collector.recordFeatureNotice({ feature: "webSearch", policy: "degrade", detail: "web_search dropped" })
    expect(collector.finalize().featureNotices).toEqual([structured, sampling, { feature: "webSearch", policy: "degrade", detail: "web_search dropped" }])
  })

  test("keeps one entry per event including exact duplicates", () => {
    const collector = new StreamTelemetryCollector()
    collector.recordFeatureNotice(sampling)
    collector.recordFeatureNotice(sampling)
    collector.recordFeatureNotice(structured)
    collector.recordFeatureNotice(sampling)
    const telemetry = collector.finalize()
    expect(telemetry.featureNotices).toHaveLength(4)
    expect(telemetry.featureNotices?.map((notice) => notice.feature)).toEqual(["sampling", "sampling", "structuredOutput", "sampling"])
  })

  test("records exactly the three canonical members, never the event discriminant", () => {
    const collector = new StreamTelemetryCollector()
    // A `feature_notice` event is structurally assignable to the parameter, so the extra
    // `type` member must not survive into the snapshot.
    const event = { type: "feature_notice" as const, ...sampling }
    collector.recordFeatureNotice(event)
    expect(Object.keys(collector.finalize().featureNotices![0]!).sort()).toEqual(["detail", "feature", "policy"])
  })

  test("snapshots the list rather than aliasing collector state", () => {
    const collector = new StreamTelemetryCollector()
    collector.recordFeatureNotice(sampling)
    const telemetry = collector.finalize()
    // An already-handed-out snapshot must not grow behind its holder's back. The
    // snapshot is cached, so aliasing here would also defeat `finalize()`'s idempotence.
    collector.recordFeatureNotice(structured)
    expect(telemetry.featureNotices).toHaveLength(1)
    expect(telemetry.featureNotices?.[0]).toEqual(sampling)
  })

  test("does not alias the recorded notice object", () => {
    const collector = new StreamTelemetryCollector()
    const mutable: Canonical_FeatureNotice = { feature: "sampling", policy: "degrade", detail: "original" }
    collector.recordFeatureNotice(mutable)
    mutable.detail = "rewritten after the fact"
    expect(collector.finalize().featureNotices?.[0]?.detail).toBe("original")
  })

  test("finalize stays idempotent — a later notice does not change the snapshot", () => {
    const collector = new StreamTelemetryCollector()
    collector.recordFeatureNotice(sampling)
    const first = collector.finalize()
    collector.recordFeatureNotice(structured)
    const second = collector.finalize()
    expect(second).toBe(first)
    expect(second.featureNotices).toHaveLength(1)
  })

  test("notices touch no token or block counter (Requirement 8.4)", () => {
    const collector = new StreamTelemetryCollector()
    collector.recordFeatureNotice(sampling)
    collector.recordFeatureNotice(structured)
    const telemetry = collector.finalize()
    expect(telemetry.textBlocks).toBe(0)
    expect(telemetry.thinkingBlocks).toBe(0)
    expect(telemetry.clientToolCalls).toBe(0)
    expect(telemetry.serverToolCalls).toBe(0)
    expect(telemetry.streamErrors).toBe(0)
    expect(telemetry.providerCredits).toBeUndefined()
    expect(telemetry.usageSource).toBe("unavailable")
  })
})
