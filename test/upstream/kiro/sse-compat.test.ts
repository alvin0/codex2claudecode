import { describe, expect, test } from "bun:test"

import type { Canonical_Event, Canonical_StreamResponse } from "../../../src/core/canonical"
import { claudeCanonicalStreamResponse } from "../../../src/inbound/claude/response"
import { streamKiroResponse } from "../../../src/upstream/kiro"
import { readSse } from "../../helpers"

function response(body: string) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  }))
}

function indexOfEvent(events: Array<{ event?: string; data: any }>, predicate: (event: { event?: string; data: any }, index: number) => boolean) {
  const index = events.findIndex(predicate)
  expect(index).toBeGreaterThan(-1)
  return index
}

async function readClaudeSseFromKiro(body: string) {
  const canonical = streamKiroResponse(response(body), "claude-sonnet-4.5", [{ type: "function", name: "save" }], 3)
  return readSse(claudeCanonicalStreamResponse(canonical, { model: "fallback", messages: [], stream: true }, { heartbeatMs: 0 }))
}

function manualCanonicalStream(events: Canonical_Event[]): Canonical_StreamResponse {
  return {
    type: "canonical_stream",
    status: 200,
    id: "resp_manual",
    model: "claude-sonnet-4.5",
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events
      },
    },
  }
}

