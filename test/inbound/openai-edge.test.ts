import { describe, expect, test } from "bun:test"

import { OpenAI_Inbound_Provider } from "../../src/inbound/openai"
import { normalizeCanonicalRequest, normalizeRequestBody } from "../../src/inbound/openai/normalize"

describe("OpenAI normalizeCanonicalRequest edge cases", () => {
  // --- /v1/responses edge cases ---

  test("responses: string input is wrapped in user message", () => {
    const request = normalizeCanonicalRequest("/v1/responses", { model: "gpt-5.4", input: "hello" })

    expect(request.input).toHaveLength(1)
    expect(request.input[0].role).toBe("user")
    expect(request.input[0].content).toEqual([{ type: "input_text", text: "hello" }])
  })

  test("responses: array input filters invalid items", () => {
    const request = normalizeCanonicalRequest("/v1/responses", {
      model: "gpt-5.4",
      input: [
        { role: "user", content: [{ type: "input_text", text: "valid" }] },
        null,
        "not an object",
        42,
        { role: "user" }, // missing content array
        { content: [{ type: "input_text", text: "no role" }] }, // missing role
        { role: 123, content: [{ type: "input_text", text: "bad role" }] }, // non-string role
      ],
    })

    expect(request.input).toHaveLength(1)
    expect(request.input[0].content[0]).toEqual({ type: "input_text", text: "valid" })
  })

  test("responses: array input preserves item-based tool and reasoning history", () => {
    const request = normalizeCanonicalRequest("/v1/responses", {
      model: "gpt-5.4",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{\"x\":1}" },
        { type: "function_call_output", call_id: "call_1", output: [{ type: "output_text", text: "saved" }] },
        { type: "function_call", role: "assistant", id: "fc_2", call_id: "call_2", name: "load", arguments: { ok: true } },
        { type: "function_call_output", role: "tool", call_id: "call_2", output: { type: "output_text", text: "loaded" } },
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "used save" }] },
        { type: "unknown" },
      ],
    }, { passthrough: false })

    expect(request.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "next" }] },
      { role: "assistant", content: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{\"x\":1}" }] },
      { role: "tool", content: [{ type: "function_call_output", call_id: "call_1", output: "saved" }] },
      { role: "assistant", content: [{ type: "function_call", id: "fc_2", call_id: "call_2", name: "load", arguments: "{\"ok\":true}" }] },
      { role: "tool", content: [{ type: "function_call_output", call_id: "call_2", output: "loaded" }] },
      { role: "assistant", content: [{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "used save" }] }] },
    ])
  })

  test("responses: role/content messages accept string and OpenAI content parts", () => {
    const request = normalizeCanonicalRequest("/v1/responses", {
      model: "gpt-5.4",
      input: [
        { role: "user", content: "hello" },
        { type: "message", role: "assistant", content: "world" },
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,abc", detail: "low" } }] },
        { role: "user", content: { type: "input_text", text: "single" } },
        { role: "tool", content: ["tool text", { type: "function_call_output", call_id: "call_1", output: "ok" }] },
      ],
    }, { passthrough: false })

    expect(request.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { role: "assistant", content: [{ type: "output_text", text: "world" }] },
      { role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,abc", detail: "low" }] },
      { role: "user", content: [{ type: "input_text", text: "single" }] },
      { role: "tool", content: [{ type: "input_text", text: "tool text" }, { type: "function_call_output", call_id: "call_1", output: "ok" }] },
    ])
  })

  test("responses: tool role function outputs stringify nested content", () => {
    const request = normalizeCanonicalRequest("/v1/responses", {
      model: "gpt-5.4",
      input: [
        {
          role: "tool",
          content: { type: "function_call_output", call_id: "call_1", output: [{ type: "output_text", text: "saved" }] },
        },
        {
          type: "message",
          role: "tool",
          content: [{ type: "function_call_output", call_id: "call_2", output: { type: "output_text", text: "loaded" } }],
        },
      ],
    }, { passthrough: false })

    expect(request.input).toEqual([
      { role: "tool", content: [{ type: "function_call_output", call_id: "call_1", output: "saved" }] },
      { role: "tool", content: [{ type: "function_call_output", call_id: "call_2", output: "loaded" }] },
    ])
  })

  test("responses: missing input produces empty array", () => {
    const request = normalizeCanonicalRequest("/v1/responses", { model: "gpt-5.4" })
    expect(request.input).toEqual([])
  })

  test("responses: non-string model defaults to empty string", () => {
    const request = normalizeCanonicalRequest("/v1/responses", { model: 123, input: "hello" })
    expect(request.model).toBe("")
  })

  test("responses: missing model defaults to empty string", () => {
    const request = normalizeCanonicalRequest("/v1/responses", { input: "hello" })
    expect(request.model).toBe("")
  })

  test("responses: non-string instructions defaults to fallback", () => {
    const request = normalizeCanonicalRequest("/v1/responses", { model: "m", input: "hi", instructions: 123 })
    expect(request.instructions).toBe("You are a helpful assistant.")
  })

  test("responses: system and developer input messages become instructions", () => {
    const request = normalizeCanonicalRequest("/v1/responses", {
      model: "m",
      input: [
        { role: "system", content: "sys" },
        { role: "developer", content: [{ type: "input_text", text: "dev" }] },
        { role: "user", content: "hi" },
      ],
    }, { passthrough: false })

    expect(request.instructions).toBe("sys\n\ndev")
    expect(request.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }])
  })

  test("responses: stream false is preserved", () => {
    const request = normalizeCanonicalRequest("/v1/responses", { model: "m", input: "hi", stream: false })
    expect(request.stream).toBe(false)
  })

  test("responses: stream undefined defaults to false", () => {
    const request = normalizeCanonicalRequest("/v1/responses", { model: "m", input: "hi" })
    expect(request.stream).toBe(false)
  })

  test("responses: tools array is passed through", () => {
    const request = normalizeCanonicalRequest("/v1/responses", {
      model: "m",
      input: "hi",
      tools: [{ type: "function", name: "save" }],
    })
    expect(request.tools).toEqual([{ type: "function", name: "save" }])
  })

  test("responses: Kiro mode normalizes text.format, server tools, and stream default", () => {
    const request = normalizeCanonicalRequest("/v1/responses", {
      model: "m",
      input: [
        { role: "user", content: [{ type: "input_text", text: "valid" }] },
      ],
      text: { format: { type: "json_schema", name: "result", schema: { type: "object" } } },
      tools: [{ type: "web_search_preview" }, { type: "function", name: "save" }],
      tool_choice: { type: "web_search_preview" },
      stream: false,
    }, { passthrough: false })

    expect(request.passthrough).toBe(false)
    expect(request.stream).toBe(false)
    expect(request.textFormat).toEqual({ type: "json_schema", name: "result", schema: { type: "object" } })
    expect(request.tools).toEqual([{ type: "web_search" }, { type: "function", name: "save" }])
    expect(request.toolChoice).toEqual({ type: "web_search" })
  })

  test("responses: non-array tools is omitted", () => {
    const request = normalizeCanonicalRequest("/v1/responses", { model: "m", input: "hi", tools: "not-array" })
    expect(request.tools).toBeUndefined()
  })

  test("responses: include filters non-strings", () => {
    const request = normalizeCanonicalRequest("/v1/responses", {
      model: "m",
      input: "hi",
      include: ["valid", 123, null, "also_valid"],
    })
    expect(request.include).toEqual(["valid", "also_valid"])
  })

  test("responses: text.format is extracted", () => {
    const request = normalizeCanonicalRequest("/v1/responses", {
      model: "m",
      input: "hi",
      text: { format: { type: "json_schema", name: "result" } },
    })
    expect(request.textFormat).toEqual({ type: "json_schema", name: "result" })
  })

  test("responses: text without format is ignored", () => {
    const request = normalizeCanonicalRequest("/v1/responses", { model: "m", input: "hi", text: {} })
    expect(request.textFormat).toBeUndefined()
  })

  test("responses: text as non-object is ignored", () => {
    const request = normalizeCanonicalRequest("/v1/responses", { model: "m", input: "hi", text: "string" })
    expect(request.textFormat).toBeUndefined()
  })

  test("responses: reasoning.effort is extracted", () => {
    const request = normalizeCanonicalRequest("/v1/responses", {
      model: "m",
      input: "hi",
      reasoning: { effort: "high" },
    })
    expect(request.reasoningEffort).toBe("high")
  })

  test("responses: reasoning_effort is extracted via model suffix normalization", () => {
    // normalizeReasoningBody only processes reasoning_effort for gpt-5* models
    const request = normalizeCanonicalRequest("/v1/responses", {
      model: "gpt-5.4",
      input: "hi",
      reasoning_effort: "low",
    })
    // For gpt-5.4 without suffix, default effort is "medium", but reasoning_effort: "low" overrides
    expect(request.reasoningEffort).toBe("low")
  })

  test("responses: reasoning_effort is ignored for non-gpt-5 models", () => {
    const request = normalizeCanonicalRequest("/v1/responses", {
      model: "other-model",
      input: "hi",
      reasoning_effort: "low",
    })
    // normalizeReasoningBody doesn't process non-gpt-5 models
    expect(request.reasoningEffort).toBeUndefined()
  })

  test("responses: model suffix extracts reasoning effort", () => {
    const request = normalizeCanonicalRequest("/v1/responses", {
      model: "gpt-5.4_high",
      input: "hi",
    })
    expect(request.model).toBe("gpt-5.4")
    expect(request.reasoningEffort).toBe("high")
  })

  // --- /v1/chat/completions edge cases ---

  test("chat: system messages become instructions", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "system", content: "You are a pirate" },
        { role: "user", content: "hello" },
      ],
    })

    expect(request.instructions).toBe("You are a pirate")
    // system messages are filtered from input
    expect(request.input.every((m) => (m as { role: string }).role !== "system")).toBe(true)
  })

  test("chat: developer messages become instructions", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "developer", content: "Be concise" },
        { role: "user", content: "hello" },
      ],
    })

    expect(request.instructions).toBe("Be concise")
  })

  test("chat: system and developer content arrays become text instructions", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "system", content: [{ type: "text", text: "sys" }] },
        { role: "developer", content: [{ type: "input_text", text: "dev" }] },
        { role: "user", content: "hello" },
      ],
    })

    expect(request.instructions).toBe("sys\n\ndev")
  })

  test("chat: multiple system messages are joined", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "system", content: "first" },
        { role: "system", content: "second" },
        { role: "user", content: "hello" },
      ],
    })

    expect(request.instructions).toContain("first")
    expect(request.instructions).toContain("second")
  })

  test("chat: no system messages defaults to fallback instruction", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: "hello" }],
    })

    expect(request.instructions).toBe("You are a helpful assistant.")
  })

  test("chat: string content is wrapped in appropriate text type", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
    })

    expect(request.input[0].content).toEqual([{ type: "input_text", text: "hello" }])
    expect(request.input[1].content).toEqual([{ type: "output_text", text: "world" }])
  })

  test("chat: array content maps OpenAI text and image parts to canonical content", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:image/png;base64,abc", detail: "low" } }] },
        { role: "assistant", content: [{ type: "text", text: "world" }] },
      ],
    })

    expect(request.input[0].content).toEqual([
      { type: "input_text", text: "hello" },
      { type: "input_image", image_url: "data:image/png;base64,abc", detail: "low" },
    ])
    expect(request.input[1].content).toEqual([{ type: "output_text", text: "world" }])
  })

  test("chat: single content object maps without being dropped", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "user", content: { type: "text", text: "hello" } },
        { role: "assistant", content: { type: "text", text: "world" } },
      ],
    })

    expect(request.input[0].content).toEqual([{ type: "input_text", text: "hello" }])
    expect(request.input[1].content).toEqual([{ type: "output_text", text: "world" }])
  })

  test("chat: refusal content maps to assistant text", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "assistant", content: { type: "refusal", refusal: "I cannot help with that." } },
      ],
    })

    expect(request.input[0].content).toEqual([{ type: "output_text", text: "I cannot help with that." }])
  })

  test("chat: tool role messages are preserved", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "user", content: "hello" },
        { role: "tool", content: "tool result" },
      ],
    })

    expect(request.input).toHaveLength(2)
    expect(request.input[1].role).toBe("tool")
  })

  test("chat: unknown role messages are filtered out", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "user", content: "hello" },
        { role: "custom_role", content: "filtered" },
      ],
    })

    expect(request.input).toHaveLength(1)
  })

  test("chat: non-object messages are filtered out", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "user", content: "hello" },
        null,
        "string",
        42,
      ],
    })

    expect(request.input).toHaveLength(1)
  })

  test("chat: empty messages array produces empty input with fallback instructions", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [],
    })

    expect(request.input).toEqual([])
    expect(request.instructions).toBe("You are a helpful assistant.")
  })

  test("chat: missing messages defaults to empty array", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", { model: "m" })
    expect(request.input).toEqual([])
  })

  test("chat: explicit instructions override system messages", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      instructions: "explicit",
      messages: [
        { role: "system", content: "from system" },
        { role: "user", content: "hello" },
      ],
    })

    expect(request.instructions).toBe("explicit")
  })

  test("chat: object tool_choice modes normalize to strings", () => {
    expect(normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "required" },
    }, { passthrough: false }).toolChoice).toBe("required")

    expect(normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "none" },
    }, { passthrough: false }).toolChoice).toBe("none")
  })

  test("chat completions: Kiro mode normalizes Chat messages, tools, response_format, and tool history", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "sys" },
        { role: "developer", content: "dev" },
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "save", arguments: "{\"value\":1}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "saved" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "result", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
      },
      tools: [{
        type: "function",
        function: {
          name: "save",
          description: "Save data",
          parameters: { type: "object", properties: { value: { type: "number" } } },
          strict: true,
        },
      }],
      tool_choice: { type: "function", function: { name: "save" } },
    }, { passthrough: false })

    expect(request).toMatchObject({
      model: "gpt-5.4",
      instructions: "sys\n\ndev",
      passthrough: false,
      stream: false,
      textFormat: { type: "json_schema", name: "result", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
      tools: [{
        type: "function",
        name: "save",
        description: "Save data",
        parameters: { type: "object", properties: { value: { type: "number" } } },
        strict: true,
      }],
      toolChoice: { type: "function", function: { name: "save" } },
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { role: "assistant", content: [{ type: "function_call", id: "call_1", call_id: "call_1", name: "save", arguments: "{\"value\":1}" }] },
        { role: "tool", content: [{ type: "function_call_output", call_id: "call_1", output: "saved" }] },
      ],
    })
  })

  // --- Unknown pathname ---

  test("unknown pathname produces minimal canonical request", () => {
    const request = normalizeCanonicalRequest("/v1/unknown", { model: "m", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] })

    expect(request.passthrough).toBe(false)
    expect(request.stream).toBe(false)
    expect(request.tools).toBeUndefined()
  })

  test("unknown pathname with non-array input produces empty input", () => {
    const request = normalizeCanonicalRequest("/v1/unknown", { model: "m", input: "string" })
    expect(request.input).toEqual([])
  })
})

