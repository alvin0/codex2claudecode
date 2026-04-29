import { describe, expect, test } from "bun:test"
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
