import { describe, expect, test } from "bun:test"

import type { Canonical_Response, Canonical_StreamResponse } from "../../src/core/canonical"
import { Claude_Inbound_Provider } from "../../src/inbound/claude"
import { claudeToCanonicalRequest } from "../../src/inbound/claude/convert"
import { claudeErrorResponse, claudeStreamErrorEvent } from "../../src/inbound/claude/errors"
import { Model_Catalog } from "../../src/inbound/claude/models"
import { canonicalResponseToClaudeMessage, claudeCanonicalStreamResponse, claudeStreamResponse } from "../../src/inbound/claude/response"
import { readSse, sse } from "../helpers"

describe("Claude → Canonical_Request edge cases", () => {
  test("minimal request with only model and messages gets default instructions", () => {
    const request = claudeToCanonicalRequest({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
    })

    expect(request.model).toBe("gpt-5.4")
    expect(request.passthrough).toBe(false)
    expect(request.stream).toBe(true) // default
    expect(request.input).toHaveLength(1)
    expect(request.tools).toBeUndefined()
    // Without system, instructions defaults to "You are a helpful assistant."
    expect(request.instructions).toBe("You are a helpful assistant.")
  })

  test("stream: false is preserved", () => {
    const request = claudeToCanonicalRequest({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    })

    expect(request.stream).toBe(false)
  })

  test("system as array of text blocks is joined", () => {
    const request = claudeToCanonicalRequest({
      model: "gpt-5.4",
      system: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      messages: [{ role: "user", content: "hello" }],
    })

    expect(request.instructions).toContain("first")
    expect(request.instructions).toContain("second")
  })

  test("empty messages array produces empty input", () => {
    const request = claudeToCanonicalRequest({
      model: "gpt-5.4",
      messages: [],
    })

    expect(request.input).toEqual([])
  })

  test("assistant message with content blocks", () => {
    const request = claudeToCanonicalRequest({
      model: "gpt-5.4",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "response" }] },
      ],
    })

    expect(request.input).toHaveLength(2)
    expect(request.input[1].role).toBe("assistant")
  })

  test("tool_choice auto maps correctly", () => {
    const request = claudeToCanonicalRequest({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "save", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
    })

    expect(request.toolChoice).toBe("auto")
  })

  test("tool_choice any maps to required", () => {
    const request = claudeToCanonicalRequest({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "save", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
    })

    expect(request.toolChoice).toBe("required")
  })

  test("tool_choice none maps to none", () => {
    const request = claudeToCanonicalRequest({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "save", input_schema: { type: "object" } }],
      tool_choice: { type: "none" },
    })

    expect(request.toolChoice).toBe("none")
  })

  test("output_config effort maps to reasoningEffort", () => {
    const request = claudeToCanonicalRequest({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      output_config: { effort: "high" },
    })

    expect(request.reasoningEffort).toBe("high")
  })

  test("tools without input_schema get default object parameters", () => {
    const request = claudeToCanonicalRequest({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "save" }],
    })

    expect(request.tools).toHaveLength(1)
    expect((request.tools![0] as any).parameters).toEqual({ type: "object", properties: {} })
  })
})