describe("normalizeRequestBody legacy edge cases", () => {
  test("responses: string input is expanded", () => {
    const body = normalizeRequestBody("/v1/responses", { model: "m", input: "hello" })
    expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hello" }] }])
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
  })

  test("responses: array input is passed through with defaults", () => {
    const body = normalizeRequestBody("/v1/responses", { model: "m", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] })
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
  })

  test("chat: messages are transformed to input", () => {
    const body = normalizeRequestBody("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
      ],
    })

    expect(body.instructions).toBe("sys")
    expect(body.messages).toBeUndefined()
    expect(Array.isArray(body.input)).toBe(true)
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
  })

  test("unknown pathname preserves body with defaults", () => {
    const body = normalizeRequestBody("/v1/unknown", { model: "m", custom: "field" })
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.custom).toBe("field")
  })
})

describe("OpenAI_Inbound_Provider edge cases", () => {
  test("unexpected canonical_response returns 200 with formatted response", async () => {
    const provider = new OpenAI_Inbound_Provider()
    const upstream = {
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

    const response = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )

    expect(response.status).toBe(200)
  })

  test("unexpected canonical_stream returns 200 with SSE", async () => {
    const provider = new OpenAI_Inbound_Provider()
    const upstream = {
      proxy: () =>
        Promise.resolve({
          type: "canonical_stream" as const,
          status: 200,
          id: "resp_1",
          model: "gpt-5.4",
          events: { async *[Symbol.asyncIterator]() {} },
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const response = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi", stream: true }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )

    expect(response.status).toBe(200)
  })

  test("logBody: true captures request body in proxy callback", async () => {
    let capturedProxy: any
    const provider = new OpenAI_Inbound_Provider()
    const upstream = {
      proxy: () =>
        Promise.resolve({
          type: "canonical_passthrough" as const,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          body: "ok",
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_1", logBody: true, quiet: true, onProxy: (entry) => { capturedProxy = entry } },
    )

    expect(capturedProxy).toBeDefined()
    expect(capturedProxy.requestBody).toBeDefined()
    expect(capturedProxy.responseBody).toBeUndefined()
  })

  test("captures passthrough response stream in proxy callback after consumption", async () => {
    let capturedProxy: any
    const provider = new OpenAI_Inbound_Provider()
    const upstream = {
      proxy: () =>
        Promise.resolve({
          type: "canonical_passthrough" as const,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: one\n\n"))
              controller.enqueue(new TextEncoder().encode("data: two\n\n"))
              controller.close()
            },
          }),
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const response = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_1", logBody: true, quiet: true, onProxy: (entry) => { capturedProxy = entry } },
    )

    expect(await response.text()).toBe("data: one\n\ndata: two\n\n")
    expect(capturedProxy.responseBody).toBe("data: one\n\ndata: two\n\n")
  })

  test("routes returns correct descriptors", () => {
    const provider = new OpenAI_Inbound_Provider()
    const routes = provider.routes()

    expect(routes).toHaveLength(2)
    expect(routes.some((r) => r.path === "/v1/responses" && r.method === "POST")).toBe(true)
    expect(routes.some((r) => r.path === "/v1/chat/completions" && r.method === "POST")).toBe(true)
  })

  test("provider name is openai", () => {
    const provider = new OpenAI_Inbound_Provider()
    expect(provider.name).toBe("openai")
  })
})
