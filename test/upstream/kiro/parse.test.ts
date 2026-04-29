import { describe, expect, test } from "bun:test"
import { countTokens } from "gpt-tokenizer"

import { AwsEventStreamParser, collectKiroResponse, streamKiroResponse, ThinkingBlockExtractor } from "../../../src/upstream/kiro"
import { DEFAULT_MAX_INPUT_TOKENS } from "../../../src/upstream/kiro/constants"
import type { Canonical_Event } from "../../../src/core/canonical"

const fallbackTokenEncoder = new TextEncoder()

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
}

function estimatedFallbackTokens(text: string) {
  return Math.max(countTokens(text), fallbackTokenEncoder.encode(text).length)
}

describe("Kiro response parsing", () => {
  test("parses AWS-framed chunks with message-type markers", () => {
    const parser = new AwsEventStreamParser()
    const bytes = new TextEncoder().encode(':message-typeevent{"content":"framed"}:message-typeevent{"usage":3}')
    expect(parser.feed(bytes)).toEqual([{ content: "framed" }, { usage: 3 }])
  })

  test("parses cross-chunk JSON and deduplicates content", () => {
    const parser = new AwsEventStreamParser()
    expect(parser.feed(new TextEncoder().encode('noise {"content":"he'))).toEqual([])
    expect(parser.feed(new TextEncoder().encode('llo"}{"content":"hello"}{"usage":4}'))).toEqual([{ content: "hello" }, { usage: 4 }])
  })

  test("parses object usage events for cache accounting", () => {
    const parser = new AwsEventStreamParser()
    expect(parser.feed(new TextEncoder().encode('{"usage":{"cacheReadInputTokens":5,"cacheCreationInputTokens":2,"outputTokens":7}}'))).toEqual([
      { usage: { cacheReadInputTokens: 5, cacheCreationInputTokens: 2, outputTokens: 7 } },
    ])
  })

  test("preserves multibyte UTF-8 characters split across chunks", () => {
    const parser = new AwsEventStreamParser()
    const bytes = new TextEncoder().encode('{"content":"é"}')

    expect(parser.feed(bytes.slice(0, 13))).toEqual([])
    expect(parser.feed(bytes.slice(13))).toEqual([{ content: "é" }])
  })

  test("accumulates string and object tool input", () => {
    const parser = new AwsEventStreamParser()
    parser.feed(new TextEncoder().encode('{"name":"save","toolUseId":"call_1","input":{"a":1}}{"input":{"b":2}}{"stop":true}'))
    expect(parser.getToolCalls()).toEqual([{ callId: "call_1", name: "save", arguments: "{\"a\":1,\"b\":2}" }])
  })

  test("finalizes named stop events without resetting accumulated tool input", () => {
    const parser = new AwsEventStreamParser()
    const events = [
      { name: "WebFetch", toolUseId: "tooluse_1", input: "" },
      { input: "{\"url\": \"" },
      { input: "https://example.com/article" },
      { input: "\", \"prompt\": \"summarize\"}" },
      { name: "WebFetch", stop: true, toolUseId: "tooluse_1" },
    ]

    parser.feed(new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("")))

    const [call] = parser.getToolCalls()
    expect(call).toMatchObject({ callId: "tooluse_1", name: "WebFetch" })
    expect(call.arguments).not.toBe("{}")
    expect(JSON.parse(call.arguments)).toEqual({ url: "https://example.com/article", prompt: "summarize" })
  })

  test("finalizes pending tool input when Kiro omits a stop event", () => {
    const parser = new AwsEventStreamParser()
    parser.feed(new TextEncoder().encode('{"name":"save","toolUseId":"call_1"}{"input":""}{"contextUsagePercentage":50}'))

    expect(parser.takeToolCalls()).toEqual([])
    expect(parser.finishToolCalls()).toEqual([{ callId: "call_1", name: "save", arguments: "{}" }])
  })

  test("skips malformed JSON events and continues parsing later events", () => {
    const parser = new AwsEventStreamParser()
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message?: unknown) => warnings.push(String(message))
    try {
      expect(parser.feed(new TextEncoder().encode('{"content":bad}{"content":"ok"}{"usage":3}'))).toEqual([{ content: "ok" }, { usage: 3 }])
    } finally {
      console.warn = originalWarn
    }
    expect(warnings.some((warning) => warning.includes("Skipping malformed Kiro event-stream JSON"))).toBe(true)
  })

  test("bounds incomplete event-stream buffers and recovers on the next event", () => {
    const parser = new AwsEventStreamParser()
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message?: unknown) => warnings.push(String(message))
    try {
      expect(parser.feed(new TextEncoder().encode(`{"content":"${"x".repeat(1_000_001)}`))).toEqual([])
      expect(parser.feed(new TextEncoder().encode('{"content":"ok"}'))).toEqual([{ content: "ok" }])
    } finally {
      console.warn = originalWarn
    }

    expect(warnings.some((warning) => warning.includes("Discarding oversized incomplete Kiro event-stream buffer"))).toBe(true)
  })

  test("extracts thinking blocks for both tag variants", () => {
    const extractor = new ThinkingBlockExtractor()
    expect(extractor.feed("<think>work")).toEqual({ thinking: "work" })
    expect(extractor.feed("ing</think>done")).toEqual({ thinking: "ing", regular: "done" })
    expect(extractor.feed("!")).toEqual({ regular: "!" })

    const longTagExtractor = new ThinkingBlockExtractor()
    expect(longTagExtractor.feed("<thinking>plan</thinking>ok")).toEqual({ thinking: "plan", regular: "ok" })
  })

  test("extracts thinking when the closing tag is split across chunks", () => {
    const extractor = new ThinkingBlockExtractor()
    expect(extractor.feed("<thinking>plan</thi")).toEqual({ thinking: "plan" })
    expect(extractor.feed("nking>ok")).toEqual({ regular: "ok" })
  })

  test("conservatively estimates Kiro output tokens from GPT tokens and byte length when upstream usage is missing", async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message?: unknown) => warnings.push(String(message))
    try {
      const response = await collectKiroResponse(new Response(stream(['{"content":"fallback tokens"}'])), "model", [], 7)
      expect(response.usage.outputTokens).toBe(estimatedFallbackTokens("fallback tokens"))
    } finally {
      console.warn = originalWarn
    }

    expect(warnings.some((warning) => warning.includes("Conservatively estimating Kiro output tokens with max(gpt-tokenizer, byte length)"))).toBe(true)
  })

  test("streams canonical text, thinking, tool, usage, signature, and stop events", async () => {
    const response = streamKiroResponse(new Response(stream(['{"content":"<thinking>plan</thinking>ok"}', '{"name":"save","toolUseId":"call_1","input":"{\\"x\\":1}"}', '{"stop":true}', '{"contextUsagePercentage":50}'])), "model", [{ type: "function", name: "save" }], 7)
    const events: Canonical_Event[] = []
    for await (const event of response.events) events.push(event)

    expect(response.id).toMatch(/^resp_[0-9a-f]{32}$/)
    expect(events.some((event) => event.type === "content_block_start" && event.blockType === "thinking")).toBe(true)
    expect(events.some((event) => event.type === "thinking_delta" && event.text === "plan")).toBe(true)
    expect(events.some((event) => event.type === "thinking_signature" && /^sig_[0-9a-f]{32}$/.test(event.signature))).toBe(true)
    expect(events.some((event) => event.type === "content_block_stop" && event.index === 0)).toBe(true)
    expect(events.some((event) => event.type === "text_delta" && event.delta === "ok")).toBe(true)
    expect(events.some((event) => event.type === "tool_call_done" && event.name === "save")).toBe(true)
    expect(events.at(-2)).toEqual({ type: "usage", usage: { inputTokens: Math.max(0, Math.floor((50 / 100) * DEFAULT_MAX_INPUT_TOKENS) - estimatedFallbackTokens("ok")), outputTokens: estimatedFallbackTokens("ok") } })
    expect(events.at(-1)).toEqual({ type: "message_stop", stopReason: "tool_use" })
  })

  test("forwards Kiro object usage cache fields in streaming and collected responses", async () => {
    const body = '{"content":"hello"}{"usage":{"cache_read_input_tokens":5,"cache_creation_input_tokens":2,"output_tokens":7}}{"contextUsagePercentage":1}'
    const response = streamKiroResponse(new Response(stream([body])), "model", [], 3)
    const events: Canonical_Event[] = []
    for await (const event of response.events) events.push(event)

    expect(events.at(-2)).toEqual({
      type: "usage",
      usage: {
        inputTokens: Math.max(0, Math.floor((1 / 100) * DEFAULT_MAX_INPUT_TOKENS) - 7),
        outputTokens: 7,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 5,
      },
    })

    const collected = await collectKiroResponse(new Response(stream([body])), "model", [], 3)
    expect(collected.usage).toMatchObject({
      outputTokens: 7,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 5,
    })
  })

  test("prefers Kiro object usage input tokens over local context estimates", async () => {
    const body = '{"content":"hello"}{"usage":{"input_tokens":11,"cache_read_input_tokens":5,"output_tokens":7,"server_tool_use":{"web_search_requests":2}}}{"contextUsagePercentage":1}'
    const response = streamKiroResponse(new Response(stream([body])), "model", [], 3)
    const events: Canonical_Event[] = []
    for await (const event of response.events) events.push(event)

    expect(events.at(-2)).toMatchObject({
      type: "usage",
      usage: {
        inputTokens: 11,
        cacheReadInputTokens: 5,
        outputTokens: 7,
        serverToolUse: { webSearchRequests: 2 },
      },
    })

    const collected = await collectKiroResponse(new Response(stream([body])), "model", [], 3)
    expect(collected.usage).toMatchObject({
      inputTokens: 11,
      cacheReadInputTokens: 5,
      outputTokens: 7,
      serverToolUse: { webSearchRequests: 2 },
    })
  })

  test("keeps the larger server tool count when local blocks and repeated usage objects report it", async () => {
    const body = '{"content":"hello"}{"usage":{"output_tokens":7,"server_tool_use":{"web_search_requests":2}}}{"usage":{"output_tokens":7,"server_tool_use":{"web_search_requests":1}}}'
    const initialServerToolBlocks = [{ type: "web_search_tool_result", tool_use_id: "srv_1", content: [] }]
    const response = streamKiroResponse(
      new Response(stream([body])),
      "model",
      [],
      3,
      undefined,
      initialServerToolBlocks,
    )
    const events: Canonical_Event[] = []
    for await (const event of response.events) events.push(event)

    expect(events.at(-2)).toMatchObject({
      type: "usage",
      usage: {
        outputTokens: 7,
        serverToolUse: { webSearchRequests: 2 },
      },
    })

    const collected = await collectKiroResponse(new Response(stream([body])), "model", [], 3, undefined, initialServerToolBlocks)
    expect(collected.usage.serverToolUse).toEqual({ webSearchRequests: 2 })
  })

  test("streaming emits Kiro tool calls that do not include stop events", async () => {
    const response = streamKiroResponse(new Response(stream(['{"content":"Để kiểm tra các thư mục được phép truy cập."}', '{"name":"mcp__filesystem__list_allowed_directories","toolUseId":"call_1"}', '{"input":""}', '{"contextUsagePercentage":50}'])), "model", [{ type: "function", name: "mcp__filesystem__list_allowed_directories" }], 7)
    const events: Canonical_Event[] = []
    for await (const event of response.events) events.push(event)

    expect(events.some((event) => event.type === "text_delta" && event.delta === "Để kiểm tra các thư mục được phép truy cập.")).toBe(true)
    expect(events.some((event) => event.type === "tool_call_done" && event.name === "mcp__filesystem__list_allowed_directories" && event.arguments === "{}")).toBe(true)
    expect(events.at(-1)).toEqual({ type: "message_stop", stopReason: "tool_use" })
  })

  test("streaming emits one thinking block start for split thinking content", async () => {
    const response = streamKiroResponse(new Response(stream(['{"content":"<thinking>pla"}', '{"content":"n</thinking>ok"}'])), "model", [], 5)
    const events: Canonical_Event[] = []
    for await (const event of response.events) events.push(event)

    expect(events.filter((event) => event.type === "content_block_start" && event.blockType === "thinking")).toHaveLength(1)
    expect(events.filter((event) => event.type === "thinking_delta").map((event) => event.text)).toEqual(["pla", "n"])
    expect(events.filter((event) => event.type === "content_block_stop")).toHaveLength(1)
  })

  test("streaming does not leak split thinking closing tags", async () => {
    const response = streamKiroResponse(new Response(stream(['{"content":"<thinking>plan</thi"}', '{"content":"nking>ok"}'])), "model", [], 5)
    const events: Canonical_Event[] = []
    for await (const event of response.events) events.push(event)

    expect(events.filter((event) => event.type === "thinking_delta").map((event) => event.text)).toEqual(["plan"])
    expect(events.some((event) => event.type === "thinking_delta" && event.text?.includes("</"))).toBe(false)
    expect(events.some((event) => event.type === "text_delta" && event.delta === "ok")).toBe(true)
    expect(events.filter((event) => event.type === "content_block_stop")).toHaveLength(1)
  })

  test("streaming handles a missing response body", async () => {
    const initialServerToolBlocks = [
      { type: "server_tool_use", id: "srvtoolu_search", name: "web_search", input: { query: "https://example.com" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_search", content: [] },
    ]
    const response = streamKiroResponse(new Response(null), "model", [], 5, undefined, initialServerToolBlocks, "preface")
    const events: Canonical_Event[] = []
    for await (const event of response.events) events.push(event)

    expect(events).toEqual([
      { type: "text_delta", delta: "preface" },
      { type: "server_tool_block", blocks: initialServerToolBlocks },
      { type: "usage", usage: { inputTokens: 5, outputTokens: estimatedFallbackTokens("preface"), serverToolUse: { webSearchRequests: 1 } } },
      { type: "message_stop", stopReason: "end_turn" },
    ])
  })

  test("streaming emits bracket tool calls after preserving streamed text", async () => {
    const response = streamKiroResponse(new Response(stream(['{"content":"Before [Called save with args: {\\"x\\":1}] after"}'])), "model", [{ type: "function", name: "save" }], 5)
    const events: Canonical_Event[] = []
    for await (const event of response.events) events.push(event)

    expect(events.some((event) => event.type === "tool_call_done" && event.name === "save" && event.arguments === '{"x":1}')).toBe(true)
    expect(events.some((event) => event.type === "text_delta" && event.delta === 'Before [Called save with args: {"x":1}] after')).toBe(true)
    expect(events.at(-1)).toEqual({ type: "message_stop", stopReason: "tool_use" })
  })

  test("streaming intercepts Kiro web_search function calls as server tool blocks", async () => {
    const response = streamKiroResponse(
      new Response(stream(['{"name":"web_search","toolUseId":"call_ws","input":"{\\"query\\":\\"Kiro news\\"}"}', '{"stop":true}'])),
      "model",
      [{ type: "function", name: "web_search" }],
      5,
      {
        webSearch: async (query) => ({
          toolUseId: "srvtoolu_search",
          results: { results: [{ title: "Result", url: "https://example.com", snippet: "Snippet" }] },
          summary: `<web_search>\nSearch results for "${query}"\n</web_search>\n`,
        }),
      },
    )
    const events: Canonical_Event[] = []
    for await (const event of response.events) events.push(event)

    expect(events.some((event) => event.type === "server_tool_block" && event.blocks.some((block) => block.type === "web_search_tool_result"))).toBe(true)
    expect(events.some((event) => event.type === "text_delta" && event.delta.includes("<web_search>"))).toBe(false)
    expect(events.some((event) => event.type === "usage" && event.usage.serverToolUse?.webSearchRequests === 1)).toBe(true)
    expect(events.at(-1)).toEqual({ type: "message_stop", stopReason: "end_turn" })
  })

  test("streaming uses fallback query for empty Kiro web_search calls", async () => {
    let observedQuery = ""
    const response = streamKiroResponse(
      new Response(stream(['{"name":"web_search","toolUseId":"call_ws","input":{}}', '{"stop":true}'])),
      "model",
      [{ type: "function", name: "web_search" }],
      5,
      {
        webSearchFallbackQuery: "https://example.com/article",
        webSearch: async (query) => {
          observedQuery = query
          return {
            toolUseId: "srvtoolu_search",
            results: { results: [{ title: "Article", url: query, snippet: "Summary" }] },
            summary: `<web_search>\nSearch results for "${query}"\n</web_search>\n`,
          }
        },
      },
    )
    const events: Canonical_Event[] = []
    for await (const event of response.events) events.push(event)

    expect(observedQuery).toBe("https://example.com/article")
    expect(events.some((event) => event.type === "tool_call_done" && event.name === "web_search")).toBe(false)
    expect(events.some((event) => event.type === "server_tool_block" && event.blocks.some((block) => block.type === "web_search_tool_result"))).toBe(true)
    expect(events.at(-1)).toEqual({ type: "message_stop", stopReason: "end_turn" })
  })

  test("streaming emits initial server tool blocks before answer text", async () => {
    const response = streamKiroResponse(
      new Response(stream(['{"content":"Answer"}'])),
      "model",
      [{ type: "function", name: "web_search" }],
      5,
      undefined,
      [
        { type: "server_tool_use", id: "srvtoolu_search", name: "web_search", input: { query: "https://example.com" } },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_search", content: [{ type: "web_search_result", title: "Example", url: "https://example.com", encrypted_content: "" }] },
      ],
    )
    const events: Canonical_Event[] = []
    for await (const event of response.events) events.push(event)

    expect(events[0]).toMatchObject({ type: "server_tool_block" })
    expect(events.some((event) => event.type === "text_delta" && event.delta === "Answer")).toBe(true)
    expect(events.some((event) => event.type === "usage" && event.usage.serverToolUse?.webSearchRequests === 1)).toBe(true)
  })

  test("collects non-streaming response and extracts bracket tool calls with ordered surrounding text", async () => {
    const response = await collectKiroResponse(new Response(stream(['{"content":"Before [Called save with args: {\\"x\\":1}] after"}', '{"contextUsagePercentage":10}'])), "model", [{ type: "function", name: "save" }], 5)

    expect(response.id).toMatch(/^resp_[0-9a-f]{32}$/)
    expect(response.stopReason).toBe("tool_use")
    expect(response.content).toMatchObject([
      { type: "text", text: "Before " },
      { type: "tool_call", name: "save", arguments: '{"x":1}' },
      { type: "text", text: " after" },
    ])
  })

  test("preserves invalid bracket patterns as text", async () => {
    const response = await collectKiroResponse(new Response(stream(['{"content":"Before [Called save with args: {oops}] after"}'])), "model", [{ type: "function", name: "save" }], 5)

    expect(response.stopReason).toBe("end_turn")
    expect(response.content).toEqual([{ type: "text", text: "Before [Called save with args: {oops}] after" }])
  })

  test("preserves bracket patterns for unknown tools as text", async () => {
    const response = await collectKiroResponse(new Response(stream(['{"content":"Before [Called skip with args: {\\"x\\":1}] after"}'])), "model", [{ type: "function", name: "save" }], 5)

    expect(response.stopReason).toBe("end_turn")
    expect(response.content).toEqual([{ type: "text", text: 'Before [Called skip with args: {"x":1}] after' }])
  })

  test("non-streaming response preserves context-usage input estimate and deduplicates bracket tool calls", async () => {
    const response = await collectKiroResponse(
      new Response(stream(['{"name":"save","toolUseId":"call_1","input":"{\\"x\\":1}"}', '{"stop":true}', '{"content":"[Called save with args: {\\"x\\":1}]"}', '{"contextUsagePercentage":10}'])),
      "model",
      [{ type: "function", name: "save" }],
      5,
    )

    expect(response.content.filter((block) => block.type === "tool_call")).toHaveLength(1)
    expect(response.usage.inputTokens).toBe(Math.max(0, Math.floor((10 / 100) * DEFAULT_MAX_INPUT_TOKENS) - estimatedFallbackTokens('[Called save with args: {"x":1}]')))
  })

  test("non-streaming response prefers non-empty bracket arguments over empty structured duplicates", async () => {
    const response = await collectKiroResponse(
      new Response(stream(['{"name":"save","toolUseId":"call_1","input":"{}"}', '{"stop":true}', '{"content":"[Called save with args: {\\"x\\":1}]"}'])),
      "model",
      [{ type: "function", name: "save" }],
      5,
    )

    const toolCalls = response.content.filter((block) => block.type === "tool_call")
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({ name: "save", arguments: '{"x":1}' })
    expect(response.content.some((block) => block.type === "text" && block.text.includes("[Called save"))).toBe(false)
  })

  test("non-streaming duplicate bracket calls preserve surrounding text", async () => {
    const response = await collectKiroResponse(
      new Response(stream(['{"name":"save","toolUseId":"call_1","input":"{\\"x\\":1}"}', '{"stop":true}', '{"content":"before [Called save with args: {\\"x\\":1}] after"}'])),
      "model",
      [{ type: "function", name: "save" }],
      5,
    )

    expect(response.content).toMatchObject([
      { type: "tool_call", callId: "call_1", name: "save", arguments: '{"x":1}' },
      { type: "text", text: "before " },
      { type: "text", text: " after" },
    ])
  })

  test("non-streaming emits distinct same-name bracket calls", async () => {
    const response = await collectKiroResponse(
      new Response(stream(['{"name":"save","toolUseId":"call_1","input":"{\\"a\\":1}"}', '{"stop":true}', '{"content":"[Called save with args: {\\"b\\":2}]"}'])),
      "model",
      [{ type: "function", name: "save" }],
      5,
    )

    expect(response.content.filter((block) => block.type === "tool_call")).toMatchObject([
      { callId: "call_1", name: "save", arguments: '{"a":1}' },
      { name: "save", arguments: '{"b":2}' },
    ])
  })

  test("non-streaming does not upgrade ambiguous empty same-name structured calls", async () => {
    const response = await collectKiroResponse(
      new Response(stream(['{"name":"save","toolUseId":"call_1","input":"{}"}', '{"stop":true}', '{"name":"save","toolUseId":"call_2","input":"{}"}', '{"stop":true}', '{"content":"[Called save with args: {\\"x\\":1}]"}'])),
      "model",
      [{ type: "function", name: "save" }],
      5,
    )

    expect(response.content.filter((block) => block.type === "tool_call")).toMatchObject([
      { callId: "call_1", name: "save", arguments: "{}" },
      { callId: "call_2", name: "save", arguments: "{}" },
      { name: "save", arguments: '{"x":1}' },
    ])
  })

  test("non-streaming response preserves text-tool-text event order", async () => {
    const response = await collectKiroResponse(
      new Response(stream(['{"content":"before "}', '{"name":"save","toolUseId":"call_1","input":"{\\"x\\":1}"}', '{"stop":true}', '{"content":" after"}'])),
      "model",
      [{ type: "function", name: "save" }],
      5,
    )

    expect(response.content).toMatchObject([
      { type: "text", text: "before " },
      { type: "tool_call", callId: "call_1", name: "save", arguments: "{\"x\":1}" },
      { type: "text", text: " after" },
    ])
  })

  test("uses exact context-usage token formula and fallback stop reason variants", async () => {
    const text = "hello"
    const withContextUsage = await collectKiroResponse(new Response(stream([`{"content":"${text}"}`, '{"contextUsagePercentage":10}'])), "model", [], 7)
    const withoutContextUsage = await collectKiroResponse(new Response(stream([`{"content":"${text}"}`])), "model", [], 7)

    expect(withContextUsage.stopReason).toBe("end_turn")
    expect(withContextUsage.usage.outputTokens).toBe(estimatedFallbackTokens(text))
    expect(withContextUsage.usage.inputTokens).toBe(Math.max(0, Math.floor((10 / 100) * DEFAULT_MAX_INPUT_TOKENS) - estimatedFallbackTokens(text)))
    expect(withoutContextUsage.stopReason).toBe("end_turn")
    expect(withoutContextUsage.usage.inputTokens).toBe(7)

    const truncated = streamKiroResponse(new Response(stream(['{"stop":true}'])), "model", [], 7)
    const events: Canonical_Event[] = []
    for await (const event of truncated.events) events.push(event)
    expect(events.at(-1)).toEqual({ type: "message_stop", stopReason: "max_tokens" })

    const collectedTruncated = await collectKiroResponse(new Response(stream(['{"content":"partial"}', '{"stop":true}'])), "model", [], 7)
    expect(collectedTruncated.stopReason).toBe("max_tokens")
  })
})

