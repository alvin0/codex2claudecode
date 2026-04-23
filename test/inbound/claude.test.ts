import { describe, expect, test } from "bun:test"

import type { Canonical_Response } from "../../src/core/canonical"
import { Claude_Inbound_Provider } from "../../src/inbound/claude"
import { claudeToCanonicalRequest } from "../../src/inbound/claude/convert"
import { claudeErrorResponse } from "../../src/inbound/claude/errors"
import { Model_Catalog } from "../../src/inbound/claude/models"
import { canonicalResponseToClaudeMessage, claudeCanonicalStreamResponse } from "../../src/inbound/claude/response"
import { readSse } from "../helpers"

describe("Claude inbound translation", () => {
  test("translates Claude requests into canonical requests", () => {
    const request = claudeToCanonicalRequest({
      model: "gpt-5.4-mini",
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "save", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "save" },
    })

    expect(request).toMatchObject({
      model: "gpt-5.4-mini",
      instructions: "sys",
      passthrough: false,
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [{ type: "function", name: "save", parameters: { type: "object" }, strict: false }],
      toolChoice: { type: "function", name: "save" },
    })
  })

  test("property: randomized Claude bodies become valid canonical requests", () => {
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const messageCount = (iteration % 4) + 1
      const request = claudeToCanonicalRequest({
        model: `model-${iteration}`,
        messages: Array.from({ length: messageCount }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message-${iteration}-${index}`,
        })),
        tools: Array.from({ length: iteration % 3 }, (_, index) => ({ name: `tool_${index}` })),
      })

      expect(request.model).toBe(`model-${iteration}`)
      expect(request.input).toHaveLength(messageCount)
      expect(request.passthrough).toBe(false)
      expect(request.tools?.length ?? 0).toBe(iteration % 3)
    }
  })
})

describe("Claude response translation", () => {
  test("maps canonical responses into Claude Messages API payloads", async () => {
    const response: Canonical_Response = {
      type: "canonical_response",
      id: "resp_1",
      model: "gpt-5.4",
      stopReason: "tool_use",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_call", id: "fc_1", callId: "call_1", name: "save", arguments: "{\"ok\":true}" },
        { type: "server_tool", blocks: [{ type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://example.com", title: "Example", encrypted_content: "" }] }] },
        { type: "thinking", thinking: "Working", signature: "sig_1" },
      ],
      usage: { inputTokens: 3, outputTokens: 4, serverToolUse: { webSearchRequests: 1 } },
    }

    const message = await canonicalResponseToClaudeMessage(response, { model: "m", messages: [] })
    expect(message).toMatchObject({
      id: "msg_1",
      model: "gpt-5.4",
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 4, server_tool_use: { web_search_requests: 1 } },
    })
    expect((message as any).content.map((item: any) => item.type)).toEqual(["text", "tool_use", "web_search_tool_result", "thinking"])
  })

  test("property: canonical responses preserve key output information", async () => {
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const response: Canonical_Response = {
        type: "canonical_response",
        id: `resp_${iteration}`,
        model: `model-${iteration}`,
        stopReason: "end_turn",
        content: [
          { type: "text", text: `text-${iteration}` },
          { type: "tool_call", id: `fc_${iteration}`, callId: `call_${iteration}`, name: `tool_${iteration}`, arguments: "{\"iteration\":true}" },
          { type: "thinking", thinking: `think-${iteration}`, signature: `sig_${iteration}` },
        ],
        usage: { inputTokens: iteration + 1, outputTokens: iteration + 2 },
      }
      const message = await canonicalResponseToClaudeMessage(response, { model: "fallback", messages: [] })
      expect((message as any).id.startsWith("msg_")).toBe(true)
      expect((message as any).model).toBe(`model-${iteration}`)
      expect((message as any).content).toHaveLength(3)
      expect((message as any).usage).toMatchObject({ input_tokens: iteration + 1, output_tokens: iteration + 2 })
    }
  })

  test("translates canonical stream events into Claude SSE", async () => {
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
            yield { type: "text_delta", delta: "hello" } as const
            yield { type: "tool_call_done", callId: "call_1", name: "save", arguments: "{\"ok\":true}" } as const
            yield { type: "server_tool_block", blocks: [{ type: "web_search_tool_result", tool_use_id: "srv_1", content: [] }] } as const
            yield { type: "usage", usage: { outputTokens: 4 } } as const
            yield { type: "message_stop", stopReason: "tool_use" } as const
          },
        },
      },
      { model: "m", messages: [], stream: true },
    )

    const events = await readSse(response)
    expect(events.some((event) => event.data.type === "message_start")).toBe(true)
    expect(events.some((event) => event.data.delta?.type === "thinking_delta")).toBe(true)
    expect(events.some((event) => event.data.delta?.text === "hello")).toBe(true)
    expect(events.some((event) => event.data.content_block?.type === "tool_use")).toBe(true)
    expect(events.some((event) => event.data.content_block?.type === "web_search_tool_result")).toBe(true)
    expect(events.some((event) => event.data.type === "message_stop")).toBe(true)
  })
})

describe("Claude model catalog and provider", () => {
  test("lists all models without a resolver and filters with an injected resolver", async () => {
    const catalog = new Model_Catalog()
    const all = await catalog.listModels()
    const filtered = await catalog.listModels(async () => [all.data[0].id], { limit: 5 })

    expect(all.data.length).toBeGreaterThan(0)
    expect(filtered.data).toHaveLength(1)
    expect(catalog.resolveAlias(all.data[0].id)).toBe(all.data[0].id)
    expect(catalog.getModel(all.data[0].id)?.id).toBe(all.data[0].id)
  })

  test("handles Claude routes through the inbound provider", async () => {
    const provider = new Claude_Inbound_Provider(async () => ["gpt-5.4"])
    const canonicalResponse: Canonical_Response = {
      type: "canonical_response",
      id: "resp_1",
      model: "gpt-5.4",
      stopReason: "end_turn",
      content: [{ type: "text", text: "hello" }],
      usage: { inputTokens: 1, outputTokens: 2 },
    }
    const upstream = {
      proxy: () => Promise.resolve(canonicalResponse),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const response = await provider.handle(
      new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hello" }] }) }),
      { path: "/v1/messages", method: "POST" },
      upstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )
    expect(await response.json()).toMatchObject({ content: [{ type: "text", text: "hello" }] })

    const error = await provider.handle(
      new Request("http://localhost/v1/messages", { method: "POST", body: "{" }),
      { path: "/v1/messages", method: "POST" },
      upstream,
      { requestId: "req_2", logBody: false, quiet: true },
    )
    expect(error.status).toBe(400)

    const models = await provider.handle(
      new Request("http://localhost/v1/models", { method: "GET" }),
      { path: "/v1/models", method: "GET" },
      upstream,
      { requestId: "req_3", logBody: false, quiet: true },
    )
    expect((await models.json()).data).toHaveLength(1)
  })

  test("formats Claude error responses", async () => {
    expect(await claudeErrorResponse("bad", 400).json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "bad" } })
  })
})
