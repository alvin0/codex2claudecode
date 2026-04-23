import { describe, expect, test } from "bun:test"

import type { Canonical_Request } from "../../src/core/canonical"
import { Codex_Upstream_Provider } from "../../src/upstream/codex"
import { canonicalToCodexBody, collectCodexResponse, streamCodexResponse } from "../../src/upstream/codex/parse"
import { sse } from "../helpers"

function canonicalRequest(overrides: Partial<Canonical_Request> = {}): Canonical_Request {
  return {
    model: "gpt-5.4",
    instructions: "Be helpful",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
    ...overrides,
  }
}

describe("canonicalToCodexBody edge cases", () => {
  test("empty input array produces empty input", () => {
    const body = canonicalToCodexBody(canonicalRequest({ input: [] }))
    expect(body.input).toEqual([])
  })

  test("omits optional fields when not provided", () => {
    const body = canonicalToCodexBody(canonicalRequest({
      tools: undefined,
      toolChoice: undefined,
      include: undefined,
      textFormat: undefined,
      reasoningEffort: undefined,
      instructions: undefined,
    }))

    expect(body).not.toHaveProperty("tools")
    expect(body).not.toHaveProperty("tool_choice")
    expect(body).not.toHaveProperty("include")
    expect(body).not.toHaveProperty("text")
    expect(body).not.toHaveProperty("reasoning_effort")
    expect(body).not.toHaveProperty("instructions")
    expect(body.store).toBe(false)
  })

  test("empty string instructions are omitted (falsy)", () => {
    const body = canonicalToCodexBody(canonicalRequest({ instructions: "" }))
    expect(body).not.toHaveProperty("instructions")
  })

  test("raw input items (function_call, function_call_output) are hoisted out of message content", () => {
    const body = canonicalToCodexBody(canonicalRequest({
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "hello" },
          { type: "function_call", call_id: "call_1", name: "save", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "done" },
        ],
      }],
    }))

    const input = body.input as unknown[]
    // Regular content in a message, raw items hoisted
    expect(input).toHaveLength(3)
    expect((input[0] as any).role).toBe("user")
    expect((input[0] as any).content).toHaveLength(1)
    expect((input[1] as any).type).toBe("function_call")
    expect((input[2] as any).type).toBe("function_call_output")
  })

  test("message with only raw items produces no role wrapper", () => {
    const body = canonicalToCodexBody(canonicalRequest({
      input: [{
        role: "assistant",
        content: [
          { type: "function_call", call_id: "call_1", name: "save", arguments: "{}" },
        ],
      }],
    }))

    const input = body.input as unknown[]
    // Only raw item, no role wrapper
    expect(input).toHaveLength(1)
    expect((input[0] as any).type).toBe("function_call")
    expect((input[0] as any).role).toBeUndefined()
  })

  test("empty tools array is included", () => {
    const body = canonicalToCodexBody(canonicalRequest({ tools: [] }))
    expect(body.tools).toEqual([])
  })

  test("model name is passed through as-is (no suffix stripping)", () => {
    const body = canonicalToCodexBody(canonicalRequest({ model: "gpt-5.4_high" }))
    expect(body.model).toBe("gpt-5.4_high")
  })

  test("multiple messages with mixed content", () => {
    const body = canonicalToCodexBody(canonicalRequest({
      input: [
        { role: "user", content: [{ type: "input_text", text: "first" }] },
        { role: "assistant", content: [{ type: "output_text", text: "response" }] },
        { role: "user", content: [{ type: "input_text", text: "second" }] },
      ],
    }))

    const input = body.input as unknown[]
    expect(input).toHaveLength(3)
    expect((input[0] as any).role).toBe("user")
    expect((input[1] as any).role).toBe("assistant")
    expect((input[2] as any).role).toBe("user")
  })
})

