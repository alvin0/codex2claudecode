import { describe, expect, test } from "bun:test"

import { claudeToResponsesBody, estimateClaudeInputTokens } from "../src/claude/convert"
import { claudeErrorResponse } from "../src/claude/errors"
import { handleClaudeCountTokens, handleClaudeMessages } from "../src/claude/handlers"
import { collectClaudeMessage, claudeStreamResponse } from "../src/claude/response"
import { consumeCodexSse, parseJsonObject, parseSseJson } from "../src/claude/sse"
import {
  claudeWebResultHasContent,
  codexMessageContentToClaudeBlocks,
  codexOutputItemsToClaudeContent,
  codexWebCallToClaudeBlocks,
  countCodexWebCalls,
} from "../src/claude/web"
import { readSse, sse } from "./helpers"

function responseFromEvents(events: unknown[]) {
  return new Response(sse(events), { headers: { "content-type": "text/event-stream" } })
}

describe("Claude request conversion", () => {
  test("maps Claude messages, tools, images, documents, and tool choices to Responses payloads", () => {
    const body = claudeToResponsesBody({
      model: "gpt-5.4-mini",
      system: [{ type: "text", text: "sys" }, "raw", { type: "ignored" }],
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "answer" },
            { type: "tool_use", id: "call_1", name: "do_it", input: { x: 1 } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "done" }] }] },
        { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }] },
        { role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }] },
        {
          role: "user",
          content: [
            {
              type: "document",
              title: "CV_260079_NGO MINH PHUONG.pdf",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "JVBERi0xLjcNCg==",
              },
            },
          ],
        },
      ],
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 8, allowed_domains: ["example.com"], user_location: { city: "Hanoi", ignored: "x" } },
        { type: "web_fetch_20260209", name: "web_fetch" },
        { name: "custom", description: "desc", input_schema: { type: "object", properties: { x: { type: "number" } } } },
      ],
      tool_choice: { type: "tool", name: "web_search" },
    })

    expect(body.instructions).toContain("sys\n\nraw")
    expect(body.instructions).toContain("When web search is available")
    expect(body.tools).toEqual([
      { type: "web_search", filters: { allowed_domains: ["example.com"] }, user_location: { type: "approximate", approximate: { city: "Hanoi" } } },
      { type: "function", name: "custom", description: "desc", parameters: { type: "object", properties: { x: { type: "number" } } }, strict: false },
    ])
    expect(body.tool_choice).toEqual({ type: "web_search" })
    expect(body.include).toEqual(["web_search_call.action.sources"])
    expect(JSON.stringify(body.input)).toContain("data:image/png;base64,abc")
    expect(JSON.stringify(body.input)).toContain("\"type\":\"input_file\"")
    expect(JSON.stringify(body.input)).toContain("data:application/pdf;base64,JVBERi0xLjcNCg==")
    expect(JSON.stringify(body.input)).toContain("CV_260079_NGO MINH PHUONG.pdf")
    expect(JSON.stringify(body.input)).toContain("function_call_output")

    expect(claudeToResponsesBody({ model: "m", system: { object: true }, messages: [{ role: "user", content: { odd: true } }], tool_choice: { type: "any" } }).tool_choice).toBe(
      "required",
    )
    expect(claudeToResponsesBody({ model: "m", messages: [], tools: [{ name: "plain" }], tool_choice: { type: "tool", name: "plain" } }).tool_choice).toEqual({
      type: "function",
      name: "plain",
    })
    expect(claudeToResponsesBody({ model: "m", messages: [], tool_choice: { type: "auto" } }).tool_choice).toBe("auto")

    const edge = claudeToResponsesBody({
      model: "m",
      messages: [
        { role: "assistant", content: ["str", null, { type: "unknown" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: { complex: true } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_2", content: [{ type: "json", value: 1 }] }] },
      ],
    })
    expect(JSON.stringify(edge.input)).toContain("str")
    expect(JSON.stringify(edge.input)).toContain('\\"complex\\":true')
  })

  test("estimates tokens from text, tool schema, objects, and tool results", () => {
    expect(
      estimateClaudeInputTokens({
        model: "m",
        system: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "tool_result", content: ["ok", { type: "text", text: "nested" }, null] }, {}] }],
        tools: [{ name: "tool", description: "desc", input_schema: { type: "object" } }],
      }),
    ).toBeGreaterThan(1)
  })

  test("filters Claude Code billing and CLI system banners from Responses instructions", () => {
    const body = claudeToResponsesBody({
      model: "m",
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.114.45a; cc_entrypoint=cli; cch=64fe7;" },
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text", text: "\nYou are an interactive agent that helps users with software engineering tasks." },
      ],
      messages: [{ role: "user", content: "hi" }],
    })

    expect(body.instructions).not.toContain("x-anthropic-billing-header:")
    expect(body.instructions).not.toContain("You are Claude Code, Anthropic's official CLI for Claude.")
    expect(body.instructions).toContain("You are an interactive agent that helps users with software engineering tasks.")
  })

  test("maps Claude output_config effort into Responses reasoning_effort", () => {
    const body = claudeToResponsesBody({
      model: "gpt-5.4-mini",
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: "hi" }],
    })

    expect(body.reasoning_effort).toBe("medium")
  })

  test("maps Claude structured outputs into Responses text.format and preserves strict tools", () => {
    const body = claudeToResponsesBody({
      model: "gpt-5.4-mini",
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            title: "contact info",
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
            },
            required: ["name", "email"],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "save_contact", strict: true, input_schema: { type: "object", properties: { id: { type: "string" } } } }],
    })

    expect(body.text).toEqual({
      format: {
        type: "json_schema",
        name: "contact_info",
        schema: {
          title: "contact info",
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
          },
          required: ["name", "email"],
          additionalProperties: false,
        },
        strict: true,
      },
    })
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "save_contact",
        description: undefined,
        parameters: { type: "object", properties: { id: { type: "string" } } },
        strict: true,
      },
    ])
  })
})