describe("Kiro Claude SSE compatibility", () => {
  test("emits Claude wire events for message_start, thinking, text, end_turn, and message_stop", async () => {
    const sse = await readClaudeSseFromKiro('{"content":"<thinking>plan</thinking>hello"}{"usage":4}')

    expect(sse[0].event).toBe("message_start")
    expect(sse[0].data.message.id).toMatch(/^msg_/)
    expect(sse[0].data.message.model).toBe("claude-sonnet-4.5")

    const thinkingStart = indexOfEvent(sse, (event) => event.event === "content_block_start" && event.data.content_block?.type === "thinking")
    const thinkingDelta = indexOfEvent(sse, (event, index) => index > thinkingStart && event.event === "content_block_delta" && event.data.delta?.type === "thinking_delta")
    const thinkingSignature = indexOfEvent(sse, (event, index) => index > thinkingDelta && event.event === "content_block_delta" && event.data.delta?.type === "signature_delta")
    const thinkingStop = indexOfEvent(sse, (event, index) => index > thinkingSignature && event.event === "content_block_stop" && event.data.index === sse[thinkingStart].data.index)

    const textStart = indexOfEvent(sse, (event, index) => index > thinkingStop && event.event === "content_block_start" && event.data.content_block?.type === "text")
    const textDelta = indexOfEvent(sse, (event, index) => index > textStart && event.event === "content_block_delta" && event.data.delta?.type === "text_delta" && event.data.delta.text === "hello")
    const textStop = indexOfEvent(sse, (event, index) => index > textDelta && event.event === "content_block_stop" && event.data.index === sse[textStart].data.index)
    const messageDelta = indexOfEvent(sse, (event) => event.event === "message_delta")

    expect(thinkingStart).toBeLessThan(thinkingDelta)
    expect(thinkingDelta).toBeLessThan(thinkingSignature)
    expect(thinkingSignature).toBeLessThan(thinkingStop)
    expect(textStart).toBeLessThan(textDelta)
    expect(textDelta).toBeLessThan(textStop)
    expect(sse[messageDelta].data.delta.stop_reason).toBe("end_turn")
    expect(sse[messageDelta].data.usage.input_tokens).toBe(3)
    expect(sse[messageDelta].data.usage.output_tokens).toBe(4)
    expect(sse.at(-1)?.event).toBe("message_stop")
  })

  test("emits Claude wire events for tool input_json_delta and tool_use stop reason", async () => {
    const sse = await readClaudeSseFromKiro('{"content":"hello"}{"name":"save","toolUseId":"call_1","input":"{\\"ok\\":true}"}{"stop":true}{"usage":7}')

    const textStart = indexOfEvent(sse, (event) => event.event === "content_block_start" && event.data.content_block?.type === "text")
    const textDelta = indexOfEvent(sse, (event, index) => index > textStart && event.event === "content_block_delta" && event.data.delta?.type === "text_delta")
    const textStop = indexOfEvent(sse, (event, index) => index > textDelta && event.event === "content_block_stop" && event.data.index === sse[textStart].data.index)
    const toolStart = indexOfEvent(sse, (event, index) => index > textStop && event.event === "content_block_start" && event.data.content_block?.type === "tool_use")
    const toolEmptyDelta = indexOfEvent(sse, (event, index) => index > toolStart && event.event === "content_block_delta" && event.data.delta?.type === "input_json_delta")
    const toolDelta = indexOfEvent(sse, (event, index) => index > toolEmptyDelta && event.event === "content_block_delta" && event.data.delta?.type === "input_json_delta")
    const toolStop = indexOfEvent(sse, (event, index) => index > toolDelta && event.event === "content_block_stop" && event.data.index === sse[toolStart].data.index)
    const messageDelta = indexOfEvent(sse, (event) => event.event === "message_delta")

    expect(sse[toolStart].data.content_block).toMatchObject({ type: "tool_use", id: "call_1", name: "save" })
    expect(sse[toolEmptyDelta].data.delta.partial_json).toBe("")
    expect(sse[toolDelta].data.delta.partial_json).toBe('{"ok":true}')
    expect(toolStart).toBeLessThan(toolEmptyDelta)
    expect(toolEmptyDelta).toBeLessThan(toolDelta)
    expect(toolDelta).toBeLessThan(toolStop)
    expect(sse[messageDelta].data.delta.stop_reason).toBe("tool_use")
    expect(sse[messageDelta].data.usage.output_tokens).toBe(7)
    expect(sse.at(-1)?.event).toBe("message_stop")
  })

  test("emits Claude cache usage fields from Kiro object usage events", async () => {
    const sse = await readClaudeSseFromKiro('{"content":"hello"}{"usage":{"cacheReadInputTokens":5,"cacheCreationInputTokens":2,"outputTokens":7}}')
    const messageDelta = indexOfEvent(sse, (event) => event.event === "message_delta")

    expect(sse[messageDelta].data.usage).toMatchObject({
      input_tokens: 3,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 5,
      output_tokens: 7,
    })
  })

  test("emits Claude input tokens from Kiro object usage events without falling back to estimates", async () => {
    const sse = await readClaudeSseFromKiro('{"content":"hello"}{"usage":{"input_tokens":11,"cache_read_input_tokens":5,"output_tokens":7}}{"contextUsagePercentage":1}')
    const messageDelta = indexOfEvent(sse, (event) => event.event === "message_delta")

    expect(sse[messageDelta].data.usage).toMatchObject({
      input_tokens: 11,
      cache_read_input_tokens: 5,
      output_tokens: 7,
    })
  })

  test("emits Claude wire events for Kiro web_search server tool blocks before answer text", async () => {
    const canonical = streamKiroResponse(
      response('{"content":"answer"}{"usage":3}'),
      "claude-sonnet-4.5",
      [{ type: "function", name: "web_search" }],
      3,
      undefined,
      [
        { type: "server_tool_use", id: "srvtoolu_search", name: "web_search", input: { query: "https://example.com" } },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_search", content: [{ type: "web_search_result", title: "Example", url: "https://example.com", encrypted_content: "" }] },
      ],
    )
    const sse = await readSse(claudeCanonicalStreamResponse(canonical, { model: "fallback", messages: [], stream: true }, { heartbeatMs: 0 }))

    const serverToolStart = indexOfEvent(sse, (event) => event.event === "content_block_start" && event.data.content_block?.type === "server_tool_use")
    const serverToolEmptyDelta = indexOfEvent(sse, (event, index) => index > serverToolStart && event.event === "content_block_delta" && event.data.delta?.type === "input_json_delta")
    const serverToolDelta = indexOfEvent(sse, (event, index) => index > serverToolEmptyDelta && event.event === "content_block_delta" && event.data.delta?.type === "input_json_delta")
    const resultStart = indexOfEvent(sse, (event, index) => index > serverToolDelta && event.event === "content_block_start" && event.data.content_block?.type === "web_search_tool_result")
    const textStart = indexOfEvent(sse, (event, index) => index > resultStart && event.event === "content_block_start" && event.data.content_block?.type === "text")
    const messageDelta = indexOfEvent(sse, (event) => event.event === "message_delta")

    expect(sse[serverToolStart].data.content_block).toMatchObject({ type: "server_tool_use", id: "srvtoolu_search", name: "web_search", input: {} })
    expect(sse[serverToolEmptyDelta].data.delta.partial_json).toBe("")
    expect(sse[serverToolDelta].data.delta.partial_json).toBe('{"query":"https://example.com"}')
    expect(sse[textStart + 1].data.delta.text).toBe("answer")
    expect(sse[messageDelta].data.usage.server_tool_use).toEqual({ web_search_requests: 1 })
  })

  test("emits Claude wire events for max_tokens stop reason", async () => {
    const sse = await readSse(claudeCanonicalStreamResponse(
      manualCanonicalStream([
        { type: "text_delta", delta: "truncated" },
        { type: "usage", usage: { outputTokens: 9 } },
        { type: "message_stop", stopReason: "max_tokens" },
      ]),
      { model: "fallback", messages: [], stream: true },
      { heartbeatMs: 0 },
    ))

    expect(sse[0].event).toBe("message_start")
    expect(sse[0].data.message.id).toBe("msg_manual")
    expect(sse[0].data.message.model).toBe("claude-sonnet-4.5")
    const messageDelta = indexOfEvent(sse, (event) => event.event === "message_delta")
    expect(sse[messageDelta].data.delta.stop_reason).toBe("max_tokens")
    expect(sse[messageDelta].data.usage.output_tokens).toBe(9)
    expect(sse.at(-1)?.event).toBe("message_stop")
  })
})
