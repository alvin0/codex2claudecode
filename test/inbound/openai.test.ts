import { afterEach, describe, expect, test } from "bun:test"

import { OpenAI_Inbound_Provider } from "../../src/inbound/openai"
import { OpenAI_Kiro_Inbound_Adapter } from "../../src/inbound/openai/kiro"
import { codexConfigPath, writeCodexFastModeConfig } from "../../src/upstream/codex/fast-mode"
import { normalizeCanonicalRequest, normalizeRequestBody } from "../../src/inbound/openai/normalize"
import { canonicalResponseToChatCompletion, canonicalResponseToResponsesBody, openAICanonicalStreamResponse } from "../../src/inbound/openai/response"
import { mkdtemp, path, readFile, readSse, rm, tmpdir, writeFile } from "../helpers"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempAuthFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "openai-inbound-test-"))
  tempDirs.push(dir)
  return path.join(dir, "auth-codex.json")
}

describe("OpenAI inbound normalization", () => {
  test("normalizes responses and chat completions into canonical requests", () => {
    expect(normalizeCanonicalRequest("/v1/responses", { model: "gpt-5.4_high", input: "hello" })).toMatchObject({
      model: "gpt-5.4",
      instructions: "You are a helpful assistant.",
      passthrough: true,
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    })

    expect(
      normalizeCanonicalRequest("/v1/chat/completions", {
        model: "gpt-5.4",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "there" },
        ],
      }),
    ).toMatchObject({
      model: "gpt-5.4",
      instructions: "sys",
      passthrough: true,
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "there" }] },
      ],
    })
  })

  test("keeps the legacy normalizeRequestBody output shape", () => {
    expect(normalizeRequestBody("/v1/responses", { model: "gpt-5.4_high", input: "hello" })).toEqual({
      model: "gpt-5.4",
      reasoning: { effort: "high" },
      instructions: "You are a helpful assistant.",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      store: false,
      stream: true,
    })
  })

  test("property: randomized OpenAI requests become valid canonical requests", () => {
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const responsesRequest = normalizeCanonicalRequest("/v1/responses", {
        model: `model-${iteration}`,
        input: `input-${iteration}`,
        tools: Array.from({ length: iteration % 3 }, (_, index) => ({ type: "function", name: `tool_${index}` })),
      })
      expect(responsesRequest.model).toBe(`model-${iteration}`)
      expect(responsesRequest.input).toHaveLength(1)
      expect(responsesRequest.passthrough).toBe(true)
      expect(responsesRequest.tools?.length ?? 0).toBe(iteration % 3)

      const chatRequest = normalizeCanonicalRequest("/v1/chat/completions", {
        model: `chat-${iteration}`,
        messages: Array.from({ length: (iteration % 4) + 1 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message-${index}`,
        })),
      })
      expect(chatRequest.model).toBe(`chat-${iteration}`)
      expect(chatRequest.input).toHaveLength((iteration % 4) + 1)
      expect(chatRequest.passthrough).toBe(true)
    }
  })
})

describe("OpenAI inbound provider", () => {
  test("forwards passthrough successes, upstream errors, and invalid JSON", async () => {
    const provider = new OpenAI_Inbound_Provider()
    const upstream = {
      proxy: () =>
        Promise.resolve({
          type: "canonical_passthrough" as const,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-type": "text/event-stream" }),
          body: new Response("event: message\ndata: ok\n\n").body,
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
    expect(await response.text()).toBe("event: message\ndata: ok\n\n")

    const failingUpstream = {
      proxy: () =>
        Promise.resolve({
          type: "canonical_error" as const,
          status: 418,
          headers: new Headers({ "content-type": "text/plain" }),
          body: "denied",
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const error = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
      { path: "/v1/responses", method: "POST" },
      failingUpstream,
      { requestId: "req_2", logBody: false, quiet: true },
    )
    expect(error.status).toBe(418)
    expect(await error.text()).toBe("denied")

    const invalid = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: "{" }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_3", logBody: false, quiet: true },
    )
    expect(invalid.status).toBe(500)
    expect(await invalid.json()).toEqual({ error: { message: expect.stringContaining("Invalid JSON") } })
  })

  test("rejects configured Codex OpenAI provider and upstream mismatches before proxying", async () => {
    const provider = new OpenAI_Inbound_Provider({ expectedUpstreamKind: "codex" })
    let proxyCalls = 0
    const upstream = {
      providerKind: "kiro" as const,
      proxy: () => {
        proxyCalls += 1
        return Promise.resolve({
          type: "canonical_passthrough" as const,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          body: "ok",
        })
      },
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const response = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_codex_mismatch", logBody: false, quiet: true },
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: {
        type: "server_error",
        message: "OpenAI inbound provider 'openai' expected codex upstream, received kiro",
      },
    })
    expect(proxyCalls).toBe(0)
  })

  test("does not inject service tier at inbound level", async () => {
    const authFile = await tempAuthFile()
    await writeCodexFastModeConfig(authFile, { enabled: true })
    let capturedRequest: any
    const provider = new OpenAI_Inbound_Provider()
    const upstream = {
      proxy: (request: unknown) => {
        capturedRequest = request
        return Promise.resolve({
          type: "canonical_passthrough" as const,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          body: "ok",
        })
      },
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_fast", authFile, logBody: false, quiet: true },
    )

    expect(capturedRequest.metadata.serviceTier).toBeUndefined()
  })

  test("stores Codex fast mode inside shared Codex config file", async () => {
    const authFile = await tempAuthFile()
    await writeFile(codexConfigPath(authFile), `${JSON.stringify({ other: { value: true } }, null, 2)}\n`)
    await writeCodexFastModeConfig(authFile, { enabled: true })

    expect(JSON.parse(await readFile(codexConfigPath(authFile), "utf8"))).toEqual({
      other: { value: true },
      fastMode: { enabled: true },
    })
  })
})

describe("OpenAI Kiro adapter", () => {
  test("rejects Kiro OpenAI adapter and upstream mismatches before proxying", async () => {
    const provider = new OpenAI_Kiro_Inbound_Adapter()
    let proxyCalls = 0
    const upstream = {
      providerKind: "codex" as const,
      proxy: () => {
        proxyCalls += 1
        return Promise.resolve({
          type: "canonical_response" as const,
          id: "resp_should_not_call",
          model: "m",
          stopReason: "end_turn",
          content: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        })
      },
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const response = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_kiro_mismatch", logBody: false, quiet: true },
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: {
        type: "server_error",
        message: "OpenAI inbound provider 'openai-kiro' expected kiro upstream, received codex",
      },
    })
    expect(proxyCalls).toBe(0)
  })

  test("formats upstream and request errors as OpenAI error objects", async () => {
    const provider = new OpenAI_Kiro_Inbound_Adapter()
    const upstream = {
      providerKind: "kiro" as const,
      proxy: () =>
        Promise.resolve({
          type: "canonical_error" as const,
          status: 400,
          headers: new Headers({ "x-test": "1", "content-type": "text/plain" }),
          body: "bad tool choice",
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const error = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_kiro_error", logBody: false, quiet: true },
    )
    expect(error.status).toBe(400)
    expect(error.headers.get("content-type")).toContain("application/json")
    expect(error.headers.get("x-test")).toBe("1")
    expect(await error.json()).toEqual({
      error: {
        message: "bad tool choice",
        type: "upstream_error",
        param: null,
        code: null,
      },
    })

    const invalid = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: "[]" }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_kiro_invalid", logBody: false, quiet: true },
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: { type: "invalid_request_error", message: "Request body must be a JSON object" } })
  })

  test("rejects mixed Responses and Chat Completions request bodies", async () => {
    const provider = new OpenAI_Kiro_Inbound_Adapter()
    let proxyCalls = 0
    const upstream = {
      providerKind: "kiro" as const,
      proxy: () => {
        proxyCalls += 1
        return Promise.resolve({
          type: "canonical_response" as const,
          id: "resp_should_not_call",
          model: "m",
          stopReason: "end_turn",
          content: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        })
      },
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const chatPayloadOnResponses = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_kiro_wrong_responses", logBody: false, quiet: true },
    )
    expect(chatPayloadOnResponses.status).toBe(400)
    expect(chatPayloadOnResponses.headers.get("content-type")).toContain("application/json")
    expect(await chatPayloadOnResponses.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported parameter: 'messages'. Use 'input' with /v1/responses.",
      },
    })

    const responsesPayloadOnChat = await provider.handle(
      new Request("http://localhost/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
      { path: "/v1/chat/completions", method: "POST" },
      upstream,
      { requestId: "req_kiro_wrong_chat", logBody: false, quiet: true },
    )
    expect(responsesPayloadOnChat.status).toBe(400)
    expect(responsesPayloadOnChat.headers.get("content-type")).toContain("application/json")
    expect(await responsesPayloadOnChat.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported parameter: 'input'. Use 'messages' with /v1/chat/completions.",
      },
    })

    const chatTextFormat = await provider.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], text: { format: { type: "json_schema", name: "out", schema: {} } } }),
      }),
      { path: "/v1/chat/completions", method: "POST" },
      upstream,
      { requestId: "req_kiro_chat_text", logBody: false, quiet: true },
    )
    expect(chatTextFormat.status).toBe(400)
    expect(chatTextFormat.headers.get("content-type")).toContain("application/json")
    expect(await chatTextFormat.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported parameter: 'text'. Use 'response_format' with /v1/chat/completions.",
      },
    })

    const responsesResponseFormat = await provider.handle(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "m", input: "hi", response_format: { type: "json_object" } }),
      }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_kiro_responses_response_format", logBody: false, quiet: true },
    )
    expect(responsesResponseFormat.status).toBe(400)
    expect(responsesResponseFormat.headers.get("content-type")).toContain("application/json")
    expect(await responsesResponseFormat.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported parameter: 'response_format'. Use 'text.format' with /v1/responses.",
      },
    })

    expect(proxyCalls).toBe(0)
  })

  test("requires documented body roots for Kiro OpenAI-compatible routes", async () => {
    const provider = new OpenAI_Kiro_Inbound_Adapter()
    const upstream = {
      providerKind: "kiro" as const,
      proxy: () =>
        Promise.resolve({
          type: "canonical_response" as const,
          id: "resp_should_not_call",
          model: "m",
          stopReason: "end_turn",
          content: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const missingResponsesInput = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m" }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_kiro_missing_responses_input", logBody: false, quiet: true },
    )
    expect(missingResponsesInput.status).toBe(400)
    expect(await missingResponsesInput.json()).toMatchObject({
      error: { type: "invalid_request_error", message: "Missing required parameter: 'input'." },
    })

    const missingChatMessages = await provider.handle(
      new Request("http://localhost/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m" }) }),
      { path: "/v1/chat/completions", method: "POST" },
      upstream,
      { requestId: "req_kiro_missing_chat_messages", logBody: false, quiet: true },
    )
    expect(missingChatMessages.status).toBe(400)
    expect(await missingChatMessages.json()).toMatchObject({
      error: { type: "invalid_request_error", message: "Missing required parameter: 'messages'." },
    })

    const missingModel = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ input: "hi" }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_kiro_missing_model", logBody: false, quiet: true },
    )
    expect(missingModel.status).toBe(400)
    expect(await missingModel.json()).toMatchObject({
      error: { type: "invalid_request_error", message: "Missing required parameter: 'model'." },
    })
  })

  test("formats canonical responses as Responses API objects", async () => {
    const provider = new OpenAI_Kiro_Inbound_Adapter()
    const upstream = {
      providerKind: "kiro" as const,
      proxy: () =>
        Promise.resolve({
          type: "canonical_response" as const,
          id: "resp_1",
          model: "kiro-model",
          stopReason: "tool_use",
          content: [
            { type: "text" as const, text: "hello" },
            { type: "tool_call" as const, id: "fc_1", callId: "call_1", name: "save", arguments: "{\"ok\":true}" },
          ],
          usage: { inputTokens: 3, outputTokens: 4 },
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const response = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi", stream: false }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_kiro_responses", logBody: false, quiet: true },
    )

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body).toMatchObject({
      id: "resp_1",
      object: "response",
      status: "completed",
      model: "kiro-model",
      output: [
        { type: "message", content: [{ type: "output_text", text: "hello", annotations: [] }] },
        { type: "function_call", call_id: "call_1", name: "save", arguments: "{\"ok\":true}", status: "completed" },
      ],
      store: true,
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    })
    expect(body).not.toHaveProperty("output_text")
    expect(responseOutputText(body)).toBe("hello")
  })

  test("formats canonical cache and reasoning usage in Responses objects", async () => {
    const provider = new OpenAI_Kiro_Inbound_Adapter()
    const upstream = {
      providerKind: "kiro" as const,
      proxy: () =>
        Promise.resolve({
          type: "canonical_response" as const,
          id: "resp_usage",
          model: "kiro-model",
          stopReason: "end_turn",
          content: [{ type: "text" as const, text: "hello" }],
          usage: {
            inputTokens: 6,
            cacheCreationInputTokens: 2,
            cacheReadInputTokens: 4,
            outputTokens: 3,
            outputReasoningTokens: 1,
          },
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const response = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi", stream: false }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_kiro_usage_responses", logBody: false, quiet: true },
    )

    const body = await response.json() as any
    expect(body.usage).toEqual({
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 15,
    })
  })

  test("formats canonical responses as Chat Completions objects for /v1/chat/completions", async () => {
    const provider = new OpenAI_Kiro_Inbound_Adapter()
    const upstream = {
      providerKind: "kiro" as const,
      proxy: () =>
        Promise.resolve({
          type: "canonical_response" as const,
          id: "resp_2",
          model: "kiro-model",
          stopReason: "tool_use",
          content: [{ type: "tool_call" as const, id: "fc_1", callId: "call_1", name: "save", arguments: "{\"ok\":true}" }],
          usage: { inputTokens: 5, outputTokens: 6 },
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const response = await provider.handle(
      new Request("http://localhost/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) }),
      { path: "/v1/chat/completions", method: "POST" },
      upstream,
      { requestId: "req_kiro_complete", logBody: false, quiet: true },
    )

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body).toMatchObject({
      id: "chatcmpl_2",
      object: "chat.completion",
      model: "kiro-model",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "save", arguments: "{\"ok\":true}" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    })
  })

  test("formats canonical cache and reasoning usage in Chat Completions objects", async () => {
    const provider = new OpenAI_Kiro_Inbound_Adapter()
    const upstream = {
      providerKind: "kiro" as const,
      proxy: () =>
        Promise.resolve({
          type: "canonical_response" as const,
          id: "resp_chat_usage",
          model: "kiro-model",
          stopReason: "end_turn",
          content: [{ type: "text" as const, text: "hello" }],
          usage: {
            inputTokens: 6,
            cacheReadInputTokens: 4,
            outputTokens: 3,
            outputReasoningTokens: 1,
          },
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const response = await provider.handle(
      new Request("http://localhost/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) }),
      { path: "/v1/chat/completions", method: "POST" },
      upstream,
      { requestId: "req_kiro_usage_chat", logBody: false, quiet: true },
    )

    const body = await response.json() as any
    expect(body.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 13,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 1 },
    })
  })
})

describe("OpenAI canonical response formatting", () => {
  test("converts text and tool call responses into Responses and Chat wire shapes", () => {
    const canonical = {
      type: "canonical_response" as const,
      id: "resp_3",
      model: "m",
      stopReason: "tool_use",
      content: [
        { type: "text" as const, text: "result" },
        { type: "tool_call" as const, id: "fc_1", callId: "call_1", name: "save", arguments: "{}" },
      ],
      usage: { inputTokens: 1, outputTokens: 2 },
    }

    expect(canonicalResponseToResponsesBody(canonical, { model: "m", input: "hi" })).toMatchObject({
      object: "response",
      output: [
        { type: "message", content: [{ type: "output_text", text: "result", annotations: [] }] },
        { type: "function_call", call_id: "call_1", name: "save", arguments: "{}" },
      ],
      store: true,
    })
    const responsesBody = canonicalResponseToResponsesBody(canonical, { model: "m", input: "hi" })
    expect(responsesBody).not.toHaveProperty("output_text")
    expect(responseOutputText(responsesBody)).toBe("result")
    expect(canonicalResponseToChatCompletion(canonical)).toMatchObject({
      object: "chat.completion",
      choices: [{
        message: {
          role: "assistant",
          content: "result",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "save", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      }],
    })
  })

  test("marks Responses API objects incomplete on max token stops", () => {
    const body = canonicalResponseToResponsesBody({
      type: "canonical_response",
      id: "resp_incomplete",
      model: "m",
      stopReason: "max_tokens",
      content: [{ type: "text", text: "partial" }],
      usage: { inputTokens: 1, outputTokens: 2 },
    }, { model: "m", input: "hi" })

    expect(body).toMatchObject({
      object: "response",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    })
    expect(body).not.toHaveProperty("completed_at")
    expect(body).not.toHaveProperty("output_text")
    expect(responseOutputText(body)).toBe("partial")
  })

  test("preserves Responses output text annotations across canonical text blocks", () => {
    const body = canonicalResponseToResponsesBody({
      type: "canonical_response",
      id: "resp_annotations",
      model: "m",
      stopReason: "end_turn",
      content: [
        { type: "text", text: "hello", annotations: [{ type: "url_citation", url: "https://example.com" }] },
        { type: "text", text: " world" },
      ],
      usage: { inputTokens: 1, outputTokens: 2 },
    }, { model: "m", input: "hi" })

    expect(body).toMatchObject({
      output: [{
        type: "message",
        content: [
          { type: "output_text", text: "hello", annotations: [{ type: "url_citation", url: "https://example.com" }] },
          { type: "output_text", text: " world", annotations: [] },
        ],
      }],
    })
    expect(body).not.toHaveProperty("output_text")
    expect(responseOutputText(body)).toBe("hello world")
  })

  test("converts canonical streams to Responses semantic SSE and Chat chunk SSE", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_stream",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "hel" },
        { type: "text_done", text: "hello" },
        { type: "usage", usage: { inputTokens: 1, cacheReadInputTokens: 4 } },
        { type: "completion", usage: { outputTokens: 2, outputReasoningTokens: 1 } },
        { type: "message_stop", stopReason: "end_turn" },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    expect(events.map((event) => event.event)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(responseOutputText(events.at(-1)?.data.response)).toBe("hello")
    expect(events.filter((event) => event.event === "response.output_text.delta").map((event) => event.data.delta).join("")).toBe("hello")
    expect(events.at(-1)?.data.response.usage).toEqual({
      input_tokens: 5,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 7,
    })

    const chatStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_stream",
      model: "m",
      events: streamEvents([
        { type: "tool_call_done", callId: "call_1", name: "save", arguments: "{}" },
        { type: "usage", usage: { inputTokens: 2, cacheReadInputTokens: 4 } },
        { type: "completion", usage: { outputTokens: 3, outputReasoningTokens: 1 } },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chunks = (await chatStream.text()).trim().split("\n\n").map((chunk) => chunk.replace(/^data: /, ""))
    expect(JSON.parse(chunks[0])).toMatchObject({
      object: "chat.completion.chunk",
      choices: [{ delta: { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "save", arguments: "{}" } }] } }],
    })
    expect(JSON.parse(chunks.at(-2)!)).toMatchObject({
      choices: [{ finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 6,
        completion_tokens: 3,
        total_tokens: 9,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    })
    expect(chunks.at(-1)).toBe("[DONE]")
  })

  test("keeps Chat stream text and tool arguments append-only", async () => {
    const chatStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_append_only",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "hel" },
        { type: "text_done", text: "hello" },
        { type: "tool_call_delta", callId: "call_1", name: "unknown", argumentsDelta: "{\"x\":" },
        { type: "tool_call_done", callId: "call_1", name: "save", arguments: "{\"x\":1}" },
        { type: "usage", usage: { inputTokens: 2, outputTokens: 3 } },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chunks = (await chatStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))
    const text = chunks.flatMap((chunk) => typeof chunk.choices[0].delta.content === "string" ? [chunk.choices[0].delta.content] : []).join("")
    const args = chunks.flatMap((chunk) => {
      const toolCall = chunk.choices[0].delta.tool_calls?.[0]
      return typeof toolCall?.function?.arguments === "string" ? [toolCall.function.arguments] : []
    }).join("")
    const toolNames = chunks.flatMap((chunk) => {
      const toolCall = chunk.choices[0].delta.tool_calls?.[0]
      return typeof toolCall?.function?.name === "string" ? [toolCall.function.name] : []
    })

    expect(text).toBe("hello")
    expect(args).toBe("{\"x\":1}")
    expect(toolNames.at(-1)).toBe("save")
  })

  test("emits reasoning content in Chat stream chunks", async () => {
    const chatStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_reasoning",
      model: "m",
      events: streamEvents([
        { type: "thinking_delta", text: "plan" },
        { type: "text_delta", delta: "answer" },
        { type: "usage", usage: { inputTokens: 2, outputTokens: 3 } },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chunks = (await chatStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))

    const reasoning = chunks.flatMap((chunk) => typeof chunk.choices[0].delta.reasoning_content === "string" ? [chunk.choices[0].delta.reasoning_content] : []).join("")
    const text = chunks.flatMap((chunk) => typeof chunk.choices[0].delta.content === "string" ? [chunk.choices[0].delta.content] : []).join("")

    expect(chunks[0]).toMatchObject({ choices: [{ delta: { role: "assistant", reasoning_content: "plan" } }] })
    expect(reasoning).toBe("plan")
    expect(text).toBe("answer")
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })
  })

  test("splits large text deltas into multiple Responses and Chat stream chunks", async () => {
    const longText = "Once upon a moonlit meadow, a small unicorn learned to follow the quiet shimmer of starlight through silver grass and sleepy flowers."
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_large_delta",
      model: "m",
      events: streamEvents([{ type: "text_delta", delta: longText }]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const responseEvents = await readSse(responsesStream)
    const responseDeltas = responseEvents
      .filter((event) => event.event === "response.output_text.delta")
      .map((event) => event.data.delta)
    expect(responseDeltas.length).toBeGreaterThan(1)
    expect(responseDeltas.join("")).toBe(longText)

    const chatStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_large_delta",
      model: "m",
      events: streamEvents([{ type: "text_delta", delta: longText }]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chatDeltas = (await chatStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))
      .flatMap((chunk) => typeof chunk.choices[0].delta.content === "string" ? [chunk.choices[0].delta.content] : [])
    expect(chatDeltas.length).toBeGreaterThan(1)
    expect(chatDeltas.join("")).toBe(longText)
  })

  test("paces synthetic Chat text chunks instead of enqueueing one complete body", async () => {
    const longText = "Once upon a moonlit meadow, a small unicorn learned to follow the quiet shimmer of starlight through silver grass and sleepy flowers."
    const chatStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_paced_delta",
      model: "m",
      events: streamEvents([{ type: "text_delta", delta: longText }]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const reader = chatStream.body!.getReader()
    const first = await reader.read()
    await reader.cancel()

    expect(first.done).toBe(false)
    expect(new TextDecoder().decode(first.value)).not.toContain(longText)
  })

  test("emits Chat stream tool name updates even when arguments are complete", async () => {
    const chatStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_tool_name_update",
      model: "m",
      events: streamEvents([
        { type: "tool_call_delta", callId: "call_1", name: "unknown", argumentsDelta: "{}" },
        { type: "tool_call_done", callId: "call_1", name: "save", arguments: "{}" },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chunks = (await chatStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))
    const toolNames = chunks.flatMap((chunk) => {
      const toolCall = chunk.choices[0].delta.tool_calls?.[0]
      return typeof toolCall?.function?.name === "string" ? [toolCall.function.name] : []
    })
    const args = chunks.flatMap((chunk) => {
      const toolCall = chunk.choices[0].delta.tool_calls?.[0]
      return typeof toolCall?.function?.arguments === "string" ? [toolCall.function.arguments] : []
    }).join("")

    expect(args).toBe("{}")
    expect(toolNames).toEqual(["unknown", "save"])
  })

  test("starts a new Responses message item for text after tool calls", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_text_tool_text",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "before " },
        { type: "tool_call_done", callId: "call_1", name: "save", arguments: "{}" },
        { type: "text_delta", delta: "after" },
        { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    const addedMessages = events.filter((event) => event.event === "response.output_item.added" && event.data.item?.type === "message")
    const completed = events.at(-1)?.data.response

    expect(addedMessages).toHaveLength(2)
    expect(completed.output.map((item: any) => item.type)).toEqual(["message", "function_call", "message"])
    expect(responseOutputText(completed)).toBe("before after")
  })

  test("keeps Responses stream tool output indexes stable for concurrent tool calls", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_parallel_tools",
      model: "m",
      events: streamEvents([
        { type: "tool_call_delta", callId: "call_1", name: "save", argumentsDelta: "{\"a\":" },
        { type: "tool_call_delta", callId: "call_2", name: "load", argumentsDelta: "{\"b\":" },
        { type: "tool_call_done", callId: "call_2", name: "load", arguments: "{\"b\":2}" },
        { type: "tool_call_done", callId: "call_1", name: "save", arguments: "{\"a\":1}" },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    const added = events.filter((event) => event.event === "response.output_item.added")
    const argumentEvents = events.filter((event) => event.event === "response.function_call_arguments.delta" || event.event === "response.function_call_arguments.done")
    const done = events.filter((event) => event.event === "response.output_item.done")
    const completed = events.at(-1)?.data.response

    expect(added.map((event) => [event.data.output_index, event.data.item.name, event.data.item.status])).toEqual([
      [0, "save", "in_progress"],
      [1, "load", "in_progress"],
    ])
    expect(argumentEvents.map((event) => [event.event, event.data.output_index])).toEqual([
      ["response.function_call_arguments.delta", 0],
      ["response.function_call_arguments.delta", 1],
      ["response.function_call_arguments.done", 1],
      ["response.function_call_arguments.done", 0],
    ])
    expect(done.map((event) => [event.data.output_index, event.data.item.name, event.data.item.status])).toEqual([
      [1, "load", "completed"],
      [0, "save", "completed"],
    ])
    expect(completed.output.map((item: any) => [item.call_id, item.arguments])).toEqual([
      ["call_1", "{\"a\":1}"],
      ["call_2", "{\"b\":2}"],
    ])
  })

  test("uses done payloads to repair Responses final text and tool arguments", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_done_repair",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "helo" },
        { type: "text_done", text: "hello" },
        { type: "tool_call_delta", callId: "call_1", name: "save", argumentsDelta: "{\"x\":2" },
        { type: "tool_call_done", callId: "call_1", name: "save", arguments: "{\"x\":1}" },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    const textDeltas = events.filter((event) => event.event === "response.output_text.delta").map((event) => event.data.delta).join("")
    const completed = events.at(-1)?.data.response

    expect(textDeltas).toBe("helo")
    expect(responseOutputText(completed)).toBe("hello")
    expect(completed.output[1]).toMatchObject({ type: "function_call", call_id: "call_1", arguments: "{\"x\":1}" })
  })

  test("uses completion output as a fallback for Responses streams without item events", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_completion_output",
      model: "m",
      events: streamEvents([
        {
          type: "completion",
          output: [
            { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
            { type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: { ok: true } },
          ],
          usage: { inputTokens: 1, outputTokens: 2 },
          stopReason: "tool_use",
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    const completed = events.at(-1)?.data.response

    expect(events.map((event) => event.event)).toContain("response.output_item.done")
    expect(events.filter((event) => event.event === "response.output_text.delta").map((event) => event.data.delta).join("")).toBe("hello")
    expect(completed).toMatchObject({
      output: [
        { type: "message", id: "msg_1", content: [{ type: "output_text", text: "hello", annotations: [] }] },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{\"ok\":true}" },
      ],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    })
    expect(completed).not.toHaveProperty("output_text")
    expect(responseOutputText(completed)).toBe("hello")
  })

  test("uses completion output as a fallback for Chat streams without deltas", async () => {
    const chatStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_completion_output",
      model: "m",
      events: streamEvents([
        {
          type: "completion",
          output: [
            { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
            { type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{\"ok\":true}" },
          ],
          usage: { inputTokens: 3, outputTokens: 4 },
          stopReason: "tool_use",
        },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chunks = (await chatStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
    const dataChunks = chunks.filter((chunk) => chunk !== "[DONE]").map((chunk) => JSON.parse(chunk))
    const text = dataChunks.flatMap((chunk) => typeof chunk.choices[0].delta.content === "string" ? [chunk.choices[0].delta.content] : []).join("")
    const args = dataChunks.flatMap((chunk) => {
      const toolCall = chunk.choices[0].delta.tool_calls?.[0]
      return typeof toolCall?.function?.arguments === "string" ? [toolCall.function.arguments] : []
    }).join("")

    expect(text).toBe("hello")
    expect(args).toBe("{\"ok\":true}")
    expect(dataChunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })
    expect(chunks.at(-1)).toBe("[DONE]")
  })

  test("normalizes fallback message content strings and single objects", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_message_content_variants",
      model: "m",
      events: streamEvents([
        {
          type: "completion",
          output: [
            { type: "message", id: "msg_1", role: "assistant", content: "hello " },
            { type: "message", id: "msg_2", role: "assistant", content: { type: "output_text", text: "world" } },
          ],
          usage: { inputTokens: 1, outputTokens: 2 },
          stopReason: "end_turn",
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const responseEvents = await readSse(responsesStream)
    const responseBody = responseEvents.at(-1)?.data.response
    expect(responseBody).toMatchObject({
      output: [
        { type: "message", content: [{ type: "output_text", text: "hello ", annotations: [] }] },
        { type: "message", content: [{ type: "output_text", text: "world", annotations: [] }] },
      ],
    })
    expect(responseBody).not.toHaveProperty("output_text")
    expect(responseOutputText(responseBody)).toBe("hello world")

    const chatStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_message_content_variants",
      model: "m",
      events: streamEvents([
        {
          type: "message_item_done",
          item: { type: "message", id: "msg_1", role: "assistant", content: { type: "output_text", text: "hello" } },
        },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chunks = (await chatStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))
    const text = chunks.flatMap((chunk) => typeof chunk.choices[0].delta.content === "string" ? [chunk.choices[0].delta.content] : []).join("")

    expect(text).toBe("hello")
  })

  test("uses completion output to repair streams that already emitted deltas", async () => {
    const responsesTextStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_completion_repair_text",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "hel" },
        {
          type: "completion",
          output: [{
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: { type: "output_text", text: "hello", annotations: [{ type: "url_citation", url: "https://example.com" }] },
          }],
          usage: { inputTokens: 1, outputTokens: 2 },
          stopReason: "end_turn",
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const responseTextEvents = await readSse(responsesTextStream)
    expect(responseTextEvents.filter((event) => event.event === "response.output_text.delta").map((event) => event.data.delta).join("")).toBe("hello")
    const responseTextBody = responseTextEvents.at(-1)?.data.response
    expect(responseTextBody).toMatchObject({
      output: [{ type: "message", content: [{ type: "output_text", text: "hello", annotations: [{ type: "url_citation", url: "https://example.com" }] }] }],
    })
    expect(responseTextBody).not.toHaveProperty("output_text")
    expect(responseOutputText(responseTextBody)).toBe("hello")

    const chatTextStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_completion_repair_text",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "hel" },
        { type: "completion", output: [{ type: "message", content: { type: "output_text", text: "hello" } }] },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chatTextChunks = (await chatTextStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))
    expect(chatTextChunks.flatMap((chunk) => typeof chunk.choices[0].delta.content === "string" ? [chunk.choices[0].delta.content] : []).join("")).toBe("hello")

    const responsesToolStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_completion_repair_tool",
      model: "m",
      events: streamEvents([
        { type: "tool_call_delta", callId: "call_1", name: "save", argumentsDelta: "{\"x\":" },
        { type: "completion", output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{\"x\":1}" }], stopReason: "tool_use" },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const responseToolEvents = await readSse(responsesToolStream)
    expect(responseToolEvents.filter((event) => event.event === "response.function_call_arguments.delta").map((event) => event.data.delta).join("")).toBe("{\"x\":1}")
    expect(responseToolEvents.at(-1)?.data.response.output[0]).toMatchObject({ type: "function_call", call_id: "call_1", arguments: "{\"x\":1}" })

    const chatToolStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_completion_repair_tool",
      model: "m",
      events: streamEvents([
        { type: "tool_call_delta", callId: "call_1", name: "save", argumentsDelta: "{\"x\":" },
        { type: "completion", output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{\"x\":1}" }], stopReason: "tool_use" },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chatToolChunks = (await chatToolStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))
    const chatArguments = chatToolChunks.flatMap((chunk) => {
      const toolCall = chunk.choices[0].delta.tool_calls?.[0]
      return typeof toolCall?.function?.arguments === "string" ? [toolCall.function.arguments] : []
    }).join("")
    expect(chatArguments).toBe("{\"x\":1}")
  })

  test("emits completion output messages after reasoning-only stream state", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_completion_after_reasoning",
      model: "m",
      events: streamEvents([
        { type: "thinking_delta", text: "plan" },
        {
          type: "completion",
          output: [{ type: "message", id: "msg_1", role: "assistant", content: { type: "output_text", text: "answer" } }],
          stopReason: "end_turn",
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    const completed = events.at(-1)?.data.response

    expect(completed.output.map((item: any) => item.type)).toEqual(["reasoning", "message"])
    expect(responseOutputText(completed)).toBe("answer")
  })

  test("emits message item completions after reasoning or tool state", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_message_item_after_reasoning",
      model: "m",
      events: streamEvents([
        { type: "thinking_delta", text: "plan" },
        {
          type: "message_item_done",
          item: { type: "message", id: "msg_1", role: "assistant", content: { type: "output_text", text: "answer" } },
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const responseEvents = await readSse(responsesStream)
    const completed = responseEvents.at(-1)?.data.response

    expect(completed.output.map((item: any) => item.type)).toEqual(["reasoning", "message"])
    expect(responseOutputText(completed)).toBe("answer")

    const chatStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_message_item_after_tool",
      model: "m",
      events: streamEvents([
        { type: "tool_call_done", callId: "call_1", name: "save", arguments: "{}" },
        {
          type: "message_item_done",
          item: { type: "message", id: "msg_1", role: "assistant", content: { type: "output_text", text: "after" } },
        },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chunks = (await chatStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))
    const text = chunks.flatMap((chunk) => typeof chunk.choices[0].delta.content === "string" ? [chunk.choices[0].delta.content] : []).join("")

    expect(text).toBe("after")
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "tool_calls" }] })
  })

  test("emits message item completions after prior Responses text and tool items", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_message_item_after_text_tool",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "before" },
        {
          type: "message_item_done",
          item: { type: "message", id: "msg_before", role: "assistant", content: { type: "output_text", text: "before" } },
        },
        { type: "tool_call_done", callId: "call_1", name: "save", arguments: "{}" },
        {
          type: "message_item_done",
          item: { type: "message", id: "msg_after", role: "assistant", content: { type: "output_text", text: "after" } },
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    const completed = events.at(-1)?.data.response

    expect(completed.output.map((item: any) => item.type)).toEqual(["message", "function_call", "message"])
    expect(completed.output[2].id).toBe("msg_after")
    expect(responseOutputText(completed)).toBe("beforeafter")
  })

  test("closes Responses message item completions before later message items", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_consecutive_message_items",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "one" },
        {
          type: "message_item_done",
          item: { type: "message", id: "msg_one", role: "assistant", content: { type: "output_text", text: "one" } },
        },
        {
          type: "message_item_done",
          item: { type: "message", id: "msg_two", role: "assistant", content: { type: "output_text", text: "two" } },
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    const messageDoneText = events
      .filter((event) => event.event === "response.output_item.done" && event.data.item?.type === "message")
      .map((event) => event.data.item.content.map((part: any) => part.text).join(""))
    const completed = events.at(-1)?.data.response

    expect(messageDoneText).toEqual(["one", "two"])
    expect(completed.output.map((item: any) => item.content.map((part: any) => part.text).join(""))).toEqual(["one", "two"])
    expect(responseOutputText(completed)).toBe("onetwo")
  })

  test("keeps Chat message item completions from duplicating streamed text across items", async () => {
    const chatStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_consecutive_message_items",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "before" },
        {
          type: "message_item_done",
          item: { type: "message", id: "msg_before", role: "assistant", content: { type: "output_text", text: "before" } },
        },
        { type: "text_delta", delta: "after" },
        {
          type: "message_item_done",
          item: { type: "message", id: "msg_after", role: "assistant", content: { type: "output_text", text: "after" } },
        },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chunks = (await chatStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))
    const deltas = chunks.flatMap((chunk) => typeof chunk.choices[0].delta.content === "string" ? [chunk.choices[0].delta.content] : [])

    expect(deltas).toEqual(["before", "after"])
    expect(deltas.join("")).toBe("beforeafter")
  })

  test("keeps final Responses completion order when an unstreamed tool belongs between streamed messages", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_completion_unstreamed_tool_between_messages",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "before" },
        {
          type: "message_item_done",
          item: { type: "message", id: "msg_before_stream", role: "assistant", content: { type: "output_text", text: "before" } },
        },
        { type: "text_delta", delta: "after" },
        {
          type: "message_item_done",
          item: { type: "message", id: "msg_after_stream", role: "assistant", content: { type: "output_text", text: "after" } },
        },
        {
          type: "completion",
          output: [
            { type: "message", id: "msg_before", role: "assistant", content: { type: "output_text", text: "before" } },
            { type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{}" },
            { type: "message", id: "msg_after", role: "assistant", content: { type: "output_text", text: "after" } },
          ],
          stopReason: "tool_use",
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    const completed = events.at(-1)?.data.response

    expect(completed.output.map((item: any) => item.id)).toEqual(["msg_before", "fc_1", "msg_after"])
    expect(completed.output.map((item: any) => item.type)).toEqual(["message", "function_call", "message"])
    expect(responseOutputText(completed)).toBe("beforeafter")
  })

  test("uses function call item completions to close partial streamed tools", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_tool_item_done",
      model: "m",
      events: streamEvents([
        { type: "tool_call_delta", callId: "call_1", name: "unknown", argumentsDelta: "{\"x\":" },
        {
          type: "message_item_done",
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{\"x\":1}" },
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const responseEvents = await readSse(responsesStream)
    const argumentEvents = responseEvents
      .filter((event) => event.event === "response.function_call_arguments.delta")
      .map((event) => event.data.delta)
      .join("")
    const doneEvent = responseEvents.find((event) => event.event === "response.function_call_arguments.done")
    const completed = responseEvents.at(-1)?.data.response

    expect(argumentEvents).toBe("{\"x\":1}")
    expect(doneEvent?.data.arguments).toBe("{\"x\":1}")
    expect(completed.output[0]).toMatchObject({ type: "function_call", call_id: "call_1", name: "save", arguments: "{\"x\":1}" })

    const chatStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_tool_item_done",
      model: "m",
      events: streamEvents([
        { type: "tool_call_delta", callId: "call_1", name: "unknown", argumentsDelta: "{\"x\":" },
        {
          type: "message_item_done",
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{\"x\":1}" },
        },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chunks = (await chatStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))
    const args = chunks.flatMap((chunk) => {
      const toolCall = chunk.choices[0].delta.tool_calls?.[0]
      return typeof toolCall?.function?.arguments === "string" ? [toolCall.function.arguments] : []
    }).join("")
    const toolNames = chunks.flatMap((chunk) => {
      const toolCall = chunk.choices[0].delta.tool_calls?.[0]
      return typeof toolCall?.function?.name === "string" ? [toolCall.function.name] : []
    })

    expect(args).toBe("{\"x\":1}")
    expect(toolNames.at(-1)).toBe("save")
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "tool_calls" }] })
  })

  test("uses late function call item completions to repair completed Responses tool items", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_late_tool_item_done",
      model: "m",
      events: streamEvents([
        { type: "tool_call_delta", callId: "call_1", name: "unknown", argumentsDelta: "{}" },
        { type: "tool_call_done", callId: "call_1", name: "unknown", arguments: "{}" },
        {
          type: "message_item_done",
          item: { type: "function_call", id: "fc_final", call_id: "call_1", name: "save", arguments: "{}" },
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const responseEvents = await readSse(responsesStream)
    const completed = responseEvents.at(-1)?.data.response

    expect(completed.output[0]).toMatchObject({
      id: "fc_final",
      type: "function_call",
      call_id: "call_1",
      name: "save",
      arguments: "{}",
    })
  })

  test("uses completion output as final Responses output override after streamed items", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_completion_override",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "before" },
        { type: "tool_call_done", callId: "call_1", name: "save", arguments: "{\"x\":0}" },
        {
          type: "completion",
          output: [
            { type: "message", id: "msg_before", role: "assistant", content: { type: "output_text", text: "before" } },
            { type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{\"x\":1}" },
            { type: "message", id: "msg_after", role: "assistant", content: { type: "output_text", text: "after" } },
          ],
          stopReason: "tool_use",
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    const completed = events.at(-1)?.data.response

    expect(completed.output.map((item: any) => item.id)).toEqual(["msg_before", "fc_1", "msg_after"])
    expect(completed.output[1]).toMatchObject({ type: "function_call", arguments: "{\"x\":1}" })
    expect(responseOutputText(completed)).toBe("beforeafter")
  })

  test("keeps stream-only output item order when merging completion output", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_completion_order",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "answer" },
        {
          type: "server_tool_block",
          blocks: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "q" } }],
        },
        {
          type: "completion",
          output: [{ type: "message", id: "msg_final", role: "assistant", content: { type: "output_text", text: "answer" } }],
          stopReason: "end_turn",
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    const completed = events.at(-1)?.data.response

    expect(completed.output.map((item: any) => item.type)).toEqual(["message", "server_tool_use"])
    expect(completed.output[0].id).toBe("msg_final")
    expect(responseOutputText(completed)).toBe("answer")
  })

  test("streams completion output fallbacks in item order after partial text", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_completion_interleaved_order",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "before" },
        {
          type: "completion",
          output: [
            { type: "message", id: "msg_before", role: "assistant", content: { type: "output_text", text: "before" } },
            { type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{}" },
            { type: "message", id: "msg_after", role: "assistant", content: { type: "output_text", text: "after" } },
          ],
          stopReason: "tool_use",
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    const doneItems = events
      .filter((event) => event.event === "response.output_item.done")
      .map((event) => event.data.item)
    const textDeltas = events
      .filter((event) => event.event === "response.output_text.delta")
      .map((event) => event.data.delta)

    expect(doneItems.map((item: any) => item.type)).toEqual(["message", "function_call", "message"])
    expect(doneItems[1].id).toBe("fc_1")
    expect(doneItems[2].id).toBe("msg_after")
    expect(textDeltas).toEqual(["before", "after"])
    expect(events.at(-1)?.data.response.output.map((item: any) => item.id)).toEqual(["msg_before", "fc_1", "msg_after"])
  })

  test("keeps Chat stream message/tool/message order for item and completion fallbacks", async () => {
    const itemStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_item_interleaved_order",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "before" },
        {
          type: "message_item_done",
          item: { type: "message", id: "msg_before", role: "assistant", content: { type: "output_text", text: "before" } },
        },
        { type: "tool_call_done", callId: "call_1", name: "save", arguments: "{}" },
        {
          type: "message_item_done",
          item: { type: "message", id: "msg_after", role: "assistant", content: { type: "output_text", text: "after" } },
        },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const itemChunks = (await itemStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))
    const itemSequence = itemChunks.flatMap((chunk) => {
      const delta = chunk.choices[0].delta
      if (typeof delta.content === "string") return [`text:${delta.content}`]
      if (delta.tool_calls?.length) return ["tool"]
      return []
    })

    expect(itemSequence).toEqual(["text:before", "tool", "text:after"])

    const completionStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_completion_interleaved_order",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "before" },
        {
          type: "completion",
          output: [
            { type: "message", id: "msg_before", role: "assistant", content: { type: "output_text", text: "before" } },
            { type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{}" },
            { type: "message", id: "msg_after", role: "assistant", content: { type: "output_text", text: "after" } },
          ],
          stopReason: "tool_use",
        },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const completionChunks = (await completionStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))
    const completionSequence = completionChunks.flatMap((chunk) => {
      const delta = chunk.choices[0].delta
      if (typeof delta.content === "string") return [`text:${delta.content}`]
      if (delta.tool_calls?.length) return ["tool"]
      return []
    })

    expect(completionSequence).toEqual(["text:before", "tool", "text:after"])
  })

  test("repairs Chat stream text suffixes from message item completions", async () => {
    const chatStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_message_done_suffix",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "hel" },
        {
          type: "message_item_done",
          item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
        },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chunks = (await chatStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))
    const text = chunks.flatMap((chunk) => typeof chunk.choices[0].delta.content === "string" ? [chunk.choices[0].delta.content] : []).join("")

    expect(text).toBe("hello")
  })

  test("normalizes canonical completion output blocks in stream fallbacks", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_canonical_completion_output",
      model: "m",
      events: streamEvents([
        {
          type: "completion",
          output: [
            { type: "thinking", thinking: "plan", signature: "sig_1" },
            { type: "text", text: "hello " },
            { type: "message", id: "msg_wire", role: "assistant", content: [{ type: "output_text", text: "wire" }] },
            { type: "tool_call", id: "fc_1", callId: "call_1", name: "save", arguments: "{}" },
          ],
          usage: { inputTokens: 1, outputTokens: 2 },
          stopReason: "tool_use",
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const responseEvents = await readSse(responsesStream)
    const completed = responseEvents.at(-1)?.data.response
    expect(completed.output.map((item: any) => item.type)).toEqual(["reasoning", "message", "message", "function_call"])
    expect(responseOutputText(completed)).toBe("hello wire")
    expect(completed.output[3]).toMatchObject({ type: "function_call", call_id: "call_1", name: "save", arguments: "{}" })

    const chatStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_canonical_completion_output",
      model: "m",
      events: streamEvents([
        {
          type: "completion",
          output: [
            { type: "text", text: "hello " },
            { type: "message", id: "msg_wire", role: "assistant", content: [{ type: "output_text", text: "wire" }] },
            { type: "tool_call", id: "fc_1", callId: "call_1", name: "save", arguments: "{}" },
          ],
          usage: { inputTokens: 1, outputTokens: 2 },
          stopReason: "tool_use",
        },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chunks = (await chatStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))
    const text = chunks.flatMap((chunk) => typeof chunk.choices[0].delta.content === "string" ? [chunk.choices[0].delta.content] : []).join("")
    const args = chunks.flatMap((chunk) => {
      const toolCall = chunk.choices[0].delta.tool_calls?.[0]
      return typeof toolCall?.function?.arguments === "string" ? [toolCall.function.arguments] : []
    }).join("")

    expect(text).toBe("hello wire")
    expect(args).toBe("{}")
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "tool_calls" }] })
  })

  test("emits Responses stream events for server tool blocks", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_server_tools",
      model: "m",
      events: streamEvents([
        {
          type: "server_tool_block",
          blocks: [
            { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "q" } },
            { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://example.com" }] },
          ],
        },
        { type: "text_delta", delta: "done" },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    const added = events.filter((event) => event.event === "response.output_item.added")
    const done = events.filter((event) => event.event === "response.output_item.done")
    const completed = events.at(-1)?.data.response

    expect(added.map((event) => [event.data.output_index, event.data.item.type, event.data.item.status])).toEqual([
      [0, "server_tool_use", "in_progress"],
      [1, "web_search_tool_result", "in_progress"],
      [2, "message", "in_progress"],
    ])
    expect(done.map((event) => [event.data.output_index, event.data.item.type, event.data.item.status])).toEqual([
      [0, "server_tool_use", "completed"],
      [1, "web_search_tool_result", "completed"],
      [2, "message", "completed"],
    ])
    expect(completed.output.map((item: any) => item.type)).toEqual(["server_tool_use", "web_search_tool_result", "message"])
    expect(responseOutputText(completed)).toBe("done")
  })

  test("preserves reasoning and annotations from Responses stream item completions", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_reasoning_stream",
      model: "m",
      events: streamEvents([
        { type: "thinking_delta", text: "plan" },
        { type: "thinking_signature", signature: "sig_1" },
        { type: "text_delta", delta: "hel" },
        {
          type: "message_item_done",
          item: {
            type: "message",
            id: "msg_done",
            role: "assistant",
            content: [{ type: "output_text", text: "hello", annotations: [{ type: "url_citation", url: "https://example.com" }] }],
          },
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    const completed = events.at(-1)?.data.response

    expect(completed.output.map((item: any) => item.type)).toEqual(["reasoning", "message"])
    expect(completed.output[0]).toMatchObject({ type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] })
    expect(completed.output[1].content[0]).toEqual({
      type: "output_text",
      text: "hello",
      annotations: [{ type: "url_citation", url: "https://example.com" }],
    })
    expect(responseOutputText(completed)).toBe("hello")
  })

  test("keeps Responses streamed message done parts consistent with emitted content part", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_message_done_parts",
      model: "m",
      events: streamEvents([
        { type: "text_delta", delta: "hel" },
        {
          type: "message_item_done",
          item: {
            type: "message",
            id: "msg_done",
            role: "assistant",
            content: [
              { type: "output_text", text: "hello", annotations: [{ type: "url_citation", url: "https://a.example" }] },
              { type: "output_text", text: " world", annotations: [{ type: "url_citation", url: "https://b.example" }] },
            ],
          },
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const events = await readSse(responsesStream)
    const outputTextDone = events.find((event) => event.event === "response.output_text.done")
    const contentPartDone = events.find((event) => event.event === "response.content_part.done")
    const completed = events.at(-1)?.data.response

    expect(outputTextDone?.data.text).toBe("hello world")
    expect(contentPartDone?.data.part).toEqual({
      type: "output_text",
      text: "hello world",
      annotations: [
        { type: "url_citation", url: "https://a.example" },
        { type: "url_citation", url: "https://b.example" },
      ],
    })
    expect(completed.output).toEqual([{
      id: expect.any(String),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [contentPartDone?.data.part],
    }])
    expect(responseOutputText(completed)).toBe("hello world")
  })

  test("honors completion incompleteReason in Responses and Chat streams", async () => {
    const responsesStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_incomplete_stream",
      model: "m",
      events: streamEvents([
        {
          type: "completion",
          output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "partial" }] }],
          usage: { inputTokens: 1, outputTokens: 2 },
          incompleteReason: "max_output_tokens",
        },
      ]),
    }, "/v1/responses", { model: "m", input: "hi" })

    const responseEvents = await readSse(responsesStream)
    const responseBody = responseEvents.at(-1)?.data.response
    expect(responseBody).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    })
    expect(responseBody).not.toHaveProperty("output_text")
    expect(responseOutputText(responseBody)).toBe("partial")

    const chatStream = openAICanonicalStreamResponse({
      type: "canonical_stream",
      status: 200,
      id: "resp_chat_incomplete_stream",
      model: "m",
      events: streamEvents([
        {
          type: "completion",
          output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "partial" }] }],
          usage: { inputTokens: 1, outputTokens: 2 },
          incompleteReason: "max_output_tokens",
        },
      ]),
    }, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })

    const chunks = (await chatStream.text())
      .trim()
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk))

    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "length" }] })
  })
})

function streamEvents(events: any[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
    },
  }
}

function responseOutputText(response: any) {
  return (response?.output ?? [])
    .flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
    .flatMap((part: any) => part?.type === "output_text" && typeof part.text === "string" ? [part.text] : [])
    .join("")
}
