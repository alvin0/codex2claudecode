import { describe, expect, test } from "bun:test"

import type {
  Canonical_ContentBlock,
  Canonical_ErrorResponse,
  Canonical_Event,
  Canonical_InputMessage,
  Canonical_PassthroughResponse,
  Canonical_Request,
  Canonical_Response,
  Canonical_StreamResponse,
  Canonical_Usage,
} from "../../src/core/canonical"

describe("canonical types", () => {
  test("constructs every canonical type variant", async () => {
    const input: Canonical_InputMessage = {
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    }
    const usage: Canonical_Usage = {
      inputTokens: 10,
      outputTokens: 20,
      serverToolUse: {
        webSearchRequests: 1,
        webFetchRequests: 2,
        mcpCalls: 3,
      },
    }
    const content: Canonical_ContentBlock[] = [
      { type: "text", text: "hello" },
      { type: "tool_call", id: "fc_1", callId: "call_1", name: "tool", arguments: "{\"ok\":true}" },
      { type: "server_tool", blocks: [{ type: "server_tool_use", id: "srv_1" }] },
      { type: "thinking", thinking: "Considering", signature: "sig_1" },
    ]
    const request: Canonical_Request = {
      model: "gpt-5.4",
      instructions: "Be helpful",
      input: [input],
      tools: [{ type: "function", name: "tool" }],
      toolChoice: "auto",
      include: ["web_search_call.action.sources"],
      textFormat: { type: "json_schema" },
      reasoningEffort: "high",
      stream: true,
      passthrough: false,
      metadata: { source: "claude" },
    }
    const response: Canonical_Response = {
      type: "canonical_response",
      id: "resp_1",
      model: "gpt-5.4",
      stopReason: "end_turn",
      content,
      usage,
    }
    const events: Canonical_Event[] = [
      { type: "message_start", id: response.id, model: response.model },
      { type: "content_block_start", blockType: "text", index: 0, block: { type: "text" } },
      { type: "text_delta", delta: "hel" },
      { type: "text_done", text: "hello" },
      { type: "tool_call_delta", callId: "call_1", name: "tool", argumentsDelta: "{\"ok\":" },
      { type: "tool_call_done", callId: "call_1", name: "tool", arguments: "{\"ok\":true}" },
      { type: "server_tool_block", blocks: [{ type: "server_tool_use" }] },
      { type: "thinking_delta", label: "Thinking", text: "Considering" },
      { type: "thinking_signature", signature: "sig_1" },
      { type: "usage", usage: usage.serverToolUse ?? {} },
      { type: "message_item_done", item: { type: "message" } },
      { type: "content_block_stop", index: 0 },
      { type: "lifecycle", label: "Queued" },
      { type: "completion", output: response.content, usage, stopReason: response.stopReason },
      { type: "message_stop", stopReason: response.stopReason },
      { type: "error", message: "boom" },
    ]
    const stream: Canonical_StreamResponse = {
      type: "canonical_stream",
      status: 200,
      id: response.id,
      model: response.model,
      events: {
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event
        },
      },
    }
    const error: Canonical_ErrorResponse = {
      type: "canonical_error",
      status: 418,
      headers: new Headers({ "content-type": "application/json" }),
      body: "{\"error\":true}",
    }
    const passthrough: Canonical_PassthroughResponse = {
      type: "canonical_passthrough",
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: "raw",
    }

    expect(request.model).toBe("gpt-5.4")
    expect(response.content).toHaveLength(4)
    expect(error.status).toBe(418)
    expect(passthrough.statusText).toBe("OK")

    const collected: Canonical_Event[] = []
    for await (const event of stream.events) collected.push(event)
    expect(collected.map((event) => event.type)).toContain("completion")
  })

  test("canonical request avoids format-specific fields", () => {
    const request: Canonical_Request = {
      model: "gpt-5.4",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      passthrough: false,
      metadata: {},
    }

    expect("anthropic-version" in request).toBe(false)
    expect("store" in request).toBe(false)
    expect("messages" in request).toBe(false)
    expect("response_format" in request).toBe(false)
  })
})
