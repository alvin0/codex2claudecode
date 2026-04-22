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
      contextUsagePercentage: undefined,
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
    const response = await handleKiroAnthropicMessages(
      {
        generateAssistantResponse: () =>
          Promise.resolve(
            new Response('{"content":"Hello"}{"usage":{"inputTokens":3,"outputTokens":5}}', {
              status: 200,
            }),
          ),
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
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      type: "message",
      role: "assistant",
      model: "CLAUDE_4_SONNET",
      content: [{ type: "text", text: "Hello" }],
      usage: { input_tokens: 3, output_tokens: 5 },
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
    const mcpResponse = {
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
              totalResults: 2,
              query: "AAPL GOOGL stock prices",
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
          messages: [{ role: "user", content: "Search for AAPL and GOOGL stock prices" }],
          tools: [{ type: "web_search_20260209", name: "web_search" }],
        }),
        headers: { "content-type": "application/json" },
      }),
    )

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.type).toBe("message")
    expect(body.role).toBe("assistant")
    const content = body.content as Array<{ type: string }>
    expect(content.some((block) => block.type === "server_tool_use")).toBe(true)
    expect(content.some((block) => block.type === "web_search_tool_result")).toBe(true)
    expect(content.some((block) => block.type === "text")).toBe(true)
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
    expect(events.some((e) => e.event === "message_stop")).toBe(true)
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
