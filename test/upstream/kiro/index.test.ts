import { describe, expect, test } from "bun:test"

import type { Canonical_Event, Canonical_Request } from "../../../src/core/canonical"
import { Kiro_Auth_Manager, Kiro_Client, Kiro_Upstream_Provider, computeEffectiveTools } from "../../../src/upstream/kiro"
import { PAYLOAD_SIZE_LIMIT_BYTES } from "../../../src/upstream/kiro/constants"
import { KiroHttpError, KiroMcpError, KiroNetworkError } from "../../../src/upstream/kiro/types"

function request(overrides: Partial<Canonical_Request> = {}): Canonical_Request {
  return {
    model: "claude-sonnet-4-5",
    instructions: "Be helpful",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [{ type: "function", name: "save" }, { type: "function", name: "load" }],
    stream: false,
    passthrough: false,
    metadata: {},
    ...overrides,
  }
}

function auth() {
  return new Kiro_Auth_Manager({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: new Date(Date.now() + 700_000).toISOString(),
    region: "us-east-1",
  }, "/tmp/unused")
}

function realProvider(response = new Response('{"content":"ok"}')) {
  const manager = auth()
  const client = new Kiro_Client(manager, { fetch: (() => Promise.resolve(response)) as unknown as typeof fetch })
  return new Kiro_Upstream_Provider({ auth: manager, client })
}

function providerWithClient(client: Pick<Kiro_Client, "generateAssistantResponse" | "listAvailableModels" | "checkHealth"> & Partial<Pick<Kiro_Client, "callMcpWebSearch">>) {
  return new Kiro_Upstream_Provider({ auth: auth(), client: client as Kiro_Client })
}