describe("collectCodexResponse edge cases", () => {
  test("null response body returns default response", async () => {
    const response = await collectCodexResponse(new Response(null), "fallback-model")

    expect(response.type).toBe("canonical_response")
    expect(response.model).toBe("fallback-model")
    expect(response.content).toEqual([])
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(response.stopReason).toBe("end_turn")
  })

  test("empty SSE stream returns default response", async () => {
    const response = await collectCodexResponse(new Response(""), "fallback-model")

    expect(response.model).toBe("fallback-model")
    expect(response.content).toEqual([])
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  test("malformed SSE data is silently skipped", async () => {
    const response = await collectCodexResponse(
      new Response("event: message\ndata: not-json\n\nevent: message\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":2},\"output\":[]}}\n\n"),
      "fallback",
    )

    expect(response.usage).toEqual({ inputTokens: 1, outputTokens: 2 })
  })

  test("response.completed without output array keeps incremental content", async () => {
    const response = await collectCodexResponse(
      new Response(
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
          { type: "response.output_text.delta", delta: "hello" },
          { type: "response.output_text.done", text: "hello" },
          { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
        ]),
      ),
      "fallback",
    )

    expect(response.content.some((block) => block.type === "text" && block.text === "hello")).toBe(true)
  })

  test("response.completed with empty output array keeps incremental content", async () => {
    const response = await collectCodexResponse(
      new Response(
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
          { type: "response.output_text.delta", delta: "hello" },
          { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 }, output: [] } },
        ]),
      ),
      "fallback",
    )

    // Empty output array means content.length is 0, so incremental content is kept
    expect(response.content.some((block) => block.type === "text")).toBe(true)
  })

  test("response.incomplete sets max_tokens stop reason", async () => {
    const response = await collectCodexResponse(
      new Response(
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
          { type: "response.output_text.delta", delta: "partial" },
          { type: "response.incomplete", response: { usage: { input_tokens: 1, output_tokens: 2 }, incomplete_details: { reason: "max_output_tokens" } } },
        ]),
      ),
      "fallback",
    )

    expect(response.stopReason).toBe("max_tokens")
  })

  test("response.failed does not crash non-streaming collection", async () => {
    const response = await collectCodexResponse(
      new Response(
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
          { type: "response.failed", response: { error: { message: "rate limited" }, usage: { input_tokens: 0, output_tokens: 0 } } },
        ]),
      ),
      "fallback",
    )

    expect(response.model).toBe("gpt-5.4")
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  test("thinking events produce thinking content block (includes lifecycle labels)", async () => {
    const response = await collectCodexResponse(
      new Response(
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
          { type: "response.reasoning_summary_text.delta", delta: "Thinking..." },
          { type: "response.reasoning_summary_text.done", text: "Thinking..." },
          { type: "response.output_text.done", text: "answer" },
          { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 }, output: [{ type: "message", content: [{ type: "output_text", text: "answer" }] }] } },
        ]),
      ),
      "fallback",
    )

    const thinking = response.content.find((block) => block.type === "thinking")
    expect(thinking).toBeDefined()
    // Thinking includes lifecycle label "Initializing…" from response.created + actual thinking text
    expect(thinking!.type === "thinking" && thinking.thinking).toContain("Thinking...")
    expect(thinking!.type === "thinking" && thinking.signature).toMatch(/^sig_/)
  })

  test("function_call without id falls back to fc_ prefix", async () => {
    const response = await collectCodexResponse(
      new Response(
        sse([
          { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "save", arguments: "{}" } },
          { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 }, output: [{ type: "function_call", call_id: "call_1", name: "save", arguments: "{}" }] } },
        ]),
      ),
      "fallback",
    )

    const toolCall = response.content.find((block) => block.type === "tool_call")
    expect(toolCall).toBeDefined()
    if (toolCall?.type === "tool_call") {
      expect(toolCall.id).toBe("fc_call_1")
    }
  })

  test("function_call with missing name defaults to unknown", async () => {
    const response = await collectCodexResponse(
      new Response(
        sse([
          { type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0 }, output: [{ type: "function_call", call_id: "call_1" }] } },
        ]),
      ),
      "fallback",
    )

    const toolCall = response.content.find((block) => block.type === "tool_call")
    expect(toolCall).toBeDefined()
    if (toolCall?.type === "tool_call") {
      expect(toolCall.name).toBe("unknown")
      expect(toolCall.arguments).toBe("{}")
    }
  })

  test("web_search_call output item produces server_tool block", async () => {
    const response = await collectCodexResponse(
      new Response(
        sse([
          {
            type: "response.completed",
            response: {
              usage: { input_tokens: 1, output_tokens: 2 },
              output: [
                { type: "web_search_call", id: "ws_1", action: { type: "search", query: "test" } },
                { type: "message", content: [{ type: "output_text", text: "result" }] },
              ],
            },
          },
        ]),
      ),
      "fallback",
    )

    expect(response.content.some((block) => block.type === "server_tool")).toBe(true)
    expect(response.usage.serverToolUse?.webSearchRequests).toBe(1)
  })

  test("mcp_call output item produces server_tool block with mcp_tool_use and mcp_tool_result", async () => {
    const response = await collectCodexResponse(
      new Response(
        sse([
          {
            type: "response.completed",
            response: {
              usage: { input_tokens: 1, output_tokens: 2 },
              output: [
                { type: "mcp_call", id: "mcp_1", name: "get_data", server_label: "my-server", arguments: "{\"key\":\"value\"}", output: "result text", status: "completed" },
              ],
            },
          },
        ]),
      ),
      "fallback",
    )

    const serverTool = response.content.find((block) => block.type === "server_tool")
    expect(serverTool).toBeDefined()
    if (serverTool?.type === "server_tool") {
      expect(serverTool.blocks.some((b) => b.type === "mcp_tool_use")).toBe(true)
      expect(serverTool.blocks.some((b) => b.type === "mcp_tool_result")).toBe(true)
    }
    expect(response.usage.serverToolUse?.mcpCalls).toBe(1)
  })

  test("deferred text after pending server calls is appended on finalize", async () => {
    const response = await collectCodexResponse(
      new Response(
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
          // Server tool without immediate result → becomes pending
          { type: "response.output_item.done", item: { type: "web_search_call", id: "ws_1", action: { type: "search", query: "test" } } },
          // Text arrives while server call is pending → deferred
          { type: "response.output_text.delta", delta: "deferred text" },
          // Completed with output overrides everything
          {
            type: "response.completed",
            response: {
              usage: { input_tokens: 1, output_tokens: 2 },
              output: [
                { type: "web_search_call", id: "ws_1", action: { type: "search", query: "test" } },
                { type: "message", content: [{ type: "output_text", text: "deferred text" }] },
              ],
            },
          },
        ]),
      ),
      "fallback",
    )

    expect(response.content.some((block) => block.type === "text" && block.text === "deferred text")).toBe(true)
  })
})