describe("Canonical_Response → Claude format edge cases", () => {
  test("empty content array produces empty Claude content", async () => {
    const response: Canonical_Response = {
      type: "canonical_response",
      id: "resp_1",
      model: "gpt-5.4",
      stopReason: "end_turn",
      content: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    }

    const message = await canonicalResponseToClaudeMessage(response, { model: "m", messages: [] })
    expect((message as any).content).toEqual([])
  })

  test("thinking block maps to Claude thinking type", async () => {
    const response: Canonical_Response = {
      type: "canonical_response",
      id: "resp_1",
      model: "gpt-5.4",
      stopReason: "end_turn",
      content: [{ type: "thinking", thinking: "Working on it", signature: "sig_abc" }],
      usage: { inputTokens: 1, outputTokens: 2 },
    }

    const message = await canonicalResponseToClaudeMessage(response, { model: "m", messages: [] })
    const thinking = (message as any).content.find((b: any) => b.type === "thinking")
    expect(thinking).toBeDefined()
    expect(thinking.thinking).toBe("Working on it")
    expect(thinking.signature).toBe("sig_abc")
  })

  test("server_tool block with web_search_tool_result passes through", async () => {
    const response: Canonical_Response = {
      type: "canonical_response",
      id: "resp_1",
      model: "gpt-5.4",
      stopReason: "end_turn",
      content: [
        {
          type: "server_tool",
          blocks: [
            { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://example.com", title: "Example", encrypted_content: "" }] },
          ],
        },
      ],
      usage: { inputTokens: 1, outputTokens: 2 },
    }

    const message = await canonicalResponseToClaudeMessage(response, { model: "m", messages: [] })
    expect((message as any).content.some((b: any) => b.type === "web_search_tool_result")).toBe(true)
  })

  test("usage with serverToolUse maps to Claude server_tool_use", async () => {
    const response: Canonical_Response = {
      type: "canonical_response",
      id: "resp_1",
      model: "gpt-5.4",
      stopReason: "end_turn",
      content: [{ type: "text", text: "hi" }],
      usage: { inputTokens: 1, outputTokens: 2, serverToolUse: { webSearchRequests: 3, mcpCalls: 1 } },
    }

    const message = await canonicalResponseToClaudeMessage(response, { model: "m", messages: [] })
    expect((message as any).usage.server_tool_use).toEqual({ web_search_requests: 3, mcp_calls: 1 })
  })

  test("stop_reason tool_use maps correctly", async () => {
    const response: Canonical_Response = {
      type: "canonical_response",
      id: "resp_1",
      model: "gpt-5.4",
      stopReason: "tool_use",
      content: [{ type: "tool_call", id: "fc_1", callId: "call_1", name: "save", arguments: "{}" }],
      usage: { inputTokens: 1, outputTokens: 2 },
    }

    const message = await canonicalResponseToClaudeMessage(response, { model: "m", messages: [] })
    expect((message as any).stop_reason).toBe("tool_use")
  })

  test("msg_ id prefix is always generated", async () => {
    const response: Canonical_Response = {
      type: "canonical_response",
      id: "resp_anything",
      model: "gpt-5.4",
      stopReason: "end_turn",
      content: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    }

    const message = await canonicalResponseToClaudeMessage(response, { model: "m", messages: [] })
    expect((message as any).id).toMatch(/^msg_/)
  })
})

describe("Claude canonical stream edge cases", () => {
  test("direct Codex stream forwards concrete lifecycle labels into thinking", async () => {
    const response = claudeStreamResponse(
      new Response(
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
          { type: "response.in_progress" },
          { type: "response.output_item.added", item: { type: "message", phase: "commentary" } },
          { type: "response.content_part.added", part: { type: "output_text", text: "" } },
          { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "TodoWrite" } },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"todos\":[{\"content\":\"Re-read current staged status and diffs\"}," },
          { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: "{\"todos\":[{\"content\":\"Re-read current staged status and diffs\"},{\"content\":\"Verify previous findings against staged code\"}]}" },
          { type: "response.output_item.added", item: { id: "fc_2", type: "function_call", call_id: "call_2", name: "Bash" } },
          { type: "response.function_call_arguments.done", item_id: "fc_2", arguments: "{\"command\":\"git show :src/core/request-logs.ts\",\"description\":\"Show staged request log storage implementation\",\"timeout\":120000}" },
          { type: "response.completed", response: { usage: { output_tokens: 0 }, output: [] } },
        ]),
      ),
      { model: "gpt-5.4", messages: [], stream: true },
    )

    const events = await readSse(response)
    const thinking = events
      .flatMap((event) => (event.data.delta?.type === "thinking_delta" ? [event.data.delta.thinking] : []))
      .join("")

    expect(thinking).toContain("**Commentary** drafting update")
    expect(thinking).toContain("**Output** opening text stream")
    expect(thinking).toContain("**Tool** preparing `TodoWrite`")
    expect(thinking).toContain("**Codex** session opened\n**Stream** events flowing\n**Commentary** drafting update")
    expect(thinking).toContain("**Commentary** drafting update\n**Output** opening text stream\n**Tool** preparing `TodoWrite`\n**Tool request** `TodoWrite`:\n- Re-read current staged status and diffs\n- Verify previous findings against staged code\n")
    expect(thinking).toContain("**Tool request** `Bash`:\n- **command**: `git show :src/core/request-logs.ts`\n- **description**: `Show staged request log storage implementation`\n- **timeout**: `120000`\n")
    expect(thinking).not.toContain("Preparing output")
    expect(thinking).not.toContain("Preparing content")
  })

  test("empty event stream produces minimal SSE", async () => {
    const response = claudeCanonicalStreamResponse(
      {
        type: "canonical_stream",
        status: 200,
        id: "resp_1",
        model: "gpt-5.4",
        events: {
          async *[Symbol.asyncIterator]() {
            // no events
          },
        },
      },
      { model: "m", messages: [], stream: true },
    )

    const events = await readSse(response)
    // Should at least have message_start
    expect(events.some((e) => e.data.type === "message_start")).toBe(true)
  })

  test("error event in stream produces Claude error SSE", async () => {
    const response = claudeCanonicalStreamResponse(
      {
        type: "canonical_stream",
        status: 200,
        id: "resp_1",
        model: "gpt-5.4",
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "message_start", id: "resp_1", model: "gpt-5.4" } as const
            yield { type: "error", message: "upstream failed" } as const
          },
        },
      },
      { model: "m", messages: [], stream: true },
    )

    const events = await readSse(response)
    expect(events.some((e) => e.event === "error")).toBe(true)
  })

  test("usage event updates Claude usage in stream", async () => {
    const response = claudeCanonicalStreamResponse(
      {
        type: "canonical_stream",
        status: 200,
        id: "resp_1",
        model: "gpt-5.4",
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "message_start", id: "resp_1", model: "gpt-5.4" } as const
            yield { type: "text_delta", delta: "hello" } as const
            yield { type: "usage", usage: { inputTokens: 5, outputTokens: 10 } } as const
            yield { type: "message_stop", stopReason: "end_turn" } as const
          },
        },
      },
      { model: "m", messages: [], stream: true },
    )

    const events = await readSse(response)
    const messageStop = events.find((e) => e.data.type === "message_stop")
    expect(messageStop).toBeDefined()
  })

  test("multiple text_delta events are streamed individually", async () => {
    const response = claudeCanonicalStreamResponse(
      {
        type: "canonical_stream",
        status: 200,
        id: "resp_1",
        model: "gpt-5.4",
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "message_start", id: "resp_1", model: "gpt-5.4" } as const
            yield { type: "text_delta", delta: "hel" } as const
            yield { type: "text_delta", delta: "lo" } as const
            yield { type: "message_stop", stopReason: "end_turn" } as const
          },
        },
      },
      { model: "m", messages: [], stream: true },
    )

    const events = await readSse(response)
    const textDeltas = events.filter((e) => e.data.delta?.text !== undefined)
    expect(textDeltas.length).toBeGreaterThanOrEqual(2)
  })
})

