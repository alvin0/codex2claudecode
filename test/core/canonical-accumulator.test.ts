import { describe, expect, test } from "bun:test"
import { CanonicalStreamAccumulator, accumulateCanonicalStream } from "../../src/core/canonical-accumulator"
import type { Canonical_Event, Canonical_StreamResponse } from "../../src/core/canonical"

function makeStream(events: Canonical_Event[], id = "resp_test", model = "test-model"): Canonical_StreamResponse {
  return {
    type: "canonical_stream",
    status: 200,
    id,
    model,
    events: (async function* () {
      for (const event of events) yield event
    })(),
  }
}

describe("CanonicalStreamAccumulator", () => {
  test("text-only stream: deltas accumulate into one text block", async () => {
    const stream = makeStream([
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " world" },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.type).toBe("canonical_response")
    expect(result.id).toBe("resp_test")
    expect(result.model).toBe("test-model")
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({ type: "text", text: "Hello world" })
    expect(result.stopReason).toBe("end_turn")
  })

  test("text_done replaces accumulated text", async () => {
    const stream = makeStream([
      { type: "text_delta", delta: "partial" },
      { type: "text_done", text: "final complete text" },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({ type: "text", text: "final complete text" })
  })

  test("thinking then text: thinking block closes before text starts and includes signature", async () => {
    const stream = makeStream([
      { type: "thinking_signature", signature: "sig_abc123" },
      { type: "thinking_delta", text: "Let me think..." },
      { type: "thinking_delta", text: " about this." },
      { type: "text_delta", delta: "Here is my answer." },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toEqual({
      type: "thinking",
      thinking: "Let me think... about this.",
      signature: "sig_abc123",
    })
    expect(result.content[1]).toEqual({
      type: "text",
      text: "Here is my answer.",
    })
  })

  test("thinking block gets fallback signature when none provided", async () => {
    const stream = makeStream([
      { type: "thinking_delta", text: "thinking without signature" },
      { type: "text_delta", delta: "answer" },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.content).toHaveLength(2)
    const thinking = result.content[0]
    expect(thinking.type).toBe("thinking")
    if (thinking.type === "thinking") {
      expect(thinking.thinking).toBe("thinking without signature")
      expect(thinking.signature).toMatch(/^sig_/)
    }
  })

  test("tool call after text: text closes, tool call appended, stop reason becomes tool_use", async () => {
    const stream = makeStream([
      { type: "text_delta", delta: "I'll use a tool." },
      { type: "tool_call_done", callId: "call_1", name: "get_weather", arguments: '{"city":"NYC"}' },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toEqual({ type: "text", text: "I'll use a tool." })
    expect(result.content[1]).toEqual({
      type: "tool_call",
      id: "call_1",
      callId: "call_1",
      name: "get_weather",
      arguments: '{"city":"NYC"}',
    })
    expect(result.stopReason).toBe("tool_use")
  })

  test("server tool use/result before answer text preserves block order", async () => {
    const serverBlocks = [
      { type: "server_tool_use", id: "st_1", name: "web_search", input: { query: "test" } },
      { type: "web_search_tool_result", tool_use_id: "st_1", content: "results" },
    ]
    const stream = makeStream([
      { type: "server_tool_block", blocks: serverBlocks },
      { type: "text_delta", delta: "Based on the search..." },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toEqual({ type: "server_tool", blocks: serverBlocks })
    expect(result.content[1]).toEqual({ type: "text", text: "Based on the search..." })
  })

  test("usage events before and after completion produce the latest cumulative usage snapshot", async () => {
    const stream = makeStream([
      { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } },
      { type: "text_delta", delta: "text" },
      { type: "usage", usage: { outputTokens: 50 } },
      { type: "completion", usage: { inputTokens: 100, outputTokens: 75, cacheReadInputTokens: 20 } },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.outputTokens).toBe(75)
    expect(result.usage.cacheReadInputTokens).toBe(20)
  })

  test("error event finalizes state safely without inventing successful content", async () => {
    const stream = makeStream([
      { type: "text_delta", delta: "partial" },
      { type: "error", message: "upstream failure" },
    ])
    const accumulator = new CanonicalStreamAccumulator("resp_err", "model")
    for await (const event of stream.events) {
      accumulator.apply(event)
    }

    expect(accumulator.hasError).toBe(true)
    const result = accumulator.finalize()
    // Text block is still present (it was open before error)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({ type: "text", text: "partial" })
  })

  test("message_start updates id and model", async () => {
    const stream = makeStream([
      { type: "message_start", id: "resp_new", model: "new-model" },
      { type: "text_delta", delta: "hello" },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.id).toBe("resp_new")
    expect(result.model).toBe("new-model")
  })

  test("message_stop sets stop reason", async () => {
    const stream = makeStream([
      { type: "text_delta", delta: "text" },
      { type: "message_stop", stopReason: "max_tokens" },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.stopReason).toBe("max_tokens")
  })

  test("completion stopReason overrides default", async () => {
    const stream = makeStream([
      { type: "text_delta", delta: "text" },
      { type: "completion", stopReason: "max_tokens" },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.stopReason).toBe("max_tokens")
  })

  test("tool_call_done wins over end_turn stop reason", async () => {
    const stream = makeStream([
      { type: "tool_call_done", callId: "c1", name: "fn", arguments: "{}" },
      { type: "message_stop", stopReason: "end_turn" },
    ])
    const result = await accumulateCanonicalStream(stream)

    // tool_use should win because content includes tool calls
    expect(result.stopReason).toBe("tool_use")
  })

  test("tool_call_delta fragments are flushed on finalize", async () => {
    const stream = makeStream([
      { type: "tool_call_delta", callId: "c1", name: "fn", argumentsDelta: '{"ke' },
      { type: "tool_call_delta", callId: "c1", name: "fn", argumentsDelta: 'y":"val"}' },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({
      type: "tool_call",
      id: "c1",
      callId: "c1",
      name: "fn",
      arguments: '{"key":"val"}',
    })
    expect(result.stopReason).toBe("tool_use")
  })

  test("unknown event types are tolerated", async () => {
    const stream = makeStream([
      { type: "text_delta", delta: "hello" },
      { type: "lifecycle", label: "processing" },
      { type: "content_block_start", blockType: "text", index: 0 },
      { type: "content_block_stop", index: 0 },
      { type: "message_item_done", item: {} },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({ type: "text", text: "hello" })
  })

  test("server tool usage is merged via usage events", async () => {
    const stream = makeStream([
      { type: "text_delta", delta: "text" },
      { type: "usage", usage: { serverToolUse: { webSearchRequests: 1 } } },
      { type: "usage", usage: { serverToolUse: { webSearchRequests: 2, mcpCalls: 1 } } },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.usage.serverToolUse).toEqual({ webSearchRequests: 2, mcpCalls: 1 })
  })

  test("empty stream produces minimal valid response", async () => {
    const stream = makeStream([])
    const result = await accumulateCanonicalStream(stream)

    expect(result.type).toBe("canonical_response")
    expect(result.content).toHaveLength(0)
    expect(result.stopReason).toBe("end_turn")
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  test("multiple text blocks separated by tool calls", async () => {
    const stream = makeStream([
      { type: "text_delta", delta: "first" },
      { type: "tool_call_done", callId: "c1", name: "fn", arguments: "{}" },
      { type: "text_delta", delta: "second" },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.content).toHaveLength(3)
    expect(result.content[0]).toEqual({ type: "text", text: "first" })
    expect(result.content[1].type).toBe("tool_call")
    expect(result.content[2]).toEqual({ type: "text", text: "second" })
  })

  test("thinking with label uses label as text", async () => {
    const stream = makeStream([
      { type: "thinking_delta", label: "Processing..." },
      { type: "text_delta", delta: "done" },
    ])
    const result = await accumulateCanonicalStream(stream)

    expect(result.content).toHaveLength(2)
    if (result.content[0].type === "thinking") {
      expect(result.content[0].thinking).toBe("Processing...")
    }
  })
})

// Task 8.2 / Requirement 8.2, 8.3, 8.4 — the shared non-streaming fold of `feature_notice`.
describe("CanonicalStreamAccumulator feature notices", () => {
  const sampling: Canonical_Event = { type: "feature_notice", feature: "sampling", policy: "degrade", detail: "temperature=0.2 was not sent upstream" }
  const structured: Canonical_Event = { type: "feature_notice", feature: "structuredOutput", policy: "emulate", detail: "response_format emulated via a tool" }

  test("omits featureNotices entirely when the stream carries none", async () => {
    const result = await accumulateCanonicalStream(makeStream([{ type: "text_delta", delta: "hello" }]))

    expect(result.featureNotices).toBeUndefined()
    expect("featureNotices" in result).toBe(false)
  })

  test("collects notices in emission order across interleaved events", async () => {
    const result = await accumulateCanonicalStream(makeStream([
      sampling,
      { type: "text_delta", delta: "answer" },
      structured,
      { type: "tool_call_done", callId: "c1", name: "fn", arguments: "{}" },
      { type: "feature_notice", feature: "webSearch", policy: "degrade", detail: "web_search dropped" },
    ]))

    expect(result.featureNotices).toEqual([
      { feature: "sampling", policy: "degrade", detail: "temperature=0.2 was not sent upstream" },
      { feature: "structuredOutput", policy: "emulate", detail: "response_format emulated via a tool" },
      { feature: "webSearch", policy: "degrade", detail: "web_search dropped" },
    ])
  })

  test("keeps one entry per event, including exact duplicates", async () => {
    const result = await accumulateCanonicalStream(makeStream([sampling, sampling, structured, sampling]))

    expect(result.featureNotices).toHaveLength(4)
    expect(result.featureNotices?.map((notice) => notice.feature)).toEqual(["sampling", "sampling", "structuredOutput", "sampling"])
  })

  test("carries no `type` member through into the response entries", async () => {
    const result = await accumulateCanonicalStream(makeStream([sampling]))

    expect(Object.keys(result.featureNotices![0]!).sort()).toEqual(["detail", "feature", "policy"])
  })

  test("a notice between two text deltas does not split the text block or move tokens", async () => {
    const withNotices: Canonical_Event[] = [
      sampling,
      { type: "text_delta", delta: "Hello" },
      structured,
      { type: "text_delta", delta: " world" },
      { type: "usage", usage: { inputTokens: 100, outputTokens: 25 } },
      { type: "message_stop", stopReason: "end_turn" },
    ]
    const withoutNotices = withNotices.filter((event) => event.type !== "feature_notice")

    const noticed = await accumulateCanonicalStream(makeStream(withNotices))
    const bare = await accumulateCanonicalStream(makeStream(withoutNotices))

    expect(noticed.content).toEqual([{ type: "text", text: "Hello world" }])
    expect(noticed.content).toEqual(bare.content)
    expect(noticed.usage).toEqual(bare.usage)
    expect(noticed.stopReason).toBe(bare.stopReason)
    expect(bare.featureNotices).toBeUndefined()
  })

  test("a notice does not close an open thinking block", async () => {
    const result = await accumulateCanonicalStream(makeStream([
      { type: "thinking_signature", signature: "sig_abc" },
      { type: "thinking_delta", text: "first" },
      sampling,
      { type: "thinking_delta", text: " second" },
    ]))

    expect(result.content).toEqual([{ type: "thinking", thinking: "first second", signature: "sig_abc" }])
    expect(result.featureNotices).toHaveLength(1)
  })

  test("a notice-only stream still produces a valid zero-token response", async () => {
    const result = await accumulateCanonicalStream(makeStream([sampling]))

    expect(result.content).toHaveLength(0)
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(result.stopReason).toBe("end_turn")
    expect(result.featureNotices).toHaveLength(1)
  })

  test("finalize snapshots the notices rather than aliasing accumulator state", () => {
    const accumulator = new CanonicalStreamAccumulator("resp_x", "model")
    accumulator.apply(sampling)
    const first = accumulator.finalize()
    accumulator.apply(structured)
    const second = accumulator.finalize()

    expect(first.featureNotices).toHaveLength(1)
    expect(second.featureNotices).toHaveLength(2)
  })
})