describe("AwsEventStreamParser hardening", () => {
  test("chunk split in the middle of a JSON string", () => {
    const parser = new AwsEventStreamParser()
    // Split '{"content":"hello world"}' in the middle of the string value
    expect(parser.feed(new TextEncoder().encode('{"content":"hello '))).toEqual([])
    expect(parser.feed(new TextEncoder().encode('world"}'))).toEqual([{ content: "hello world" }])
  })

  test("nested JSON in tool input containing strings that look like top-level event starts", () => {
    const parser = new AwsEventStreamParser()
    // Tool input contains a string that looks like a top-level event pattern
    const event = '{"name":"tool","toolUseId":"t1","input":"{\\"content\\":\\"nested\\"}","stop":true}'
    const events = parser.feed(new TextEncoder().encode(event))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: "tool", toolUseId: "t1", stop: true })
  })

  test("malformed event followed by valid event recovers without dropping the valid event", () => {
    const parser = new AwsEventStreamParser()
    // First chunk has malformed JSON, second has valid event
    const events = parser.feed(new TextEncoder().encode('{"content":broken}{"content":"valid"}'))
    // The malformed one should be skipped, valid one parsed
    expect(events.some((e: any) => e.content === "valid")).toBe(true)
    expect(parser.skippedMalformedEvents).toBeGreaterThanOrEqual(0)
  })

  test("oversized pending buffer logs safe metadata and continues parsing later valid events", () => {
    const parser = new AwsEventStreamParser()
    // Feed a huge incomplete event to trigger oversized buffer trim
    const huge = '{"content":"' + "x".repeat(1_100_000)
    parser.feed(new TextEncoder().encode(huge))
    expect(parser.oversizedBufferTrims).toBe(1)

    // Now feed a valid event - parser should recover
    const events = parser.feed(new TextEncoder().encode('{"content":"recovered"}'))
    expect(events).toEqual([{ content: "recovered" }])
  })

  test("duplicate content suppression does not drop intentional repeated model output in separate semantic events", () => {
    const parser = new AwsEventStreamParser()
    // Same content in consecutive events - should be deduplicated
    parser.feed(new TextEncoder().encode('{"content":"same"}'))
    const second = parser.feed(new TextEncoder().encode('{"content":"same"}'))
    expect(second).toEqual([])
    expect(parser.duplicateContentSkips).toBe(1)

    // Different content should not be suppressed
    const third = parser.feed(new TextEncoder().encode('{"content":"different"}'))
    expect(third).toEqual([{ content: "different" }])

    // A usage event between same-content events resets dedup
    parser.feed(new TextEncoder().encode('{"usage":1}'))
    const afterUsage = parser.feed(new TextEncoder().encode('{"content":"different"}'))
    expect(afterUsage).toEqual([])
    expect(parser.duplicateContentSkips).toBe(2)
  })

  test("diagnostics returns safe metadata without raw content", () => {
    const parser = new AwsEventStreamParser()
    parser.feed(new TextEncoder().encode('{"content":"hello"}'))
    const diag = parser.diagnostics()
    expect(diag).toMatchObject({
      skippedMalformedEvents: 0,
      oversizedBufferTrims: 0,
      completedToolCalls: 0,
    })
    expect(typeof diag.bufferLength).toBe("number")
  })

  test("reset clears telemetry counters", () => {
    const parser = new AwsEventStreamParser()
    const huge = '{"content":"' + "x".repeat(1_100_000)
    parser.feed(new TextEncoder().encode(huge))
    expect(parser.oversizedBufferTrims).toBe(1)
    parser.reset()
    expect(parser.oversizedBufferTrims).toBe(0)
    expect(parser.skippedMalformedEvents).toBe(0)
    expect(parser.duplicateContentSkips).toBe(0)
  })
})