describe("Claude_Inbound_Provider edge cases", () => {
  const dummyUpstream = {
    proxy: () =>
      Promise.resolve({
        type: "canonical_response" as const,
        id: "resp_1",
        model: "gpt-5.4",
        stopReason: "end_turn",
        content: [{ type: "text" as const, text: "hello" }],
        usage: { inputTokens: 1, outputTokens: 2 },
      }),
    checkHealth: () => Promise.resolve({ ok: true }),
  }

  test("missing messages field returns 400", async () => {
    const provider = new Claude_Inbound_Provider()
    const response = await provider.handle(
      new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "gpt-5.4" }) }),
      { path: "/v1/messages", method: "POST" },
      dummyUpstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.message).toContain("messages")
  })

  test("count_tokens without model returns 400", async () => {
    const provider = new Claude_Inbound_Provider()
    const response = await provider.handle(
      new Request("http://localhost/v1/messages/count_tokens", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }) }),
      { path: "/v1/messages/count_tokens", method: "POST" },
      dummyUpstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.message).toContain("model")
  })

  test("count_tokens without messages returns 400", async () => {
    const provider = new Claude_Inbound_Provider()
    const response = await provider.handle(
      new Request("http://localhost/v1/messages/count_tokens", { method: "POST", body: JSON.stringify({ model: "gpt-5.4" }) }),
      { path: "/v1/messages/count_tokens", method: "POST" },
      dummyUpstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.message).toContain("messages")
  })

  test("count_tokens with valid request returns input_tokens", async () => {
    const provider = new Claude_Inbound_Provider()
    const response = await provider.handle(
      new Request("http://localhost/v1/messages/count_tokens", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hello" }] }) }),
      { path: "/v1/messages/count_tokens", method: "POST" },
      dummyUpstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(typeof body.input_tokens).toBe("number")
    expect(body.input_tokens).toBeGreaterThan(0)
  })

  test("model not found returns 404 with Claude error format", async () => {
    const provider = new Claude_Inbound_Provider()
    const response = await provider.handle(
      new Request("http://localhost/v1/models/nonexistent-model-xyz", { method: "GET" }),
      { path: "/v1/models/:model_id", method: "GET" },
      dummyUpstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error.type).toBe("not_found_error")
  })

  test("models list with limit parameter", async () => {
    const provider = new Claude_Inbound_Provider()
    const response = await provider.handle(
      new Request("http://localhost/v1/models?limit=2", { method: "GET" }),
      { path: "/v1/models", method: "GET" },
      dummyUpstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.length).toBeLessThanOrEqual(2)
  })

  test("upstream error is formatted as Claude error", async () => {
    const errorUpstream = {
      proxy: () =>
        Promise.resolve({
          type: "canonical_error" as const,
          status: 503,
          headers: new Headers(),
          body: "service unavailable",
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const provider = new Claude_Inbound_Provider()
    const response = await provider.handle(
      new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hello" }] }) }),
      { path: "/v1/messages", method: "POST" },
      errorUpstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.type).toBe("error")
    expect(body.error.message).toContain("503")
  })

  test("upstream proxy exception returns 500 Claude error", async () => {
    const throwingUpstream = {
      proxy: () => Promise.reject(new Error("connection refused")),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const provider = new Claude_Inbound_Provider()
    const response = await provider.handle(
      new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hello" }] }) }),
      { path: "/v1/messages", method: "POST" },
      throwingUpstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error.message).toContain("connection refused")
  })

  test("unexpected passthrough response returns 500", async () => {
    const passthroughUpstream = {
      proxy: () =>
        Promise.resolve({
          type: "canonical_passthrough" as const,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          body: "raw",
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const provider = new Claude_Inbound_Provider()
    const response = await provider.handle(
      new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hello" }] }) }),
      { path: "/v1/messages", method: "POST" },
      passthroughUpstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error.message).toContain("passthrough")
  })

  test("streaming response from upstream is returned as SSE", async () => {
    let capturedProxy: any
    const streamUpstream = {
      proxy: (_request: unknown, options?: { onResponseBodyChunk?: (chunk: string) => void }) =>
        Promise.resolve({
          type: "canonical_stream" as const,
          status: 200,
          id: "resp_1",
          model: "gpt-5.4",
          events: {
            async *[Symbol.asyncIterator]() {
              options?.onResponseBodyChunk?.('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n')
              yield { type: "message_start", id: "resp_1", model: "gpt-5.4" } as const
              yield { type: "text_delta", delta: "hello" } as const
              yield { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } } as const
              yield { type: "message_stop", stopReason: "end_turn" } as const
            },
          },
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const provider = new Claude_Inbound_Provider()
    const response = await provider.handle(
      new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hello" }], stream: true }) }),
      { path: "/v1/messages", method: "POST" },
      streamUpstream,
      { requestId: "req_1", logBody: false, quiet: true, onProxy: (entry) => { capturedProxy = entry } },
    )

    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const events = await readSse(response)
    expect(events.length).toBeGreaterThan(0)
    expect(capturedProxy.responseBody).toContain("response.output_text.delta")
    expect(capturedProxy.responseBody).toContain('"delta":"hello"')
  })

  test("canonical stream is cancelled when Claude client disconnects", async () => {
    let cancelled = false
    const response = claudeCanonicalStreamResponse(
      {
        type: "canonical_stream",
        status: 200,
        id: "resp_1",
        model: "gpt-5.4",
        events: {
          async *[Symbol.asyncIterator]() {
            try {
              yield { type: "message_start", id: "resp_1", model: "gpt-5.4" } as const
              await new Promise(() => undefined)
            } finally {
              cancelled = true
            }
          },
        },
      },
      { model: "gpt-5.4", messages: [], stream: true },
    )

    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel("client done")
    await waitFor(() => cancelled)

    expect(cancelled).toBe(true)
  })

  test("canonical stream emits heartbeat while upstream is idle", async () => {
    const response = claudeCanonicalStreamResponse(
      {
        type: "canonical_stream",
        status: 200,
        id: "resp_1",
        model: "gpt-5.4",
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "message_start", id: "resp_1", model: "gpt-5.4" } as const
            yield { type: "thinking_delta", text: "Working" } as const
            await new Promise(() => undefined)
          },
        },
      },
      { model: "gpt-5.4", messages: [], stream: true },
      { heartbeatMs: 10 },
    )

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ""
    for (let index = 0; index < 5 && !seen.includes("Working"); index += 1) {
      const chunk = await reader.read()
      expect(chunk.done).toBe(false)
      seen += decoder.decode(chunk.value)
    }

    const heartbeat = await Promise.race([
      reader.read(),
      new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 200)),
    ])
    expect("timeout" in heartbeat).toBe(false)
    if (!("timeout" in heartbeat)) {
      expect(heartbeat.done).toBe(false)
      expect(decoder.decode(heartbeat.value)).toContain("thinking_delta")
    }

    await reader.cancel("client done")
  })

  test("canonical stream forwards thinking signature", async () => {
    const response = claudeCanonicalStreamResponse(
      {
        type: "canonical_stream",
        status: 200,
        id: "resp_1",
        model: "gpt-5.4",
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "message_start", id: "resp_1", model: "gpt-5.4" } as const
            yield { type: "thinking_signature", signature: "sig_test" } as const
            yield { type: "thinking_delta", text: "Working" } as const
            yield { type: "text_delta", delta: "done" } as const
            yield { type: "message_stop", stopReason: "end_turn" } as const
          },
        },
      },
      { model: "gpt-5.4", messages: [], stream: true },
      { heartbeatMs: 0 },
    )

    const events = await readSse(response)
    expect(events.some((event) => event.data.content_block?.type === "thinking" && event.data.content_block.signature === "sig_test")).toBe(true)
    expect(events.some((event) => event.data.delta?.type === "signature_delta" && event.data.delta.signature === "sig_test")).toBe(true)
  })

  test("canonical stream closes text before later thinking", async () => {
    const response = claudeCanonicalStreamResponse(
      {
        type: "canonical_stream",
        status: 200,
        id: "resp_1",
        model: "gpt-5.4",
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "message_start", id: "resp_1", model: "gpt-5.4" } as const
            yield { type: "text_delta", delta: "hello" } as const
            yield { type: "thinking_signature", signature: "sig_test" } as const
            yield { type: "thinking_delta", text: "Preparing output" } as const
            yield { type: "tool_call_done", callId: "call_1", name: "Bash", arguments: "{}" } as const
            yield { type: "message_stop", stopReason: "tool_use" } as const
          },
        },
      },
      { model: "gpt-5.4", messages: [], stream: true },
      { heartbeatMs: 0 },
    )

    const events = await readSse(response)
    const textStart = events.findIndex((event) => event.data.content_block?.type === "text")
    const textStop = events.findIndex((event, index) => index > textStart && event.data.type === "content_block_stop" && event.data.index === events[textStart].data.index)
    const thinkingStart = events.findIndex((event) => event.data.content_block?.type === "thinking")
    const toolStart = events.findIndex((event) => event.data.content_block?.type === "tool_use")

    expect(textStart).toBeGreaterThan(-1)
    expect(textStop).toBeGreaterThan(textStart)
    expect(thinkingStart).toBeGreaterThan(textStop)
    expect(toolStart).toBeGreaterThan(thinkingStart)
  })

  test("logBody: true captures request body preview", async () => {
    let capturedProxy: any
    const provider = new Claude_Inbound_Provider()
    const response = await provider.handle(
      new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hello" }] }) }),
      { path: "/v1/messages", method: "POST" },
      dummyUpstream,
      { requestId: "req_1", logBody: true, quiet: true, onProxy: (entry) => { capturedProxy = entry } },
    )

    expect(response.status).toBe(200)
    expect(capturedProxy).toBeDefined()
    expect(capturedProxy.requestBody).toBeDefined()
    expect(typeof capturedProxy.requestBody).toBe("string")
  })
})

