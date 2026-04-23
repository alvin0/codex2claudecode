import { describe, expect, test } from "bun:test"

import {
  anthropicMessagesToKiroInput,
  anthropicStreamResponse,
  collectKiroResponse,
  handleKiroAnthropicMessages,
  handleKiroChatCompletions,
  openAiChatCompletionsToKiroInput,
  openAiStreamResponse,
} from "../src/llm-connect/kiro"
import { buildWebResultAnswer, extractWebResultAnswerFromMessages } from "../src/llm-connect/kiro/gateway/web-result-text"
import { readSse } from "./helpers"

describe("Kiro gateway", () => {
  test("converts Anthropic messages into Kiro history and current content", () => {
    const input = anthropicMessagesToKiroInput({
      model: "CLAUDE_4_SONNET",
      system: "Be terse",
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
        { role: "user", content: [{ type: "text", text: "How are you?" }] },
      ],
      stream: true,
    })

    expect(input).toEqual({
      modelId: "CLAUDE_4_SONNET",
      stream: true,
      currentMessage: {
        content: "How are you?",
        modelId: "CLAUDE_4_SONNET",
        origin: "AI_EDITOR",
      },
      history: [
        {
          userInputMessage: {
            content: "Be terse\n\nHello",
            modelId: "CLAUDE_4_SONNET",
            origin: "AI_EDITOR",
          },
        },
        {
          assistantResponseMessage: {
            content: "Hi",
          },
        },
      ],
      system: "Be terse",
      tools: undefined,
      toolChoice: undefined,
      thinking: { enabled: false },
    })
  })

  test("converts Anthropic web search results into readable Kiro history", () => {
    const input = anthropicMessagesToKiroInput({
      model: "CLAUDE_4_SONNET",
      messages: [
        { role: "user", content: [{ type: "text", text: "Get BTC price" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll search." },
            { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "BTC price" } },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: [
                {
                  type: "web_search_result",
                  title: "BTC price",
                  url: "https://example.com/btc",
                  encrypted_content: "BTC is $100",
                  page_age: "2026-04-23T00:00:00.000Z",
                },
              ],
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Answer now" }] },
      ],
      stream: false,
    })

    expect(input.history?.[1]?.assistantResponseMessage?.content).toContain("Web search results:")
    expect(input.history?.[1]?.assistantResponseMessage?.content).toContain("$100")
    expect(input.history?.[1]?.assistantResponseMessage?.toolUses?.[0]).toMatchObject({
      name: "web_search",
      input: { query: "BTC price" },
      toolUseId: "srvtoolu_1",
    })
  })

  test("normalizes Claude Code web search prompt text before sending to Kiro", () => {
    const input = anthropicMessagesToKiroInput({
      model: "CLAUDE_4_SONNET",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                'Web search results for query: "giá bitcoin hiện tại"\n\n' +
                'Links: [{"title":"Bitcoin (BTC) Price USD Today, News, Charts, Market Cap","url":"https://www.coinbase.com/price/bitcoin"},{"title":"Bitcoin Price: $78,158.00 (0.35%)","url":"https://crypto.news/price/bitcoin/"}]\n\n' +
                "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.",
            },
          ],
        },
      ],
      stream: false,
    })

    expect(input.currentMessage.content).toContain('Web search results for "giá bitcoin hiện tại":')
    expect(input.currentMessage.content).toContain("Bitcoin Price: $78,158.00 (0.35%) - https://crypto.news/price/bitcoin/")
    expect(input.currentMessage.content).not.toContain("Links: [{")
    expect(input.currentMessage.content).not.toContain("REMINDER:")
  })

  test("converts OpenAI chat completions into Kiro history and current content", () => {
    const input = openAiChatCompletionsToKiroInput({
      model: "CLAUDE_4_SONNET",
      messages: [
        { role: "system", content: "Be terse" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "Continue" },
      ],
      stream: false,
    })

    expect(input).toEqual({
      modelId: "CLAUDE_4_SONNET",
      stream: false,
      currentMessage: {
        content: "Continue",
        modelId: "CLAUDE_4_SONNET",
        origin: "AI_EDITOR",
      },
      history: [
        {
          userInputMessage: {
            content: "Be terse\n\nHello",
            modelId: "CLAUDE_4_SONNET",
            origin: "AI_EDITOR",
          },
        },
        {
          assistantResponseMessage: {
            content: "Hi",
          },
        },
      ],
      system: "Be terse",
      tools: undefined,
      toolChoice: undefined,
      thinking: { enabled: false },
    })
  })

  test("collects fragmented Kiro stream chunks", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"content":"Hel'))
          controller.enqueue(new TextEncoder().encode('lo"}{"usage":{"inputTokens":3,"outputTokens":5}}'))
          controller.close()
        },
      }),
    )

    await expect(collectKiroResponse(response)).resolves.toEqual({
      content: "Hello",
      usage: { inputTokens: 3, outputTokens: 5 },
      completed: true,
      events: [
        { type: "content", content: "Hello" },
        { type: "usage", usage: { inputTokens: 3, outputTokens: 5 } },
      ],
    })
  })

  test("formats Anthropic streaming response as SSE events", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"content":"Hello"}{"usage":{"inputTokens":3,"outputTokens":5}}'))
          controller.close()
        },
      }),
    )

    const events = await readSse(
      anthropicStreamResponse(response, {
        model: "CLAUDE_4_SONNET",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    )

    expect(events.map((event) => event.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(events[2]?.data.delta.text).toBe("Hello")
  })

  test("does not forward raw Kiro thinking text into Anthropic thinking deltas", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"content":"<thinking>internal chain of thought</thinking>"}{"content":"Hello"}'))
          controller.close()
        },
      }),
    )

    const events = await readSse(
      anthropicStreamResponse(response, {
        model: "CLAUDE_4_SONNET",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    )

    const thinkingDeltas = events.filter((event) => event.data?.delta?.type === "thinking_delta")
    expect(thinkingDeltas).toHaveLength(0)
    const text = events
      .filter((event) => event.data?.delta?.type === "text_delta")
      .map((event) => event.data.delta.text)
      .join("")
    expect(text).toContain("Hello")
  })

  test("does not synthesize WebSearch tool calls from thinking-only output", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"content":"<thinking>Need more context before answering</thinking>"}'))
          controller.close()
        },
      }),
    )

    const events = await readSse(
      anthropicStreamResponse(response, {
        model: "CLAUDE_4_SONNET",
        messages: [{ role: "user", content: "cho toi biet logic hien tai cua du an" }],
        stream: true,
      }),
    )

    expect(events.some((event) => event.data?.content_block?.type === "tool_use")).toBe(false)
    expect(events.find((event) => event.event === "message_delta")?.data.delta.stop_reason).toBe("end_turn")
  })

  test("handles conversation title requests locally without calling Kiro", async () => {
    let upstreamCalls = 0
    const response = await handleKiroAnthropicMessages(
      {
        generateAssistantResponse: () => {
          upstreamCalls += 1
          return Promise.resolve(new Response(null, { status: 200 }))
        },
        mcpCall: () => Promise.resolve(undefined),
      },
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-haiku-4.5",
          stream: true,
          messages: [{ role: "user", content: "fix login button on mobile" }],
          system: [
            { type: "text", text: "Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session." },
            { type: "text", text: "Return JSON with a single \"title\" field." },
          ],
          output_config: {
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                },
                required: ["title"],
              },
            },
          },
        }),
        headers: { "content-type": "application/json" },
      }),
    )

    expect(upstreamCalls).toBe(0)
    const events = await readSse(response)
    const text = events
      .filter((event) => event.data?.delta?.type === "text_delta")
      .map((event) => event.data.delta.text)
      .join("")
    expect(JSON.parse(text)).toEqual({ title: "Fix login button on mobile" })
  })

  test("filters repeated empty Agent tool calls from Anthropic JSON responses", async () => {
    const response = await handleKiroAnthropicMessages(
      {
        generateAssistantResponse: () =>
          Promise.resolve(
            new Response(
              '{"content":"Toi se kham pha codebase."}' +
              '{"name":"Agent","input":{},"stop":true}' +
              '{"name":"Agent","input":{},"stop":true}' +
              '{"usage":{"inputTokens":3,"outputTokens":5}}',
              { status: 200 },
            ),
          ),
        mcpCall: () => Promise.resolve(undefined),
      },
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "CLAUDE_4_SONNET",
          messages: [{ role: "user", content: "cho toi biet logic hien tai cua du an" }],
        }),
        headers: { "content-type": "application/json" },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      type: "message",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Toi se kham pha codebase." }],
    })
  })

  test("recovers answer text that leaked into suppressed thinking", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"content":"<thinking>The model is reasoning. Gia Bitcoin hien tai khoang **$78,158 </thinking>"}' +
                '{"content":"USD** (+0.35%).\\n\\nDe xem gia realtime, ban co the check tai:"}',
            ),
          )
          controller.close()
        },
      }),
    )

    const events = await readSse(
      anthropicStreamResponse(response, {
        model: "CLAUDE_4_SONNET",
        messages: [{ role: "user", content: "gia bitcoin hien tai" }],
        stream: true,
      }),
    )

    const text = events
      .filter((event) => event.data?.delta?.type === "text_delta")
      .map((event) => event.data.delta.text)
      .join("")
    expect(text).toContain("Gia Bitcoin hien tai khoang **$78,158 USD** (+0.35%).")
    expect(text).toContain("De xem gia realtime")
  })

  test("recovers short assistant prefix leaked into suppressed thinking", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"content":"<thinking>Toi se kham pha c</thinking>"}' +
              '{"content":"odebase de hieu logic hien tai."}',
            ),
          )
          controller.close()
        },
      }),
    )

    const events = await readSse(
      anthropicStreamResponse(response, {
        model: "CLAUDE_4_SONNET",
        messages: [{ role: "user", content: "cho toi biet logic hien tai cua du an" }],
        stream: true,
      }),
    )

    const text = events
      .filter((event) => event.data?.delta?.type === "text_delta")
      .map((event) => event.data.delta.text)
      .join("")
    expect(text).toContain("Toi se kham pha codebase de hieu logic hien tai.")
  })

  test("marks streaming text without completion signals as max_tokens", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"content":"odebase de hi"}'))
          controller.close()
        },
      }),
    )

    const events = await readSse(
      anthropicStreamResponse(response, {
        model: "CLAUDE_4_SONNET",
        messages: [{ role: "user", content: "cho toi biet logic hien tai cua du an" }],
        stream: true,
      }),
    )

    expect(events.find((event) => event.event === "message_delta")?.data.delta.stop_reason).toBe("max_tokens")
  })

  test("summarizes prior web search results when Kiro asks for unsupported WebFetch", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"content":"<thinking>Need details</thinking>"}{"name":"WebFetch","input":{},"stop":true}',
            ),
          )
          controller.close()
        },
      }),
    )

    const events = await readSse(
      anthropicStreamResponse(response, {
        model: "CLAUDE_4_SONNET",
        messages: [
          { role: "user", content: "Get BTC price" },
          {
            role: "assistant",
            content: [
              { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
                { type: "web_search_result", title: "BTC price", url: "https://example.com/btc", encrypted_content: "BTC is $100" },
              ] },
            ],
          },
        ],
        stream: true,
      }),
    )

    const text = events
      .filter((event) => event.data?.delta?.type === "text_delta")
      .map((event) => event.data.delta.text)
      .join("")
    expect(text).toContain("Bitcoin is currently about")
    expect(text).toContain("$100 USD/BTC")
    expect(events.find((event) => event.event === "message_delta")?.data.delta.stop_reason).toBe("end_turn")
  })

  test("appends web search results when unsupported WebFetch follows text", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"content":"<thinking>Need details</thinking>"}' +
                '{"content":"I will fetch a page."}' +
                '{"name":"WebFetch","input":{},"stop":true}',
            ),
          )
          controller.close()
        },
      }),
    )

    const events = await readSse(
      anthropicStreamResponse(response, {
        model: "CLAUDE_4_SONNET",
        messages: [
          { role: "user", content: "Get BTC price" },
          {
            role: "assistant",
            content: [
              {
                type: "web_search_tool_result",
                tool_use_id: "srvtoolu_1",
                content: [
                  {
                    type: "web_search_result",
                    title: "BTC price",
                    url: "https://example.com/btc",
                    encrypted_content: "BTC is $100",
                  },
                ],
              },
            ],
          },
        ],
        stream: true,
      }),
    )

    const text = events
      .filter((event) => event.data?.delta?.type === "text_delta")
      .map((event) => event.data.delta.text)
      .join("")
    expect(text).toContain("I will fetch a page.")
    expect(text).toContain("Bitcoin is currently about")
    expect(text).toContain("$100 USD/BTC")
    expect(events.find((event) => event.event === "message_delta")?.data.delta.stop_reason).toBe("end_turn")
  })

  test("uses cached web search results when Claude Code omits result blocks from follow-up", async () => {
    const metadata = { user_id: JSON.stringify({ session_id: "kiro-cache-test" }) }
    const mcpResponse = {
      id: "test",
      jsonrpc: "2.0",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              results: [
                { title: "BTC price", url: "https://example.com/btc", snippet: "BTC is $100" },
              ],
            }),
          },
        ],
        isError: false,
      },
    }

    await handleKiroAnthropicMessages(
      {
        generateAssistantResponse: () => Promise.resolve(new Response(null, { status: 200 })),
        mcpCall: () => Promise.resolve(mcpResponse),
      },
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-opus-4.6",
          max_tokens: 4096,
          stream: true,
          metadata,
          messages: [{ role: "user", content: "Perform a web search for the query: BTC price" }],
          tools: [{ type: "web_search_20260209", name: "web_search" }],
        }),
        headers: { "content-type": "application/json" },
      }),
    )

    const events = await readSse(
      anthropicStreamResponse(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  '{"content":"<thinking>Need details</thinking>"}' +
                    '{"content":"I will fetch a page."}' +
                    '{"name":"WebFetch","input":{},"stop":true}',
                ),
              )
              controller.close()
            },
          }),
        ),
        {
          model: "CLAUDE_4_SONNET",
          metadata,
          messages: [{ role: "user", content: "BTC price" }],
          stream: true,
        },
      ),
    )

    const text = events
      .filter((event) => event.data?.delta?.type === "text_delta")
      .map((event) => event.data.delta.text)
      .join("")
    expect(text).toContain("I will fetch a page.")
    expect(text).toContain("Bitcoin is currently about")
    expect(text).toContain("$100 USD/BTC")
  })

  test("uses cached web search results when follow-up only contains thinking", async () => {
    const metadata = { user_id: JSON.stringify({ session_id: "kiro-cache-thinking-only" }) }
    const mcpResponse = {
      id: "test",
      jsonrpc: "2.0",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              results: [
                { title: "BTC price", url: "https://example.com/btc", snippet: "BTC is $100" },
              ],
            }),
          },
        ],
        isError: false,
      },
    }

    await handleKiroAnthropicMessages(
      {
        generateAssistantResponse: () => Promise.resolve(new Response(null, { status: 200 })),
        mcpCall: () => Promise.resolve(mcpResponse),
      },
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-opus-4.6",
          max_tokens: 4096,
          stream: true,
          metadata,
          messages: [{ role: "user", content: "Perform a web search for the query: BTC price" }],
          tools: [{ type: "web_search_20260209", name: "web_search" }],
        }),
        headers: { "content-type": "application/json" },
      }),
    )

    const events = await readSse(
      anthropicStreamResponse(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"content":"<thinking>Need details</thinking>"}'))
              controller.close()
            },
          }),
        ),
        {
          model: "CLAUDE_4_SONNET",
          metadata,
          messages: [{ role: "user", content: "BTC price" }],
          stream: true,
        },
      ),
    )

    const text = events
      .filter((event) => event.data?.delta?.type === "text_delta")
      .map((event) => event.data.delta.text)
      .join("")
    expect(text).toContain("Bitcoin is currently about")
    expect(text).toContain("$100 USD/BTC")
    expect(text).not.toContain("I wasn't able to generate a complete response.")
  })

  test("prefers actual price over market cap when summarizing search results", () => {
    const answer = buildWebResultAnswer("gia bitcoin hien tai", [
      {
        type: "web_search_result",
        title: "Bitcoin price today, BTC to USD live price, marketcap and chart",
        url: "https://coinmarketcap.com/currencies/bitcoin/",
        encrypted_content:
          "Bitcoin statistics Market cap $1.51T Volume (24h) $39.82B Price performance 24h Low $73,775.57 High $76,575.",
      },
      {
        type: "web_search_result",
        title: "Bitcoin Price today, Chart and News - Decrypt - Decrypt",
        url: "https://decrypt.co/en-US/price/bitcoin?",
        encrypted_content: "$74,273.00 4.82%",
      },
    ])

    expect(answer).toContain("$74,273.00")
    expect(answer).not.toContain("$1.51")
  })

  test("dedupes repeated source links in web result answers", () => {
    const answer = buildWebResultAnswer("bitcoin price", [
      {
        type: "web_search_result",
        title: "Bitcoin Price today, Chart and News - Decrypt - Decrypt",
        url: "https://decrypt.co/en-US/price/bitcoin?",
        encrypted_content: "$74,273.00 4.82%",
      },
      {
        type: "web_search_result",
        title: "Bitcoin price today, BTC to USD live price, marketcap and chart",
        url: "https://www.coindesk.com/price/bitcoin",
        encrypted_content: "Bitcoin $ 93,057.39 1.97 %",
      },
      {
        type: "web_search_result",
        title: "Bitcoin Price today, Chart and News - Decrypt - Decrypt",
        url: "https://decrypt.co/en-US/price/bitcoin?",
        encrypted_content: "$74,273.00 4.82%",
      },
    ])

    expect(answer).toBeDefined()
    expect(answer?.match(/https:\/\/decrypt\.co\/en-US\/price\/bitcoin\?/g)?.length).toBe(1)
    expect(answer).toContain("https://www.coindesk.com/price/bitcoin")
  })

  test("caps fallback source links to the number of web searches", () => {
    const answer = extractWebResultAnswerFromMessages([
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "gia bitcoin hien tai" } },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [
              {
                type: "web_search_result",
                title: "Bitcoin Price today, Chart and News - Decrypt - Decrypt",
                url: "https://decrypt.co/en-US/price/bitcoin?",
                encrypted_content: "$74,273.00 4.82%",
              },
              {
                type: "web_search_result",
                title: "Bitcoin price today, BTC to USD live price, marketcap and chart",
                url: "https://www.coinbase.com/price/bitcoin",
                encrypted_content: "Bitcoin $74,500.00",
              },
            ],
          },
          { type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: { query: "Bitcoin price USD live" } },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_2",
            content: [
              {
                type: "web_search_result",
                title: "Bitcoin price today, BTC to USD live price, marketcap and chart",
                url: "https://www.coindesk.com/price/bitcoin",
                encrypted_content: "Bitcoin $93,057.39",
              },
            ],
          },
        ],
      },
    ], "gia bitcoin hien tai")

    expect(answer).toBeDefined()
    expect(answer?.match(/\n- \[/g)?.length).toBe(2)
    expect(answer).toContain("https://decrypt.co/en-US/price/bitcoin?")
  })

  test("formats OpenAI streaming response as chunks with DONE sentinel", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"content":"Hello"}'))
          controller.close()
        },
      }),
    )

    const text = await openAiStreamResponse(response, {
      model: "CLAUDE_4_SONNET",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }).text()

    expect(text).toContain('"object":"chat.completion.chunk"')
    expect(text).toContain('"content":"Hello"')
    expect(text).toContain("data: [DONE]")
  })

  test("returns Anthropic JSON responses from the shared handler", async () => {
    let upstreamStream: boolean | undefined
    const proxyEntries: Array<Record<string, unknown>> = []
    const response = await handleKiroAnthropicMessages(
      {
        generateAssistantResponse: (options) => {
          upstreamStream = options.stream
          return Promise.resolve(
            new Response('{"content":"Hello"}{"usage":{"inputTokens":3,"outputTokens":5}}', {
              status: 200,
            }),
          )
        },
        mcpCall: () => Promise.resolve(undefined),
      },
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "CLAUDE_4_SONNET",
          messages: [{ role: "user", content: "Hello" }],
        }),
        headers: { "content-type": "application/json" },
      }),
      "req_kiro_json",
      { onProxy: (entry) => proxyEntries.push(entry as Record<string, unknown>) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      type: "message",
      role: "assistant",
      model: "CLAUDE_4_SONNET",
      content: [{ type: "text", text: "Hello" }],
      usage: { input_tokens: 3, output_tokens: 5 },
    })
    expect(upstreamStream).toBe(true)
    expect(proxyEntries).toEqual([
      expect.objectContaining({
        label: "Kiro messages",
        method: "POST",
        target: "/generateAssistantResponse",
        status: 200,
        error: "-",
      }),
    ])
  })

  test("marks Anthropic JSON responses without completion signals as max_tokens", async () => {
    const response = await handleKiroAnthropicMessages(
      {
        generateAssistantResponse: () =>
          Promise.resolve(
            new Response('{"content":"odebase de hi"}', {
              status: 200,
            }),
          ),
        mcpCall: () => Promise.resolve(undefined),
      },
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "CLAUDE_4_SONNET",
          messages: [{ role: "user", content: "cho toi biet logic hien tai cua du an" }],
        }),
        headers: { "content-type": "application/json" },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      type: "message",
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "odebase de hi" }],
    })
  })

  test("falls back to web-search answer for thinking-only Anthropic JSON responses", async () => {
    const response = await handleKiroAnthropicMessages(
      {
        generateAssistantResponse: () =>
          Promise.resolve(
            new Response('{"content":"<thinking>Need answer from search results</thinking>"}', {
              status: 200,
            }),
          ),
        mcpCall: () => Promise.resolve(undefined),
      },
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "CLAUDE_4_SONNET",
          messages: [
            { role: "user", content: "gia bitcoin hien tai" },
            {
              role: "assistant",
              content: [
                { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "gia bitcoin hien tai" } },
                {
                  type: "web_search_tool_result",
                  tool_use_id: "srvtoolu_1",
                  content: [
                    {
                      type: "web_search_result",
                      title: "Bitcoin Price today, Chart and News - Decrypt - Decrypt",
                      url: "https://decrypt.co/en-US/price/bitcoin?",
                      encrypted_content: "$74,273.00 4.82%",
                    },
                  ],
                },
              ],
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      type: "message",
      role: "assistant",
      model: "CLAUDE_4_SONNET",
      content: [
        {
          type: "text",
          text: "Gia Bitcoin hien tai khoang **$74,273.00 4.82% USD/BTC**.\n\nNguon:\n- [Bitcoin Price today, Chart and News - Decrypt - Decrypt](https://decrypt.co/en-US/price/bitcoin?)",
        },
      ],
    })
  })

  test("returns OpenAI JSON responses from the shared handler", async () => {
    const response = await handleKiroChatCompletions(
      {
        generateAssistantResponse: () =>
          Promise.resolve(
            new Response('{"content":"Hello"}{"usage":{"inputTokens":3,"outputTokens":5}}', {
              status: 200,
            }),
          ),
      },
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "CLAUDE_4_SONNET",
          messages: [{ role: "user", content: "Hello" }],
        }),
        headers: { "content-type": "application/json" },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      object: "chat.completion",
      model: "CLAUDE_4_SONNET",
      choices: [{ message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    })
  })

  test("returns 400 for invalid Anthropic request JSON", async () => {
    const response = await handleKiroAnthropicMessages(
      {
        generateAssistantResponse: () => Promise.resolve(new Response(null, { status: 200 })),
        mcpCall: () => Promise.resolve(undefined),
      },
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: "not-json",
        headers: { "content-type": "application/json" },
      }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    })
  })

  test("handles web_search tool via MCP and returns Anthropic JSON with search results", async () => {
    const proxyEntries: Array<Record<string, unknown>> = []
    const mcpCall = ({ arguments: args }: { arguments?: { query?: string } }) => {
      if (args?.query === "Search for AAPL and GOOGL stock prices") {
        return Promise.resolve({
          id: "test",
          jsonrpc: "2.0",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  results: [
                    { title: "AAPL Stock", url: "https://example.com/aapl", snippet: "AAPL is at $200" },
                    { title: "GOOGL Stock", url: "https://example.com/googl", snippet: "GOOGL is at $180" },
                  ],
                }),
              },
            ],
            isError: false,
          },
        })
      }

      return Promise.resolve(undefined)
    }

    const response = await handleKiroAnthropicMessages(
      {
        generateAssistantResponse: () => Promise.resolve(new Response(null, { status: 200 })),
        mcpCall: (_method, params) => mcpCall(params as { arguments?: { query?: string } }),
      },
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-opus-4.6",
          max_tokens: 4096,
          messages: [{ role: "user", content: "Search for AAPL and GOOGL stock prices" }],
          tools: [{ type: "web_search_20260209", name: "web_search" }],
        }),
        headers: { "content-type": "application/json" },
      }),
      undefined,
      { onProxy: (entry) => proxyEntries.push(entry as Record<string, unknown>) },
    )

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.type).toBe("message")
    expect(body.role).toBe("assistant")
    const content = body.content as Array<{ type: string }>
    expect(content.some((block) => block.type === "server_tool_use")).toBe(true)
    expect(content.some((block) => block.type === "web_search_tool_result")).toBe(true)
    expect(content.some((block) => block.type === "text")).toBe(true)
    expect((body.usage as { server_tool_use?: { web_search_requests?: number } }).server_tool_use?.web_search_requests).toBe(1)
    expect(proxyEntries).toEqual([
      expect.objectContaining({
        label: "Kiro web_search",
        method: "POST",
        target: "/mcp",
        status: 200,
        error: "-",
      }),
    ])
  })

  test("handles web_search tool via MCP and returns streaming SSE", async () => {
    const mcpResponse = {
      id: "test",
      jsonrpc: "2.0",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              results: [{ title: "Result", url: "https://example.com", snippet: "A result" }],
              totalResults: 1,
            }),
          },
        ],
        isError: false,
      },
    }

    const response = await handleKiroAnthropicMessages(
      {
        generateAssistantResponse: () => Promise.resolve(new Response(null, { status: 200 })),
        mcpCall: () => Promise.resolve(mcpResponse),
      },
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-opus-4.6",
          max_tokens: 4096,
          stream: true,
          messages: [{ role: "user", content: "Search for something" }],
          tools: [{ type: "web_search_20260209", name: "web_search" }],
        }),
        headers: { "content-type": "application/json" },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const events = await readSse(response)
    expect(events.some((e) => e.event === "message_start")).toBe(true)
    expect(events.some((e) => e.data?.content_block?.type === "server_tool_use")).toBe(true)
    expect(events.some((e) => e.data?.content_block?.type === "web_search_tool_result")).toBe(true)
    expect(events.find((e) => e.event === "message_delta")?.data?.usage?.server_tool_use?.web_search_requests).toBe(1)
    expect(events.some((e) => e.event === "message_stop")).toBe(true)
  })

  test("splits bitcoin realtime queries into multiple web search calls", async () => {
    const queries: string[] = []
    const response = await handleKiroAnthropicMessages(
      {
        generateAssistantResponse: () => Promise.resolve(new Response(null, { status: 200 })),
        mcpCall: (_method, params) => {
          const query = ((params as { arguments?: { query?: string } }).arguments?.query ?? "")
          queries.push(query)
          return Promise.resolve({
            id: "test",
            jsonrpc: "2.0",
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    results: [{ title: `${query} result`, url: `https://example.com/${queries.length}`, snippet: "$100" }],
                  }),
                },
              ],
              isError: false,
            },
          })
        },
      },
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-opus-4.6",
          max_tokens: 4096,
          messages: [{ role: "user", content: "giá bitcoin hiện tại" }],
          tools: [{ type: "web_search_20260209", name: "web_search" }],
        }),
        headers: { "content-type": "application/json" },
      }),
    )

    const body = await response.json() as Record<string, unknown>
    const content = body.content as Array<{ type: string; input?: { query?: string } }>
    expect(content.filter((block) => block.type === "server_tool_use")).toHaveLength(2)
    expect(queries).toEqual(["giá bitcoin hiện tại", "Bitcoin price USD live"])
    expect((body.usage as { server_tool_use?: { web_search_requests?: number } }).server_tool_use?.web_search_requests).toBe(2)
  })

  test("returns 500 when MCP web search fails", async () => {
    const response = await handleKiroAnthropicMessages(
      {
        generateAssistantResponse: () => Promise.resolve(new Response(null, { status: 200 })),
        mcpCall: () => Promise.resolve(undefined),
      },
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-opus-4.6",
          max_tokens: 4096,
          messages: [{ role: "user", content: "Search for something" }],
          tools: [{ type: "web_search_20260209", name: "web_search" }],
        }),
        headers: { "content-type": "application/json" },
      }),
    )

    expect(response.status).toBe(500)
    const body = await response.json() as Record<string, unknown>
    expect(body).toMatchObject({
      type: "error",
      error: { type: "api_error" },
    })
  })
})
