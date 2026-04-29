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