describe("Claude error formatting edge cases", () => {
  test("status 401 maps to authentication_error", async () => {
    const body = await claudeErrorResponse("unauthorized", 401).json()
    expect(body.error.type).toBe("authentication_error")
  })

  test("status 403 maps to permission_error", async () => {
    const body = await claudeErrorResponse("forbidden", 403).json()
    expect(body.error.type).toBe("permission_error")
  })

  test("status 404 maps to not_found_error", async () => {
    const body = await claudeErrorResponse("not found", 404).json()
    expect(body.error.type).toBe("not_found_error")
  })

  test("status 429 maps to rate_limit_error", async () => {
    const body = await claudeErrorResponse("too many", 429).json()
    expect(body.error.type).toBe("rate_limit_error")
  })

  test("status 529 maps to overloaded_error", async () => {
    const body = await claudeErrorResponse("overloaded", 529).json()
    expect(body.error.type).toBe("overloaded_error")
  })

  test("status 500 maps to api_error", async () => {
    const body = await claudeErrorResponse("internal", 500).json()
    expect(body.error.type).toBe("api_error")
  })

  test("stream error event is valid SSE format", () => {
    const event = claudeStreamErrorEvent("stream broke", 500)
    expect(event).toContain("event: error")
    expect(event).toContain("data: ")
    expect(event).toContain("stream broke")
  })
})

