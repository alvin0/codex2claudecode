import { describe, expect, test } from "bun:test"
import { countTokens, encodeChat } from "gpt-tokenizer"

import { claudeToResponsesBody, countClaudeInputTokens } from "../src/claude/convert"
import { claudeErrorResponse } from "../src/claude/errors"
import { handleClaudeCountTokens, handleClaudeMessages } from "../src/claude/handlers"
import { collectClaudeMessage, claudeStreamResponse } from "../src/claude/response"
import { consumeCodexSse, parseJsonObject, parseSseJson } from "../src/claude/sse"
import {
  claudeWebResultHasContent,
  codexMessageContentToClaudeBlocks,
  codexOutputItemsToClaudeContent as codexWebOutputItemsToClaudeContent,
  codexWebCallToClaudeBlocks,
  countCodexWebCalls,
} from "../src/claude/web"
import { countClaudeServerToolCalls, codexOutputItemsToClaudeContent } from "../src/claude/server-tools"
import { readSse, sse } from "./helpers"

function responseFromEvents(events: unknown[]) {
  return new Response(sse(events), { headers: { "content-type": "text/event-stream" } })
}

async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for condition")
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
            {
              type: "document",
              source: {
                type: "url",
                url: "https://example.com/report.pdf",
              },
            },
            {
              type: "document",
              source: {
                type: "file",
                file_id: "file-abc123",
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
    expect(JSON.stringify(body.input)).toContain("https://example.com/report.pdf")
    expect(JSON.stringify(body.input)).toContain("file-abc123")
    expect(JSON.stringify(body.input)).toContain("function_call_output")
    expect(JSON.stringify(body.input)).toContain('"id":"fc_call1"')
    expect(JSON.stringify(body.input)).toContain('"call_id":"call_1"')

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
    expect(JSON.stringify(claudeToResponsesBody({ model: "m", messages: [{ role: "user", content: [{ type: "document", title: "doc.txt", source: { type: "text", data: "body" } }] }] }).input)).toContain(
      "Document: doc.txt\\n\\nbody",
    )
    expect(() =>
      claudeToResponsesBody({
        model: "m",
        messages: [{ role: "user", content: [{ type: "document", source: { type: "file", file_id: "file_unsupported" } }] }],
      }),
    ).toThrow("Claude Files API document source cannot be proxied")
  })

  test("handles Claude document edge cases without silent drops", () => {
    const body = claudeToResponsesBody({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "document", title: " trimmed.pdf ", source: { type: "base64", data: " data:application/pdf;base64,abc " } },
            { type: "document", source: { type: "base64", media_type: " ", data: " xyz " } },
            { type: "document", source: { type: "url", url: " https://example.com/a.pdf " } },
            { type: "document", source: { type: "file", file_id: " file-openai " } },
            { type: "document", title: "notes", source: { type: "content", content: [{ type: "text", text: "line" }, { type: "json", value: 1 }] } },
          ],
        },
      ],
    })
    const content = (body.input as any[])[0].content

    expect(content).toContainEqual({ type: "input_file", filename: "trimmed.pdf", file_data: "data:application/pdf;base64,abc" })
    expect(content).toContainEqual({ type: "input_file", filename: "document.pdf", file_data: "data:application/pdf;base64,xyz" })
    expect(content).toContainEqual({ type: "input_file", file_url: "https://example.com/a.pdf" })
    expect(content).toContainEqual({ type: "input_file", file_id: "file-openai" })
    expect(JSON.stringify(content)).toContain('Document: notes\\n\\nline\\n{\\"type\\":\\"json\\",\\"value\\":1}')

    for (const source of [
      undefined,
      { type: "base64", data: " " },
      { type: "url", url: " " },
      { type: "file", file_id: " " },
      { type: "content", content: [] },
      { type: "unknown" },
    ]) {
      expect(() =>
        claudeToResponsesBody({
          model: "m",
          messages: [{ role: "user", content: [{ type: "document", source }] }],
        }),
      ).toThrow("Claude document")
    }
  })

  test("counts Claude tokens with gpt-tokenizer chat formatting for supported models", () => {
    expect(
      countClaudeInputTokens({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toBe(encodeChat([{ role: "user", content: "hello" }], "gpt-4.1").length)
  })

  test("counts system prompts, tools, tool results, and rich content with tokenizer fallbacks", () => {
    const simple = countClaudeInputTokens({
      model: "m",
      messages: [{ role: "user", content: "hello" }],
    })

    const rich = countClaudeInputTokens({
      model: "gpt-5.4-mini_high",
      system: "system",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "tool_result", tool_use_id: "call_1", content: ["ok", { type: "text", text: "nested" }, null] },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "a".repeat(5000) } },
            { type: "document", title: "doc.txt", source: { type: "text", media_type: "text/plain", data: "document body" } },
          ],
        },
      ],
      tools: [{ name: "tool", description: "desc", input_schema: { type: "object" } }],
      output_config: { format: { type: "json_schema", schema: { type: "object", properties: { ok: { type: "boolean" } } } } },
    })

    expect(rich).toBeGreaterThan(simple)
    expect(rich).toBeGreaterThan(countTokens("hello"))
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

  test("maps MCP servers and toolsets into Responses MCP tools", () => {
    const body = claudeToResponsesBody({
      model: "gpt-5.4-mini",
      max_tokens: 123,
      temperature: 0.2,
      top_p: 0.8,
      stop_sequences: ["DONE"],
      metadata: { user_id: "u_1" },
      mcp_servers: [{ name: "shopify", url: "https://mcp.example.com", authorization_token: "secret" }],
      tools: [{ type: "mcp_toolset", mcp_server_name: "shopify", allowed_tools: ["search_products"], require_approval: "never" }],
      tool_choice: { type: "tool", name: "mcp__shopify" },
      messages: [{ role: "user", content: "hi" }],
    })

    expect(body.max_output_tokens).toBeUndefined()
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.stop).toBeUndefined()
    expect(body.metadata).toBeUndefined()
    expect(body.tools).toEqual([
      {
        type: "mcp",
        server_label: "shopify",
        server_url: "https://mcp.example.com",
        allowed_tools: ["search_products"],
        authorization: "secret",
        require_approval: "never",
      },
    ])
    expect(body.include).toEqual(["mcp_call.output", "mcp_call.approval_request_id"])
    expect(body.tool_choice).toEqual({ type: "mcp", server_label: "shopify" })
  })

  test("rejects unknown MCP server references", () => {
    expect(() =>
      claudeToResponsesBody({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "mcp_toolset", mcp_server_name: "missing" }],
      }),
    ).toThrow("Unknown MCP server: missing")
  })

  test("validates MCP server and approval configuration", () => {
    expect(() =>
      claudeToResponsesBody({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        mcp_servers: [{ name: "bad", url: "", connector_id: "" }],
        tools: [{ type: "mcp_toolset", mcp_server_name: "bad" }],
      }),
    ).toThrow("MCP server bad requires url or connector_id")

    expect(() =>
      claudeToResponsesBody({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        mcp_servers: [{ name: "shopify", connector_id: "conn_1", url: "" }],
        tools: [{ type: "mcp_toolset", mcp_server_name: "shopify", allowed_tools: ["a"], tool_names: ["b"] }],
      }),
    ).toThrow("MCP toolset shopify cannot set both allowed_tools and tool_names")

    expect(() =>
      claudeToResponsesBody({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        mcp_servers: [{ name: "shopify", connector_id: "conn_1", url: "" }],
        tools: [{ type: "mcp_toolset", mcp_server_name: "shopify", require_approval: { bad: true } as any }],
      }),
    ).toThrow("MCP toolset shopify has invalid require_approval")

    const connectorBody = claudeToResponsesBody({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      mcp_servers: [{ name: "shopify", connector_id: "conn_1", url: "", headers: { "x-test": "1" } }],
      tools: [{ type: "mcp_toolset", mcp_server_name: "shopify", tool_names: ["search_products", "search_products"], require_approval: { read_only: true, tool_names: ["search_products"] } }],
    })
    expect(bodyIncludes(connectorBody.tools, { type: "mcp", server_label: "shopify", connector_id: "conn_1", tool_names: ["search_products"] })).toBe(true)
  })
})

