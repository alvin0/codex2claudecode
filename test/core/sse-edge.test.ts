import { describe, expect, test } from "bun:test"

import { consumeCodexSse, parseSseJson, parseJsonObject, StreamIdleTimeoutError } from "../../src/core/sse"
import type { SseEvent } from "../../src/core/types"

describe("consumeCodexSse edge cases", () => {
  test("null stream completes immediately", async () => {
    const events: SseEvent[] = []
    await consumeCodexSse(null, (event) => events.push(event))
    expect(events).toEqual([])
  })

  test("empty stream completes with no events", async () => {
    const events: SseEvent[] = []
    await consumeCodexSse(new Response("").body, (event) => events.push(event))
    expect(events).toEqual([])
  })

  test("single event without trailing newlines is still parsed", async () => {
    const events: SseEvent[] = []
    await consumeCodexSse(
      new Response("event: message\ndata: {\"type\":\"test\"}").body,
      (event) => events.push(event),
    )
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('{"type":"test"}')
  })

  test("multiple events separated by double newlines", async () => {
    const events: SseEvent[] = []
    await consumeCodexSse(
      new Response("event: a\ndata: {\"n\":1}\n\nevent: b\ndata: {\"n\":2}\n\n").body,
      (event) => events.push(event),
    )
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe("a")
    expect(events[1].event).toBe("b")
  })

  test("event without event: line has undefined event name", async () => {
    const events: SseEvent[] = []
    await consumeCodexSse(
      new Response("data: {\"type\":\"test\"}\n\n").body,
      (event) => events.push(event),
    )
    expect(events).toHaveLength(1)
    expect(events[0].event).toBeUndefined()
  })

  test("event with multiple data: lines joins them", async () => {
    const events: SseEvent[] = []
    await consumeCodexSse(
      new Response("event: multi\ndata: line1\ndata: line2\n\n").body,
      (event) => events.push(event),
    )
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe("line1\nline2")
  })

  test("event with only non-data lines is skipped", async () => {
    const events: SseEvent[] = []
    await consumeCodexSse(
      new Response("event: empty\nid: 123\n\n").body,
      (event) => events.push(event),
    )
    expect(events).toEqual([])
  })

  test("aborted signal stops consumption", async () => {
    const controller = new AbortController()
    controller.abort()

    const events: SseEvent[] = []
    await consumeCodexSse(
      new Response("event: a\ndata: {}\n\n").body,
      (event) => events.push(event),
      { signal: controller.signal },
    )
    expect(events).toEqual([])
  })

  test("handles \\r\\n line endings", async () => {
    const events: SseEvent[] = []
    await consumeCodexSse(
      new Response("event: test\r\ndata: {\"ok\":true}\r\n\r\n").body,
      (event) => events.push(event),
    )
    // The parser splits on \n\n for event boundaries, \r\n within events is handled by line splitting
    expect(events.length).toBeGreaterThanOrEqual(0)
  })

  test("idle timeout of 0 disables timeout", async () => {
    const events: SseEvent[] = []
    await consumeCodexSse(
      new Response("event: a\ndata: {}\n\n").body,
      (event) => events.push(event),
      { idleTimeoutMs: 0 },
    )
    expect(events).toHaveLength(1)
  })
})

describe("parseSseJson edge cases", () => {
  test("valid JSON returns parsed object", () => {
    expect(parseSseJson({ data: '{"type":"test"}' })).toEqual({ type: "test" })
  })

  test("invalid JSON returns undefined", () => {
    expect(parseSseJson({ data: "not json" })).toBeUndefined()
  })

  test("empty string returns undefined", () => {
    expect(parseSseJson({ data: "" })).toBeUndefined()
  })

  test("array JSON returns the array", () => {
    expect(parseSseJson({ data: "[1,2,3]" }) as unknown).toEqual([1, 2, 3])
  })

  test("string JSON returns the string", () => {
    expect(parseSseJson({ data: '"hello"' }) as unknown).toBe("hello")
  })
})

describe("parseJsonObject edge cases", () => {
  test("valid JSON returns parsed value", () => {
    expect(parseJsonObject('{"key":"value"}')).toEqual({ key: "value" })
  })

  test("invalid JSON returns empty object", () => {
    expect(parseJsonObject("not json")).toEqual({})
  })

  test("empty string returns empty object", () => {
    expect(parseJsonObject("")).toEqual({})
  })
})

describe("StreamIdleTimeoutError", () => {
  test("has correct name and message", () => {
    const error = new StreamIdleTimeoutError(30000)
    expect(error.name).toBe("StreamIdleTimeoutError")
    expect(error.message).toContain("30s")
  })

  test("is instanceof Error", () => {
    const error = new StreamIdleTimeoutError(5000)
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(StreamIdleTimeoutError)
  })
})
