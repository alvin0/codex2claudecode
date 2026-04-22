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
})