function bodyIncludes(items: any, expected: any) {
  return Array.isArray(items) && items.some((item) => Object.entries(expected).every(([key, value]) => JSON.stringify(item[key]) === JSON.stringify(value)))
}

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
    const content = codexWebOutputItemsToClaudeContent(output)
    expect(content.some((block) => block.type === "web_search_tool_result")).toBe(true)
    expect(content.some((block) => block.type === "text")).toBe(true)
    expect((content.find((block) => block.type === "text") as any).citations[0]).toMatchObject({ cited_text: "hello", encrypted_index: "" })
    expect(countCodexWebCalls(output)).toEqual({ webSearchRequests: 1, webFetchRequests: 1 })
    expect(codexWebOutputItemsToClaudeContent("bad")).toEqual([])
    expect(codexMessageContentToClaudeBlocks({ type: "nope" })).toEqual([])
  })

  test("maps MCP output items into Claude MCP blocks", () => {
    const content = codexOutputItemsToClaudeContent([
      {
        type: "mcp_call",
        id: "mcp_1",
        name: "search_products",
        server_label: "shopify",
        arguments: '{"query":"shoe"}',
        approval_request_id: "apr_1",
        output: [{ type: "text", text: "2 results" }],
      },
      {
        type: "mcp_list_tools",
        server_label: "shopify",
        tools: [{ name: "search_products", description: "Search products", input_schema: { type: "object" } }],
      },
    ])

    expect(content).toEqual([
      { type: "mcp_tool_use", id: "mcp_1", name: "search_products", server_name: "shopify", input: { query: "shoe" }, approval_request_id: "apr_1" },
      { type: "mcp_tool_result", tool_use_id: "mcp_1", is_error: false, content: [{ type: "text", text: "2 results" }] },
      { type: "text", text: '{"type":"mcp_list_tools","server_name":"shopify","tools":[{"name":"search_products","description":"Search products","input_schema":{"type":"object"}}]}' },
    ])
    expect(countClaudeServerToolCalls([{ type: "mcp_call" }])).toEqual({ webSearchRequests: 0, webFetchRequests: 0, mcpCalls: 1 })
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

  test("cancels the upstream SSE reader when aborted", async () => {
    const abort = new AbortController()
    let cancelReason: unknown
    const stream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelReason = reason
      },
    })

    const promise = consumeCodexSse(stream, () => undefined, { signal: abort.signal })
    await Promise.resolve()
    abort.abort("stop")
    await promise

    expect(cancelReason).toBe("stop")
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

  test("collects MCP calls into Claude MCP blocks", async () => {
    const response = responseFromEvents([
      {
        type: "response.output_item.done",
        item: { type: "mcp_call", id: "mcp_1", name: "search_products", server_label: "shopify", arguments: '{"query":"shoe"}', output: [{ type: "text", text: "2 results" }] },
      },
      { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 3 } } },
    ])
    const message = await collectClaudeMessage(response, { model: "m", messages: [] })
    expect((message as any).content.some((item: any) => item.type === "mcp_tool_use")).toBe(true)
    expect((message as any).content.some((item: any) => item.type === "mcp_tool_result")).toBe(true)
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

    const doneOnlyEvents = await readSse(
      claudeStreamResponse(
        responseFromEvents([
          { type: "response.output_text.done", text: "done only" },
          { type: "response.completed", response: { usage: { output_tokens: 2 } } },
        ]),
        { model: "m", messages: [], stream: true },
      ),
    )
    expect(doneOnlyEvents.some((event) => event.data.delta?.text === "done only")).toBe(true)

    const messageItemEvents = await readSse(
      claudeStreamResponse(
        responseFromEvents([
          { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "from item" }] } },
          { type: "response.completed", response: { usage: { output_tokens: 2 } } },
        ]),
        { model: "m", messages: [], stream: true },
      ),
    )
    expect(messageItemEvents.some((event) => event.data.delta?.text === "from item")).toBe(true)

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

    const mcpEvents = await readSse(
      claudeStreamResponse(
        responseFromEvents([
          { type: "response.output_item.done", item: { type: "mcp_call", id: "mcp_1", name: "search_products", server_label: "shopify", arguments: '{"query":"shoe"}', output: [{ type: "text", text: "2 results" }] } },
          { type: "response.completed", response: { usage: { output_tokens: 4 } } },
        ]),
        { model: "m", messages: [], stream: true },
      ),
    )
    expect(mcpEvents.some((event) => event.data.content_block?.type === "mcp_tool_use")).toBe(true)
    expect(mcpEvents.some((event) => event.data.content_block?.type === "mcp_tool_result")).toBe(true)

    const emptyEvents = await readSse(claudeStreamResponse(responseFromEvents([]), { model: "m", messages: [], stream: true }))
    expect(emptyEvents.some((event) => event.data.type === "message_start")).toBe(true)
    expect(emptyEvents.some((event) => event.data.type === "message_stop")).toBe(true)
  })

  test("streams Claude message_start immediately and keeps the SSE alive", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    let clearedHeartbeat = false

    globalThis.setInterval = ((callback: () => void) => {
      callback()
      return 1 as any
    }) as typeof setInterval
    globalThis.clearInterval = (() => {
      clearedHeartbeat = true
    }) as typeof clearInterval

    try {
      const events = await readSse(
        claudeStreamResponse(
          responseFromEvents([{ type: "response.completed", response: { usage: { output_tokens: 0 } } }]),
          { model: "m", messages: [], stream: true },
        ),
      )

      expect(events[0].data.type).toBe("message_start")
      expect(events.some((event) => event.event === "ping" && event.data.type === "ping")).toBe(true)
      expect(clearedHeartbeat).toBe(true)
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
  })

  test("cancels the upstream Claude stream when the client disconnects", async () => {
    let upstreamCancelled = false
    const response = claudeStreamResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            upstreamCancelled = true
          },
        }),
      ),
      { model: "m", messages: [], stream: true },
    )

    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("message_start")

    await reader.cancel("client done")
    await waitFor(() => upstreamCancelled)

    expect(upstreamCancelled).toBe(true)
  })

  test("ignores malformed completed events without failing Claude responses", async () => {
    const message = await collectClaudeMessage(responseFromEvents([{ type: "response.completed" }]), { model: "m", messages: [] })
    expect(message).toMatchObject({ content: [], usage: { input_tokens: 0, output_tokens: 0 } })

    const events = await readSse(claudeStreamResponse(responseFromEvents([{ type: "response.completed" }]), { model: "m", messages: [], stream: true }))
    expect(events.map((event) => event.data.type)).toContain("message_stop")
    expect(events.some((event) => event.data.type === "error")).toBe(false)
  })

  test("formats Claude error responses", async () => {
    expect(await claudeErrorResponse("bad", 400).json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "bad" } })
    expect(await claudeErrorResponse("no", 500).json()).toEqual({ type: "error", error: { type: "api_error", message: "no" } })
    expect(await claudeErrorResponse("auth", 401).json()).toEqual({ type: "error", error: { type: "authentication_error", message: "auth" } })
    expect(await claudeErrorResponse("rate", 429).json()).toEqual({ type: "error", error: { type: "rate_limit_error", message: "rate" } })
  })

  test("handles Claude endpoint errors and successes", async () => {
    const okClient = {
      proxy: () => Promise.resolve(responseFromEvents([{ type: "response.output_text.done", text: "ok" }, { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }])),
    }
    const nonStream = await handleClaudeMessages(
      okClient as any,
      new Request("http://x", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) }),
      "id",
      { logBody: true },
    )
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
    expect(await upstream.json()).toEqual({ type: "error", error: { type: "api_error", message: "Codex request failed: 503 bad" } })

    const throwingClient = { proxy: () => Promise.reject(new Error("network down")) }
    const thrown = await handleClaudeMessages(throwingClient as any, new Request("http://x", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) }), "id")
    expect(thrown.status).toBe(500)
    expect(await thrown.json()).toEqual({ type: "error", error: { type: "api_error", message: "network down" } })

    const brokenStream = claudeStreamResponse(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("stream broke"))
          },
        }),
      ),
      { model: "m", messages: [], stream: true },
    )
    const errorEvents = await readSse(brokenStream)
    expect(errorEvents.map((event) => event.data.type)).toEqual(["message_start", "error"])
    expect(errorEvents[1]).toEqual({ event: "error", data: { type: "error", error: { type: "api_error", message: "stream broke" } } })

    expect((await handleClaudeMessages(okClient as any, new Request("http://x", { method: "POST", body: "{" }), "id")).status).toBe(400)
    expect((await handleClaudeMessages(okClient as any, new Request("http://x", { method: "POST", body: JSON.stringify({ model: "m" }) }), "id")).status).toBe(400)
    expect((await handleClaudeCountTokens(new Request("http://x", { method: "POST", body: "{" }))).status).toBe(400)
    expect((await handleClaudeCountTokens(new Request("http://x", { method: "POST", body: JSON.stringify({}) }))).status).toBe(400)
    await expect(
      handleClaudeCountTokens(new Request("http://x", { method: "POST", body: JSON.stringify({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] }) })).then((response) =>
        response.json(),
      ),
    ).resolves.toEqual({
      input_tokens: encodeChat([{ role: "user", content: "hi" }], "gpt-4.1").length,
    })
  })
})