describe("Claude web result mapping", () => {
  test("maps search, API, fetch, citations, and empty cases", () => {
    const search = codexWebCallToClaudeBlocks({
      id: "ws_1",
      action: {
        type: "search",
        query: "finance: BTC",
        sources: [
          { type: "api", name: "oai-finance" },
          { type: "url", url: "https://example.com", title: "Example" },
          { type: "unknown" },
        ],
      },
    })
    expect(search.id).toBe("srvtoolu_ws1")
    expect(search.content[1]).toMatchObject({ type: "web_search_tool_result" })
    expect((search.content[1] as any).content).toHaveLength(2)
    expect((search.content[1] as any).content[0].url).toBe("https://www.google.com/finance/quote/BTC-USD")
    expect(claudeWebResultHasContent(search.content[1])).toBe(true)

    const fallback = codexWebCallToClaudeBlocks({ id: "srvtoolu_existing", action: { type: "search", queries: ["a", "b"] } }, [
      { url: "https://fallback", title: "Fallback", encrypted_content: "" },
    ])
    expect(fallback.id).toBe("srvtoolu_existing")
    expect((fallback.input as any).query).toBe("a\nb")
    expect((fallback.content[1] as any).content[0].url).toBe("https://fallback")

    const fetch = codexWebCallToClaudeBlocks({ id: "fetch", action: { type: "open_page", url: "https://example.com", title: "Page" } })
    expect(fetch.name).toBe("web_fetch")
    expect(claudeWebResultHasContent(fetch.content[1])).toBe(false)
    expect(claudeWebResultHasContent({ type: "web_fetch_tool_result", content: { content: { source: { data: "page" } } } })).toBe(true)
    expect(claudeWebResultHasContent({ type: "other" })).toBe(false)

    const output = [
      { type: "web_search_call", id: "ws", action: { type: "search" } },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "hello world",
            annotations: [{ type: "url_citation", url: "https://source", title: "Source", start_index: 0, end_index: 5 }],
          },
        ],
      },
      { type: "web_search_call", id: "page", action: { type: "open_page", url: "https://page" } },
      { type: "ignored" },
    ]
    const content = codexOutputItemsToClaudeContent(output)
    expect(content.some((block) => block.type === "web_search_tool_result")).toBe(true)
    expect(content.some((block) => block.type === "text")).toBe(true)
    expect((content.find((block) => block.type === "text") as any).citations[0]).toMatchObject({ cited_text: "hello", encrypted_index: "" })
    expect(countCodexWebCalls(output)).toEqual({ webSearchRequests: 1, webFetchRequests: 1 })
    expect(codexOutputItemsToClaudeContent("bad")).toEqual([])
    expect(codexMessageContentToClaudeBlocks({ type: "nope" })).toEqual([])
  })
})