describe("Kiro upstream provider", () => {
  test("computes effective tools for all toolChoice variants", () => {
    const tools = request().tools!

    expect(computeEffectiveTools(tools)).toEqual({ tools })
    expect(computeEffectiveTools(tools, "auto")).toEqual({ tools })
    expect(computeEffectiveTools(tools, "required")).toEqual({ tools })
    expect(computeEffectiveTools(tools, "none")).toEqual({ tools: [] })
    expect(computeEffectiveTools(tools, { type: "function", name: "save" })).toEqual({ tools: [tools[0]] })
    expect(computeEffectiveTools(tools, { type: "function", function: { name: "load" } })).toEqual({ tools: [tools[1]] })
  })

  test("maps requested web_search server tool to a Kiro function tool", () => {
    const result = computeEffectiveTools([{ type: "web_search" }], { type: "web_search" })

    expect(result).toMatchObject({ webSearch: true })
    expect("tools" in result ? result.tools : []).toMatchObject([
      {
        type: "function",
        name: "web_search",
        parameters: { type: "object", required: ["query"] },
      },
    ])
  })

  test("auto-injects web_search for normal Kiro requests", async () => {
    let payload: any
    const result = await providerWithClient({
      generateAssistantResponse: (body) => {
        payload = body
        return Promise.resolve(new Response('{"content":"ok"}'))
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({ tools: [] }))

    expect(result.type).toBe("canonical_response")
    expect(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0].toolSpecification.name).toBe("web_search")
  })

  test("auto-injects web_search alongside Claude Code function tools", async () => {
    let payload: any
    let loggedPayload = ""
    const result = await providerWithClient({
      generateAssistantResponse: (body) => {
        payload = body
        return Promise.resolve(new Response('{"content":"ok"}'))
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      tools: [
        { type: "function", name: "Agent", parameters: { type: "object", required: ["description", "prompt"] } },
        { type: "function", name: "Bash", parameters: { type: "object", required: ["command"] } },
        { type: "function", name: "Read", parameters: { type: "object", required: ["file_path"] } },
        { type: "function", name: "Write", parameters: { type: "object", required: ["file_path", "content"] } },
      ],
    }), { onRequestBody: (body) => { loggedPayload = body } })

    const names = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.map((tool: any) => tool.toolSpecification.name)
    const loggedNames = JSON.parse(loggedPayload).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools.map((tool: any) => tool.toolSpecification.name)
    expect(result.type).toBe("canonical_response")
    expect(names).toEqual(["web_search", "Agent", "Bash", "Read", "Write"])
    expect(loggedNames).toEqual(names)
    expect(JSON.stringify(payload)).toContain("Do not refuse because the request is outside coding")
  })

  test("streaming responses surface a visible warning when Kiro payload history is trimmed", async () => {
    const oldText = "x".repeat(700_000)
    let payload: any
    let generateCalls = 0
    const originalWarn = console.warn
    console.warn = () => {}
    let result: Awaited<ReturnType<Kiro_Upstream_Provider["proxy"]>> | undefined
    try {
      result = await providerWithClient({
        generateAssistantResponse: (body) => {
          payload = body
          generateCalls += 1
          return Promise.resolve(new Response('{"content":"done"}'))
        },
        listAvailableModels: () => Promise.resolve([]),
        checkHealth: () => Promise.resolve({ ok: true }),
      }).proxy(request({
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: `old-user-${oldText}` }] },
          { role: "assistant", content: [{ type: "output_text", text: `old-assistant-${oldText}` }] },
          { role: "user", content: [{ type: "input_text", text: "answer the current short request" }] },
        ],
        tools: [],
      }))
    } finally {
      console.warn = originalWarn
    }

    expect(result?.type).toBe("canonical_stream")
    if (!result || result.type !== "canonical_stream") return

    const events: Canonical_Event[] = []
    for await (const event of result.events) events.push(event)
    const serializedPayload = JSON.stringify(payload)
    expect(new TextEncoder().encode(serializedPayload).length).toBeLessThanOrEqual(PAYLOAD_SIZE_LIMIT_BYTES)
    expect(serializedPayload).not.toContain("old-user-")
    expect(serializedPayload).not.toContain("old-assistant-")
    expect(serializedPayload).toContain("answer the current short request")
    expect(events[0]).toMatchObject({
      type: "text_delta",
    })
    expect(events[0].type === "text_delta" ? events[0].delta : "").toContain("[Gateway warning] Kiro request context was shortened")
    expect(events.some((event) => event.type === "text_delta" && event.delta === "done")).toBe(true)
    expect(generateCalls).toBe(1)
  })

  test("preflights explicit URL web_search as server tool blocks and prompt context", async () => {
    let payload: any
    let observedQuery = ""
    const result = await providerWithClient({
      generateAssistantResponse: (body) => {
        payload = body
        return Promise.resolve(new Response('{"content":"done"}'))
      },
      callMcpWebSearch: (query) => {
        observedQuery = query
        return Promise.resolve({
          toolUseId: "srvtoolu_search",
          results: { results: [{ title: "Article", url: query, snippet: "Snippet" }] },
          summary: `<web_search>\nSearch results for "${query}"\n</web_search>\n`,
        })
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      input: [{ role: "user", content: [{ type: "input_text", text: "su dung websearch https://example.com/article" }] }],
      tools: [],
      textFormat: {
        type: "json_schema",
        name: "summary",
        schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
      },
    }))

    expect(observedQuery).toBe("https://example.com/article")
    expect(JSON.stringify(payload)).toContain("The gateway has already executed `web_search`")
    expect(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0].toolSpecification.name).toBe("web_search")
    expect(result.type).toBe("canonical_response")
    expect(result.type === "canonical_response" ? result.content[0] : undefined).toMatchObject({
      type: "server_tool",
      blocks: [
        { type: "server_tool_use", input: { query: "https://example.com/article" } },
        { type: "web_search_tool_result" },
      ],
    })
    expect(result.type === "canonical_response" ? result.usage.serverToolUse?.webSearchRequests : undefined).toBe(1)
  })

  test("streaming explicit URL web_search emits tool use before waiting for MCP", async () => {
    let mcpStarted = false
    let generateCalls = 0
    let observedToolUseId = ""
    let resolveSearch!: (value: Awaited<ReturnType<Kiro_Client["callMcpWebSearch"]>>) => void
    const result = await providerWithClient({
      generateAssistantResponse: () => {
        generateCalls += 1
        return Promise.resolve(new Response('{"content":"done"}'))
      },
      callMcpWebSearch: (_query, options: any) => {
        mcpStarted = true
        observedToolUseId = options.toolUseId
        return new Promise((resolve) => {
          resolveSearch = resolve
        })
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "websearch https://example.com/article" }] }],
      tools: [],
    }))

    expect(result.type).toBe("canonical_stream")
    if (result.type !== "canonical_stream") return

    const iterator = result.events[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toMatchObject({
      type: "server_tool_block",
      blocks: [{ type: "server_tool_use", name: "web_search", input: { query: "https://example.com/article" } }],
    })
    expect(mcpStarted).toBe(false)

    const secondPromise = iterator.next()
    await Promise.resolve()
    expect(mcpStarted).toBe(true)
    expect(generateCalls).toBe(0)
    resolveSearch({
      toolUseId: observedToolUseId,
      results: { results: [{ title: "Article", url: "https://example.com/article", snippet: "Snippet" }] },
      summary: `<web_search>\nSearch results for "https://example.com/article"\n</web_search>\n`,
    })

    const second = await secondPromise
    expect(second.value).toMatchObject({
      type: "server_tool_block",
      blocks: [{ type: "web_search_tool_result", tool_use_id: observedToolUseId }],
    })

    const third = await iterator.next()
    expect(generateCalls).toBe(1)
    expect(third.value).toMatchObject({ type: "text_delta", delta: "done" })
    await iterator.return?.()
  })

  test("does not server-preflight web_search after Claude Code returns a tool result", async () => {
    let generateCalls = 0
    let mcpCalls = 0
    const result = await providerWithClient({
      generateAssistantResponse: () => {
        generateCalls += 1
        return Promise.resolve(new Response('{"content":"done"}'))
      },
      callMcpWebSearch: () => {
        mcpCalls += 1
        return Promise.resolve({ toolUseId: "srvtoolu_search", results: { results: [] }, summary: "" })
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      metadata: { source: "claude" },
      input: [
        { role: "user", content: [{ type: "input_text", text: "websearch https://example.com/article" }] },
        { role: "assistant", content: [{ type: "function_call", call_id: "toolu_search", name: "WebSearch", arguments: "{\"query\":\"https://example.com/article\"}" }] },
        { role: "tool", content: [{ type: "function_call_output", call_id: "toolu_search", output: "search result text" }] },
      ],
      tools: [{ type: "web_search" }],
    }))

    expect(result.type).toBe("canonical_response")
    expect(generateCalls).toBe(1)
    expect(mcpCalls).toBe(0)
  })

  test("does not server-preflight web_search for hidden-only helper queries", async () => {
    let generateCalls = 0
    let mcpCalls = 0
    const result = await providerWithClient({
      generateAssistantResponse: () => {
        generateCalls += 1
        return Promise.resolve(new Response('{"content":"done"}'))
      },
      callMcpWebSearch: () => {
        mcpCalls += 1
        return Promise.resolve({ toolUseId: "srvtoolu_search", results: { results: [] }, summary: "" })
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      metadata: { source: "claude" },
      input: [{
        role: "user",
        content: [{ type: "input_text", text: "Perform a web search for the query: <system-reminder>websearch https://hidden.example/context</system-reminder>" }],
      }],
      tools: [{ type: "web_search" }],
    }))

    expect(result.type).toBe("canonical_response")
    expect(generateCalls).toBe(1)
    expect(mcpCalls).toBe(0)
  })

  test("returns Claude Code client WebSearch tool calls when a client web tool is available", async () => {
    let generateCalls = 0
    let mcpCalls = 0
    const result = await providerWithClient({
      generateAssistantResponse: () => {
        generateCalls += 1
        return Promise.resolve(new Response('{"content":"done"}'))
      },
      callMcpWebSearch: () => {
        mcpCalls += 1
        return Promise.resolve({ toolUseId: "srvtoolu_search", results: { results: [] }, summary: "" })
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      stream: true,
      metadata: { source: "claude", claudeClientWebSearchToolName: "WebSearch" },
      input: [{ role: "user", content: [{ type: "input_text", text: "websearch https://example.com/article" }] }],
      tools: [{ type: "function", name: "WebSearch", parameters: { type: "object", required: ["query"] } }],
    }))

    expect(result.type).toBe("canonical_stream")
    if (result.type !== "canonical_stream") return

    const events: Canonical_Event[] = []
    for await (const event of result.events) events.push(event)
    expect(events[0]).toMatchObject({
      type: "tool_call_done",
      name: "WebSearch",
      arguments: "{\"query\":\"https://example.com/article\"}",
    })
    expect(events.at(-1)).toMatchObject({ type: "message_stop", stopReason: "tool_use" })
    expect(generateCalls).toBe(0)
    expect(mcpCalls).toBe(0)
  })

  test("honors toolChoice none for Claude Code client web tool shortcuts", async () => {
    let generateCalls = 0
    let mcpCalls = 0
    const result = await providerWithClient({
      generateAssistantResponse: () => {
        generateCalls += 1
        return Promise.resolve(new Response('{"content":"done"}'))
      },
      callMcpWebSearch: () => {
        mcpCalls += 1
        return Promise.resolve({ toolUseId: "srvtoolu_search", results: { results: [] }, summary: "" })
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      stream: true,
      toolChoice: "none",
      metadata: { source: "claude", claudeClientWebSearchToolName: "WebSearch" },
      input: [{ role: "user", content: [{ type: "input_text", text: "websearch https://example.com/article" }] }],
      tools: [{ type: "function", name: "WebSearch", parameters: { type: "object", required: ["query"] } }],
    }))

    expect(result.type).toBe("canonical_stream")
    if (result.type !== "canonical_stream") return

    const events: Canonical_Event[] = []
    for await (const event of result.events) events.push(event)
    expect(events.some((event) => event.type === "tool_call_done" && event.name === "WebSearch")).toBe(false)
    expect(events.some((event) => event.type === "text_delta" && event.delta === "done")).toBe(true)
    expect(generateCalls).toBe(1)
    expect(mcpCalls).toBe(0)
  })

  test("prefers an explicit Claude Code WebFetch tool choice over WebSearch metadata", async () => {
    let generateCalls = 0
    const result = await providerWithClient({
      generateAssistantResponse: () => {
        generateCalls += 1
        return Promise.resolve(new Response('{"content":"done"}'))
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      stream: true,
      toolChoice: { type: "function", name: "WebFetch" },
      metadata: { source: "claude", claudeClientWebSearchToolName: "WebSearch" },
      input: [{ role: "user", content: [{ type: "input_text", text: "websearch https://example.com/article" }] }],
      tools: [
        { type: "function", name: "WebFetch", parameters: { type: "object", required: ["url", "prompt"] } },
        { type: "function", name: "WebSearch", parameters: { type: "object", required: ["query"] } },
      ],
    }))

    expect(result.type).toBe("canonical_stream")
    if (result.type !== "canonical_stream") return

    const events: Canonical_Event[] = []
    for await (const event of result.events) events.push(event)
    expect(events[0]).toMatchObject({ type: "tool_call_done", name: "WebFetch" })
    expect(JSON.parse((events[0] as { arguments: string }).arguments)).toEqual({
      url: "https://example.com/article",
      prompt: "Summarize this page for the user.",
    })
    expect(events.at(-1)).toMatchObject({ type: "message_stop", stopReason: "tool_use" })
    expect(generateCalls).toBe(0)
  })

  test("does not emit invalid WebFetch arguments for non-URL web searches", async () => {
    let generateCalls = 0
    const result = await providerWithClient({
      generateAssistantResponse: () => {
        generateCalls += 1
        return Promise.resolve(new Response('{"content":"done"}'))
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      stream: true,
      metadata: { source: "claude", claudeClientWebSearchToolName: "WebFetch" },
      input: [{ role: "user", content: [{ type: "input_text", text: "websearch latest Kiro news" }] }],
      tools: [{ type: "function", name: "WebFetch", parameters: { type: "object", required: ["url", "prompt"] } }],
    }))

    expect(result.type).toBe("canonical_stream")
    if (result.type !== "canonical_stream") return

    const events: Canonical_Event[] = []
    for await (const event of result.events) events.push(event)
    expect(events.some((event) => event.type === "tool_call_done" && event.name === "WebFetch")).toBe(false)
    expect(events.some((event) => event.type === "text_delta" && event.delta === "done")).toBe(true)
    expect(generateCalls).toBe(1)
  })

  test("falls back to WebSearch instead of WebFetch for non-URL client web searches", async () => {
    let generateCalls = 0
    const result = await providerWithClient({
      generateAssistantResponse: () => {
        generateCalls += 1
        return Promise.resolve(new Response('{"content":"done"}'))
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      stream: true,
      metadata: { source: "claude", claudeClientWebSearchToolName: "WebFetch" },
      input: [{ role: "user", content: [{ type: "input_text", text: "websearch latest Kiro news" }] }],
      tools: [
        { type: "function", name: "WebFetch", parameters: { type: "object", required: ["url", "prompt"] } },
        { type: "function", name: "WebSearch", parameters: { type: "object", required: ["query"] } },
      ],
    }))

    expect(result.type).toBe("canonical_stream")
    if (result.type !== "canonical_stream") return

    const events: Canonical_Event[] = []
    for await (const event of result.events) events.push(event)
    expect(events[0]).toMatchObject({
      type: "tool_call_done",
      name: "WebSearch",
      arguments: "{\"query\":\"websearch latest Kiro news\"}",
    })
    expect(generateCalls).toBe(0)
  })

  test("ignores hidden Claude Code context when deciding client WebSearch tool calls", async () => {
    let generateCalls = 0
    let mcpCalls = 0
    const result = await providerWithClient({
      generateAssistantResponse: () => {
        generateCalls += 1
        return Promise.resolve(new Response('{"content":"done"}'))
      },
      callMcpWebSearch: () => {
        mcpCalls += 1
        return Promise.resolve({ toolUseId: "srvtoolu_search", results: { results: [] }, summary: "" })
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      stream: true,
      metadata: { source: "claude", claudeClientWebSearchToolName: "WebSearch" },
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "<system-reminder>websearch https://hidden.example/context</system-reminder>" },
          { type: "input_text", text: "<project-memory-context>recent project notes</project-memory-context>" },
          { type: "input_text", text: "hi" },
        ],
      }],
      tools: [{ type: "function", name: "WebSearch", parameters: { type: "object", required: ["query"] } }],
    }))

    expect(result.type).toBe("canonical_stream")
    if (result.type !== "canonical_stream") return

    const events: Canonical_Event[] = []
    for await (const event of result.events) events.push(event)
    expect(events.some((event) => event.type === "tool_call_done" && event.name === "WebSearch")).toBe(false)
    expect(events.some((event) => event.type === "text_delta" && event.delta === "done")).toBe(true)
    expect(generateCalls).toBe(1)
    expect(mcpCalls).toBe(0)
  })

  test("uses visible user text instead of hidden context for client WebSearch queries", async () => {
    const result = await providerWithClient({
      generateAssistantResponse: () => Promise.resolve(new Response('{"content":"done"}')),
      callMcpWebSearch: () => Promise.resolve({ toolUseId: "srvtoolu_search", results: { results: [] }, summary: "" }),
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      stream: true,
      metadata: { source: "claude", claudeClientWebSearchToolName: "WebSearch" },
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "<system-reminder>websearch https://hidden.example/context</system-reminder>" },
          { type: "input_text", text: "websearch https://example.com/article" },
        ],
      }],
      tools: [{ type: "function", name: "WebSearch", parameters: { type: "object", required: ["query"] } }],
    }))

    expect(result.type).toBe("canonical_stream")
    if (result.type !== "canonical_stream") return

    const events: Canonical_Event[] = []
    for await (const event of result.events) events.push(event)
    expect(events[0]).toMatchObject({
      type: "tool_call_done",
      name: "WebSearch",
      arguments: "{\"query\":\"https://example.com/article\"}",
    })
  })

  test("returns filesystem allowed-directories tool call for explicit access questions", async () => {
    let generateCalls = 0
    const result = await providerWithClient({
      generateAssistantResponse: () => {
        generateCalls += 1
        return Promise.resolve(new Response('{"content":"done"}'))
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      stream: true,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "hiện có thể đọc được folder nào trên hệ thống\n" },
          { type: "input_text", text: "tiếp tục" },
        ],
      }],
      tools: [{ type: "function", name: "mcp__filesystem__list_allowed_directories", parameters: { type: "object", properties: {} } }],
    }))

    expect(result.type).toBe("canonical_stream")
    if (result.type !== "canonical_stream") return

    const events: Canonical_Event[] = []
    for await (const event of result.events) events.push(event)
    expect(events[0]).toMatchObject({
      type: "tool_call_done",
      name: "mcp__filesystem__list_allowed_directories",
      arguments: "{}",
    })
    expect(events.at(-1)).toMatchObject({ type: "message_stop", stopReason: "tool_use" })
    expect(generateCalls).toBe(0)
  })

  test("does not repeat filesystem allowed-directories tool call after tool output", async () => {
    let generateCalls = 0
    const result = await providerWithClient({
      generateAssistantResponse: () => {
        generateCalls += 1
        return Promise.resolve(new Response('{"content":"done"}'))
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      stream: true,
      input: [
        { role: "user", content: [{ type: "input_text", text: "hiện có thể đọc được folder nào trên hệ thống" }] },
        { role: "assistant", content: [{ type: "function_call", call_id: "toolu_dirs", name: "mcp__filesystem__list_allowed_directories", arguments: "{}" }] },
        { role: "tool", content: [{ type: "function_call_output", call_id: "toolu_dirs", output: "/Users/dinh-ai" }] },
      ],
      tools: [{ type: "function", name: "mcp__filesystem__list_allowed_directories", parameters: { type: "object", properties: {} } }],
    }))

    expect(result.type).toBe("canonical_stream")
    if (result.type !== "canonical_stream") return

    const events: Canonical_Event[] = []
    for await (const event of result.events) events.push(event)
    expect(events.some((event) => event.type === "tool_call_done" && event.name === "mcp__filesystem__list_allowed_directories")).toBe(false)
    expect(events.some((event) => event.type === "text_delta" && event.delta === "done")).toBe(true)
    expect(generateCalls).toBe(1)
  })

  test("converts textFormat to prompt instructions instead of failing", async () => {
    let payload: any
    const result = await providerWithClient({
      generateAssistantResponse: (body) => {
        payload = body
        return Promise.resolve(new Response('{"content":"{\\"title\\":\\"Summarize article\\"}"}'))
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      tools: [],
      textFormat: {
        type: "json_schema",
        name: "title",
        schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
      },
    }))

    expect(result.type).toBe("canonical_response")
    expect(JSON.stringify(payload)).toContain("Structured output requested")
    expect(JSON.stringify(payload)).toContain("Return only valid JSON")
    expect(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools).toBeUndefined()
  })

  test("returns 400 for unsupported server tools before calling Kiro", async () => {
    let calls = 0
    const result = await providerWithClient({
      generateAssistantResponse: () => {
        calls += 1
        return Promise.resolve(new Response("{}"))
      },
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({ tools: [{ type: "mcp" }] }))

    expect(result).toMatchObject({ type: "canonical_error", status: 400 })
    expect(calls).toBe(0)
  })

  test("returns 400 when named toolChoice is missing", async () => {
    const result = await realProvider().proxy(request({ toolChoice: { type: "function", name: "missing" } }))
    expect(result).toEqual({
      type: "canonical_error",
      status: 400,
      headers: new Headers(),
      body: "Named tool_choice 'missing' was not found in provided tools",
    })
  })

  test("maps KiroHttpError to canonical error", async () => {
    const result = await providerWithClient({
      generateAssistantResponse: () => Promise.reject(new KiroHttpError(418, new Headers({ "x-test": "1" }), "teapot")),
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({ tools: [] }))

    expect(result).toMatchObject({ type: "canonical_error", status: 418, body: "teapot" })
    expect((result.type === "canonical_error" ? result.headers : new Headers()).get("x-test")).toBe("1")
  })

  test("maps KiroNetworkError to 504", async () => {
    const result = await providerWithClient({
      generateAssistantResponse: () => Promise.reject(new KiroNetworkError("network down")),
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({ tools: [] }))

    expect(result).toEqual({
      type: "canonical_error",
      status: 504,
      headers: new Headers(),
      body: "network down",
    })
  })

  test("maps Kiro MCP web_search parse errors to 502 during preflight", async () => {
    let generateCalls = 0
    const result = await providerWithClient({
      generateAssistantResponse: () => {
        generateCalls += 1
        return Promise.resolve(new Response('{"content":"done"}'))
      },
      callMcpWebSearch: () => Promise.reject(new KiroMcpError("Kiro MCP web_search returned malformed result text")),
      listAvailableModels: () => Promise.resolve([]),
      checkHealth: () => Promise.resolve({ ok: true }),
    }).proxy(request({
      input: [{ role: "user", content: [{ type: "input_text", text: "websearch https://example.com/article" }] }],
      tools: [],
    }))

    expect(result).toEqual({
      type: "canonical_error",
      status: 502,
      headers: new Headers(),
      body: "Kiro MCP web_search returned malformed result text",
    })
    expect(generateCalls).toBe(0)
  })

  test("ignores passthrough and returns canonical response", async () => {
    const result = await realProvider(new Response('{"content":"ok"}')).proxy(request({ passthrough: true, tools: [] }))
    expect(result.type).toBe("canonical_response")
  })
})