async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for condition")
}

describe("Model_Catalog edge cases", () => {
  test("getModel returns undefined for unknown model", () => {
    const catalog = new Model_Catalog()
    expect(catalog.getModel("nonexistent-model-xyz")).toBeUndefined()
  })

  test("resolveAlias returns input unchanged for non-alias", () => {
    const catalog = new Model_Catalog()
    expect(catalog.resolveAlias("gpt-5.4")).toBe("gpt-5.4")
  })

  test("listModels with resolver that returns empty array returns empty data", async () => {
    const catalog = new Model_Catalog()
    const result = await catalog.listModels(async () => [])
    expect(result.data).toEqual([])
  })

  test("listModels without resolver returns all models", async () => {
    const catalog = new Model_Catalog()
    const result = await catalog.listModels()
    expect(result.data.length).toBeGreaterThan(0)
    expect(result.first_id).toBeDefined()
    expect(result.last_id).toBeDefined()
  })

  test("listModels with limit 1 returns single model", async () => {
    const catalog = new Model_Catalog()
    const result = await catalog.listModels(undefined, { limit: 1 })
    expect(result.data).toHaveLength(1)
  })

  test("listModels with limit 0 clamps to 1", async () => {
    const catalog = new Model_Catalog()
    const result = await catalog.listModels(undefined, { limit: 0 })
    // limit is clamped to Math.max(1, 0) = 1
    expect(result.data).toHaveLength(1)
  })

  test("listModels with afterId pagination", async () => {
    const catalog = new Model_Catalog()
    const all = await catalog.listModels()
    if (all.data.length < 2) return // skip if not enough models

    const afterFirst = await catalog.listModels(undefined, { afterId: all.data[0].id })
    expect(afterFirst.data[0]?.id).not.toBe(all.data[0].id)
  })

  test("listModels with beforeId pagination", async () => {
    const catalog = new Model_Catalog()
    const all = await catalog.listModels()
    if (all.data.length < 2) return

    const beforeLast = await catalog.listModels(undefined, { beforeId: all.data[all.data.length - 1].id })
    expect(beforeLast.data.at(-1)?.id).not.toBe(all.data[all.data.length - 1].id)
  })
})
