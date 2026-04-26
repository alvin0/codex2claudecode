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

  test("responses: stream false is preserved", () => {
    const request = normalizeCanonicalRequest("/v1/responses", { model: "m", input: "hi", stream: false })
    expect(request.stream).toBe(false)
  })

  test("responses: stream undefined defaults to true", () => {
    const request = normalizeCanonicalRequest("/v1/responses", { model: "m", input: "hi" })
    expect(request.stream).toBe(true)
  })

  test("responses: tools array is passed through", () => {
    const request = normalizeCanonicalRequest("/v1/responses", {
      model: "m",
      input: "hi",
      tools: [{ type: "function", name: "save" }],
    })
    expect(request.tools).toEqual([{ type: "function", name: "save" }])
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

  test("chat: array content is passed through as-is", () => {
    const request = normalizeCanonicalRequest("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:..." } }] },
      ],
    })

    expect(request.input[0].content).toHaveLength(2)
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

  // --- Unknown pathname ---

  test("unknown pathname produces minimal canonical request", () => {
    const request = normalizeCanonicalRequest("/v1/unknown", { model: "m", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] })

    expect(request.passthrough).toBe(true)
    expect(request.stream).toBe(true)
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
  test("unexpected canonical_response returns 500", async () => {
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

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error.message).toContain("non-passthrough")
  })

  test("unexpected canonical_stream returns 500", async () => {
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
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )

    expect(response.status).toBe(500)
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
