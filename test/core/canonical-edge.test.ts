import { describe, expect, test } from "bun:test"

import type {
  Canonical_ContentBlock,
  Canonical_ErrorResponse,
  Canonical_Event,
  Canonical_PassthroughResponse,
  Canonical_Request,
  Canonical_Response,
  Canonical_StreamResponse,
} from "../../src/core/canonical"

describe("Canonical type structural edge cases", () => {
  test("Canonical_Request with all optional fields undefined", () => {
    const request: Canonical_Request = {
      model: "gpt-5.4",
      input: [],
      stream: false,
      passthrough: false,
      metadata: {},
    }

    expect(request.instructions).toBeUndefined()
    expect(request.tools).toBeUndefined()
    expect(request.toolChoice).toBeUndefined()
    expect(request.include).toBeUndefined()
    expect(request.textFormat).toBeUndefined()
    expect(request.reasoningEffort).toBeUndefined()
  })

  test("Canonical_Request with all optional fields populated", () => {
    const request: Canonical_Request = {
      model: "gpt-5.4",
      instructions: "Be helpful",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [{ type: "function", name: "save" }],
      toolChoice: "auto",
      include: ["web_search_call.action.sources"],
      textFormat: { type: "json_schema" },
      reasoningEffort: "high",
      stream: true,
      passthrough: false,
      metadata: { source: "test" },
    }

    expect(request.model).toBe("gpt-5.4")
    expect(request.tools).toHaveLength(1)
    expect(request.metadata.source).toBe("test")
  })

  test("Canonical_InputMessage supports all roles", () => {
    const messages: Canonical_Request["input"] = [
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      { role: "tool", content: [{ type: "function_call_output", output: "result" }] },
    ]

    expect(messages).toHaveLength(3)
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
  })

  test("Canonical_Response with empty content", () => {
    const response: Canonical_Response = {
      type: "canonical_response",
      id: "resp_1",
      model: "gpt-5.4",
      stopReason: "end_turn",
      content: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    }

    expect(response.content).toEqual([])
    expect(response.usage.serverToolUse).toBeUndefined()
  })

  test("Canonical_Response with all content block types", () => {
    const content: Canonical_ContentBlock[] = [
      { type: "text", text: "hello", annotations: [{ url: "https://example.com" }] },
      { type: "tool_call", id: "fc_1", callId: "call_1", name: "save", arguments: "{}" },
      { type: "server_tool", blocks: [{ type: "web_search_tool_result" }] },
      { type: "thinking", thinking: "Working", signature: "sig_1" },
    ]

    expect(content).toHaveLength(4)
    expect(content.map((b) => b.type)).toEqual(["text", "tool_call", "server_tool", "thinking"])
  })

  test("Canonical_Usage with serverToolUse", () => {
    const response: Canonical_Response = {
      type: "canonical_response",
      id: "resp_1",
      model: "gpt-5.4",
      stopReason: "end_turn",
      content: [],
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        serverToolUse: {
          webSearchRequests: 3,
          webFetchRequests: 1,
          mcpCalls: 2,
        },
      },
    }

    expect(response.usage.serverToolUse?.webSearchRequests).toBe(3)
    expect(response.usage.serverToolUse?.webFetchRequests).toBe(1)
    expect(response.usage.serverToolUse?.mcpCalls).toBe(2)
  })

  test("Canonical_ErrorResponse structure", () => {
    const error: Canonical_ErrorResponse = {
      type: "canonical_error",
      status: 429,
      headers: new Headers({ "retry-after": "30" }),
      body: '{"error":"rate_limited"}',
    }

    expect(error.type).toBe("canonical_error")
    expect(error.status).toBe(429)
    expect(error.headers.get("retry-after")).toBe("30")
  })

  test("Canonical_PassthroughResponse with null body", () => {
    const passthrough: Canonical_PassthroughResponse = {
      type: "canonical_passthrough",
      status: 204,
      statusText: "No Content",
      headers: new Headers(),
      body: null,
    }

    expect(passthrough.body).toBeNull()
  })

  test("Canonical_PassthroughResponse with string body", () => {
    const passthrough: Canonical_PassthroughResponse = {
      type: "canonical_passthrough",
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      body: "raw text",
    }

    expect(passthrough.body).toBe("raw text")
  })

  test("Canonical_StreamResponse structure", () => {
    const stream: Canonical_StreamResponse = {
      type: "canonical_stream",
      status: 200,
      id: "resp_1",
      model: "gpt-5.4",
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "message_start", id: "resp_1", model: "gpt-5.4" }
        },
      },
    }

    expect(stream.type).toBe("canonical_stream")
    expect(stream.status).toBe(200)
  })

  test("all Canonical_Event types are constructable", () => {
    const events: Canonical_Event[] = [
      { type: "text_delta", delta: "hello" },
      { type: "text_done", text: "hello world" },
      { type: "tool_call_delta", callId: "call_1", name: "save", argumentsDelta: "{" },
      { type: "tool_call_done", callId: "call_1", name: "save", arguments: "{}" },
      { type: "server_tool_block", blocks: [{ type: "web_search_tool_result" }] },
      { type: "thinking_delta", text: "Working" },
      { type: "thinking_delta", label: "Reasoning…" },
      { type: "thinking_signature", signature: "sig_1" },
      { type: "usage", usage: { inputTokens: 1 } },
      { type: "content_block_start", blockType: "text", index: 0 },
      { type: "content_block_start", blockType: "text", index: 0, block: { type: "text" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_start", id: "resp_1", model: "gpt-5.4" },
      { type: "message_stop", stopReason: "end_turn" },
      { type: "error", message: "something went wrong" },
      { type: "completion", output: [], usage: { inputTokens: 1, outputTokens: 2 }, stopReason: "end_turn" },
      { type: "completion" },
      { type: "lifecycle", label: "Processing…" },
      { type: "message_item_done", item: { type: "message" } },
    ]

    expect(events).toHaveLength(19)
    const types = new Set(events.map((e) => e.type))
    expect(types.size).toBe(16) // some types appear multiple times
  })
})