describe("SSE and Claude response mapping", () => {
  test("parses SSE streams and invalid JSON safely", async () => {
    const events: any[] = []
    await consumeCodexSse(new Response("event: one\ndata: {\"a\":1}\n\ndata: {\"b\":2}\n\n").body, (event) => events.push(event))
    await consumeCodexSse(null, () => events.push("never"))
    expect(events).toHaveLength(2)
    expect(parseSseJson(events[0])).toEqual({ a: 1 })
    expect(parseSseJson({ data: "bad" })).toBeUndefined()
    expect(parseJsonObject("{\"ok\":true}")).toEqual({ ok: true })
    expect(parseJsonObject("bad")).toEqual({})
  })

  test("collects non-streaming Claude messages from Codex SSE", async () => {
    const response = responseFromEvents([
      { type: "response.created", response: { id: "resp_1", model: "gpt" } },
      { type: "response.output_text.delta", delta: "hel" },
      { type: "response.output_text.done", text: "hello" },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call", name: "tool", arguments: "{\"x\":1}" } },
      { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 4 }, incomplete_details: { reason: "max_output_tokens" } } },
    ])
    const message = await collectClaudeMessage(response, { model: "m", messages: [] })
    expect(message).toMatchObject({
      id: "msg_1",
      model: "gpt",
      stop_reason: "max_tokens",
      usage: { input_tokens: 3, output_tokens: 4 },
    })
    expect((message as any).content.some((item: any) => item.type === "tool_use")).toBe(true)
  })

  test("collects web calls, message output items, and completed output overrides", async () => {
    const response = responseFromEvents([
      { type: "response.output_item.done", item: { type: "web_search_call", id: "ws", action: { type: "search", query: "q", sources: [{ type: "url", url: "https://a" }] } } },
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "from item" }] } },
      {
        type: "response.completed",
        response: {
          output: [
            { type: "web_search_call", id: "ws2", action: { type: "open_page", url: "https://page" } },
            { type: "message", content: [{ type: "output_text", text: "from completed" }] },
          ],
          usage: { input_tokens: 5, output_tokens: 6 },
        },
      },
    ])
    const message = await collectClaudeMessage(response, { model: "m", messages: [] })
    expect((message as any).content.some((item: any) => item.text === "from completed")).toBe(true)
    expect((message as any).usage.server_tool_use.web_fetch_requests).toBe(1)
  })

  test("streams text, function calls, immediate web results, deferred web results, and empty streams", async () => {
    const textEvents = await readSse(
      claudeStreamResponse(
        responseFromEvents([
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.output_item.done", item: { type: "function_call", call_id: "call", name: "tool", arguments: "{\"x\":1}" } },
          { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
        ]),
        { model: "m", messages: [], stream: true },
      ),
    )
    expect(textEvents.some((event) => event.data.type === "message_stop")).toBe(true)
    expect(textEvents.some((event) => event.data.content_block?.type === "tool_use")).toBe(true)

    const webEvents = await readSse(
      claudeStreamResponse(
        responseFromEvents([
          { type: "response.output_text.delta", delta: "intro" },
          { type: "response.output_item.done", item: { type: "web_search_call", id: "ws", action: { type: "search", query: "q", sources: [{ type: "url", url: "https://a" }] } } },
          { type: "response.completed", response: { usage: { output_tokens: 5 } } },
        ]),
        { model: "m", messages: [], stream: true },
      ),
    )
    expect(webEvents.some((event) => event.data.content_block?.type === "web_search_tool_result")).toBe(true)

    const deferredEvents = await readSse(
      claudeStreamResponse(
        responseFromEvents([
          { type: "response.output_item.done", item: { type: "web_search_call", id: "ws", action: { type: "search", query: "q" } } },
          { type: "response.output_text.delta", delta: "deferred" },
          {
            type: "response.completed",
            response: {
              output: [
                { type: "web_search_call", id: "ws", action: { type: "search" } },
                { type: "message", content: [{ type: "output_text", text: "final", annotations: [{ type: "url_citation", url: "https://a" }] }] },
              ],
              usage: { output_tokens: 6 },
            },
          },
        ]),
        { model: "m", messages: [], stream: true },
      ),
    )
    expect(deferredEvents.some((event) => event.data.content_block?.type === "web_search_tool_result")).toBe(true)
    expect(deferredEvents.some((event) => event.data.delta?.text === "final")).toBe(true)

    const emptyEvents = await readSse(claudeStreamResponse(responseFromEvents([]), { model: "m", messages: [], stream: true }))
    expect(emptyEvents.some((event) => event.data.type === "message_start")).toBe(true)
    expect(emptyEvents.some((event) => event.data.type === "message_stop")).toBe(true)
  })

  test("formats Claude error responses", async () => {
    expect(await claudeErrorResponse("bad", 400).json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "bad" } })
    expect(await claudeErrorResponse("no", 500).json()).toEqual({ type: "error", error: { type: "api_error", message: "no" } })
  })

  test("handles Claude endpoint errors and successes", async () => {
    const okClient = {
      proxy: () => Promise.resolve(responseFromEvents([{ type: "response.output_text.done", text: "ok" }, { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }])),
    }
    const nonStream = await handleClaudeMessages(okClient as any, new Request("http://x", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) }), "id", true)
    expect(await nonStream.json()).toMatchObject({ content: [{ type: "text", text: "ok" }] })

    const stream = await handleClaudeMessages(
      okClient as any,
      new Request("http://x", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true }) }),
      "id",
    )
    expect((await readSse(stream)).some((event) => event.data.type === "message_stop")).toBe(true)

    const badUpstream = { proxy: () => Promise.resolve(new Response("bad", { status: 503 })) }
    const upstream = await handleClaudeMessages(badUpstream as any, new Request("http://x", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) }), "id")
    expect(upstream.status).toBe(503)

    expect((await handleClaudeMessages(okClient as any, new Request("http://x", { method: "POST", body: "{" }), "id")).status).toBe(400)
    expect((await handleClaudeMessages(okClient as any, new Request("http://x", { method: "POST", body: JSON.stringify({ model: "m" }) }), "id")).status).toBe(400)
    expect((await handleClaudeCountTokens(new Request("http://x", { method: "POST", body: "{" }))).status).toBe(400)
    expect((await handleClaudeCountTokens(new Request("http://x", { method: "POST", body: JSON.stringify({}) }))).status).toBe(400)
  })
})
