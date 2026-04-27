import { describe, expect, test } from "bun:test"

import type { Canonical_Response } from "../../src/core/canonical"
import type { Upstream_Provider } from "../../src/core/interfaces"
import { Claude_Inbound_Provider } from "../../src/inbound/claude"
import { Claude_Codex_Inbound_Adapter } from "../../src/inbound/claude/codex"
import { Claude_Kiro_Inbound_Adapter } from "../../src/inbound/claude/kiro"
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

  test("keeps Claude Code WebFetch and WebSearch as client tools", () => {
    const request = claudeToCanonicalRequest({
      model: "claude-haiku-4.5",
      messages: [{ role: "user", content: "read https://example.com/article" }],
      tools: [
        { name: "WebFetch", description: "Fetch a URL", input_schema: { type: "object", required: ["url", "prompt"] } },
        { name: "WebSearch", description: "Search the web", input_schema: { type: "object", required: ["query"] } },
        { name: "Read", input_schema: { type: "object", required: ["file_path"] } },
      ],
      tool_choice: { type: "tool", name: "WebFetch" },
    })

    expect(request.tools).toEqual([
      { type: "function", name: "WebFetch", description: "Fetch a URL", parameters: { type: "object", required: ["url", "prompt"] }, strict: false },
      { type: "function", name: "WebSearch", description: "Search the web", parameters: { type: "object", required: ["query"] }, strict: false },
      { type: "function", name: "Read", description: undefined, parameters: { type: "object", required: ["file_path"] }, strict: false },
    ])
    expect(request.toolChoice).toEqual({ type: "function", name: "WebFetch" })
    expect(request.metadata.claudeClientWebSearchToolName).toBe("WebSearch")
  })

  test("maps native Claude web_search server tools to server web search", () => {
    const request = claudeToCanonicalRequest({
      model: "claude-haiku-4.5",
      messages: [{ role: "user", content: "search current docs" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 } as any],
      tool_choice: { type: "tool", name: "web_search" },
    })

    expect(request.instructions).toContain("When web search is available")
    expect(request.tools).toEqual([{ type: "web_search" }])
    expect(request.toolChoice).toEqual({ type: "web_search" })
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
            yield { type: "server_tool_block", blocks: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "q" } }, { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] }] } as const
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
    expect(events.some((event) => event.data.content_block?.type === "server_tool_use" && JSON.stringify(event.data.content_block.input) === "{}")).toBe(true)
    expect(events.some((event) => event.data.delta?.type === "input_json_delta" && event.data.delta.partial_json === "{\"query\":\"q\"}")).toBe(true)
    expect(events.some((event) => event.data.content_block?.type === "web_search_tool_result")).toBe(true)
    expect(events.some((event) => event.data.type === "message_stop")).toBe(true)
  })
})

describe("Claude model catalog and provider", () => {
  test("exposes Codex and Kiro as distinct Claude inbound adapters", () => {
    const codex = new Claude_Codex_Inbound_Adapter(async () => [])
    const kiro = new Claude_Kiro_Inbound_Adapter(async () => [])

    expect(codex.name).toBe("claude-codex")
    expect(kiro.name).toBe("claude-kiro")
    expect(codex.routes()).toEqual(kiro.routes())
  })

  test("rejects Codex/Kiro Claude adapter and upstream mismatches before proxying", async () => {
    let proxyCalls = 0
    const canonicalResponse: Canonical_Response = {
      type: "canonical_response",
      id: "resp_1",
      model: "m",
      stopReason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: { inputTokens: 1, outputTokens: 2 },
    }
    const codexUpstream = fakeUpstream("codex", async () => {
      proxyCalls += 1
      return canonicalResponse
    })
    const kiroUpstream = fakeUpstream("kiro", async () => {
      proxyCalls += 1
      return canonicalResponse
    })

    const codex = new Claude_Codex_Inbound_Adapter(async () => [])
    const kiro = new Claude_Kiro_Inbound_Adapter(async () => [])
    const route = { path: "/v1/messages", method: "POST" } as const
    const context = { requestId: "req_1", logBody: false, quiet: true }

    const wrongKiro = await kiro.handle(claudeRequest(), route, codexUpstream, context)
    const wrongCodex = await codex.handle(claudeRequest(), route, kiroUpstream, context)
    expect(wrongKiro.status).toBe(500)
    expect(wrongCodex.status).toBe(500)
    expect((await wrongKiro.json()).error.message).toContain("expected kiro upstream, received codex")
    expect((await wrongCodex.json()).error.message).toContain("expected codex upstream, received kiro")
    expect(proxyCalls).toBe(0)

    const unknownUpstream = {
      proxy: async () => {
        proxyCalls += 1
        return canonicalResponse
      },
      checkHealth: async () => ({ ok: true }),
    }
    const missingKind = await kiro.handle(claudeRequest(), route, unknownUpstream, context)
    expect(missingKind.status).toBe(500)
    expect((await missingKind.json()).error.message).toContain("expected kiro upstream, received undefined")
    expect(proxyCalls).toBe(0)

    const rightKiro = await kiro.handle(claudeRequest(), route, kiroUpstream, context)
    const rightCodex = await codex.handle(claudeRequest(), route, codexUpstream, context)
    expect(rightKiro.status).toBe(200)
    expect(rightCodex.status).toBe(200)
    expect(proxyCalls).toBe(2)
  })

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

function fakeUpstream(providerKind: "codex" | "kiro", proxy: Upstream_Provider["proxy"]): Upstream_Provider {
  return {
    providerKind,
    proxy,
    checkHealth: async () => ({ ok: true }),
  }
}

function claudeRequest() {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], stream: false }),
  })
}