describe("streamCodexResponse edge cases", () => {
  test("null body stream yields no events", async () => {
    const stream = streamCodexResponse(new Response(null), "fallback")

    expect(stream.type).toBe("canonical_stream")
    const events = []
    for await (const event of stream.events) events.push(event)
    expect(events).toEqual([])
  })

  test("stream emits lifecycle events for unknown response.* types", async () => {
    const stream = streamCodexResponse(
      new Response(
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
          { type: "response.some_unknown_event" },
          { type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0 }, output: [] } },
        ]),
      ),
      "fallback",
    )

    const events = []
    for await (const event of stream.events) events.push(event)

    expect(events.some((e) => e.type === "lifecycle" && (e as any).label === "response.some_unknown_event")).toBe(true)
  })

  test("stream emits error event on response.failed", async () => {
    const stream = streamCodexResponse(
      new Response(
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
          { type: "response.failed", response: { error: { message: "rate limited" }, usage: { input_tokens: 0, output_tokens: 0 } } },
        ]),
      ),
      "fallback",
    )

    const events = []
    for await (const event of stream.events) events.push(event)

    expect(events.some((e) => e.type === "error" && (e as any).message === "rate limited")).toBe(true)
  })

  test("stream emits message_stop with max_tokens on response.incomplete", async () => {
    const stream = streamCodexResponse(
      new Response(
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
          { type: "response.output_text.delta", delta: "partial" },
          { type: "response.incomplete", response: { usage: { input_tokens: 1, output_tokens: 2 }, incomplete_details: { reason: "max_output_tokens" } } },
        ]),
      ),
      "fallback",
    )

    const events = []
    for await (const event of stream.events) events.push(event)

    expect(events.some((e) => e.type === "message_stop" && (e as any).stopReason === "max_tokens")).toBe(true)
  })

  test("function_call_arguments events with proper item fields emit tool_call events", async () => {
    const stream = streamCodexResponse(
      new Response(
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
          { type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", name: "save" } },
          { type: "response.function_call_arguments.delta", delta: "{\"ok\":", item: { call_id: "call_1", name: "save" } },
          { type: "response.function_call_arguments.done", item: { call_id: "call_1", name: "save", arguments: "{\"ok\":true}" } },
          { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{\"ok\":true}" } },
          { type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0 }, output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{\"ok\":true}" }] } },
        ]),
      ),
      "fallback",
    )

    const events = []
    for await (const event of stream.events) events.push(event)

    // function_call_arguments.delta is in UPSTREAM_THINKING_EVENTS, so it's consumed as a lifecycle/thinking event
    // The actual tool_call_done comes from response.output_item.done
    const done = events.find((e) => e.type === "tool_call_done")
    expect(done).toBeDefined()
    if (done?.type === "tool_call_done") {
      expect(done.callId).toBe("call_1")
      expect(done.name).toBe("save")
      expect(done.arguments).toBe("{\"ok\":true}")
    }
  })

  test("thinking then text produces correct block ordering", async () => {
    const stream = streamCodexResponse(
      new Response(
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
          { type: "response.reasoning_summary_text.delta", delta: "Thinking" },
          { type: "response.output_text.delta", delta: "Answer" },
          { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 }, output: [{ type: "message", content: [{ type: "output_text", text: "Answer" }] }] } },
        ]),
      ),
      "fallback",
    )

    const events = []
    for await (const event of stream.events) events.push(event)

    const types = events.map((e) => e.type)
    const thinkingStart = types.indexOf("content_block_start")
    const thinkingStop = types.indexOf("content_block_stop")
    const textStart = types.indexOf("content_block_start", thinkingStart + 1)

    expect(thinkingStart).toBeLessThan(thinkingStop)
    expect(thinkingStop).toBeLessThan(textStart)
  })
})

describe("Codex_Upstream_Provider edge cases", () => {
  test("upstream proxy exception is propagated", async () => {
    const provider = new Codex_Upstream_Provider({
      accessToken: "access",
      refreshToken: "refresh",
      fetch: (() => Promise.reject(new Error("network down"))) as typeof fetch,
    })

    await expect(provider.proxy(canonicalRequest())).rejects.toThrow("network down")
  })

  test("non-streaming non-passthrough returns canonical_response", async () => {
    const provider = new Codex_Upstream_Provider({
      accessToken: "access",
      refreshToken: "refresh",
      fetch: (() =>
        Promise.resolve(
          new Response(
            sse([
              { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 }, output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] } },
            ]),
          ),
        )) as typeof fetch,
    })

    const result = await provider.proxy(canonicalRequest({ stream: false, passthrough: false }))
    expect(result.type).toBe("canonical_response")
    if (result.type === "canonical_response") {
      expect(result.content.some((b) => b.type === "text" && b.text === "hi")).toBe(true)
    }
  })

  test("streaming non-passthrough returns canonical_stream", async () => {
    const provider = new Codex_Upstream_Provider({
      accessToken: "access",
      refreshToken: "refresh",
      fetch: (() =>
        Promise.resolve(
          new Response(
            sse([
              { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
              { type: "response.output_text.delta", delta: "hi" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 }, output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] } },
            ]),
          ),
        )) as typeof fetch,
    })

    const result = await provider.proxy(canonicalRequest({ stream: true, passthrough: false }))
    expect(result.type).toBe("canonical_stream")
  })

  test("error response body is captured in canonical_error", async () => {
    const provider = new Codex_Upstream_Provider({
      accessToken: "access",
      refreshToken: "refresh",
      fetch: (() => Promise.resolve(new Response('{"error":"rate_limited"}', { status: 429 }))) as typeof fetch,
    })

    const result = await provider.proxy(canonicalRequest())
    expect(result.type).toBe("canonical_error")
    if (result.type === "canonical_error") {
      expect(result.status).toBe(429)
      expect(result.body).toBe('{"error":"rate_limited"}')
    }
  })

  test("checkHealth delegates to client", async () => {
    const provider = new Codex_Upstream_Provider({
      accessToken: "access",
      refreshToken: "refresh",
      fetch: ((url: string, init: any) => {
        if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 405 }))
        return Promise.resolve(new Response("ok"))
      }) as typeof fetch,
    })

    const health = await provider.checkHealth(5000)
    expect(health.ok).toBe(true)
  })
})
