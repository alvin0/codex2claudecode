import { describe, expect, test } from "bun:test"

import type { Canonical_Request } from "../../../src/core/canonical"
import { PAYLOAD_SIZE_LIMIT_BYTES, REASONING_EFFORT_BUDGETS, kiroPayloadSizeLimitBytes } from "../../../src/upstream/kiro/constants"
import { convertCanonicalToKiroPayload, sanitizeToolSchema, trimNoticeText, type KiroPayloadTrimNotice } from "../../../src/upstream/kiro"
import { PayloadTooLargeError, ToolNameTooLongError } from "../../../src/upstream/kiro/types"

function request(overrides: Partial<Canonical_Request> = {}): Canonical_Request {
  return {
    model: "claude-sonnet-4-5",
    instructions: "Be helpful",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
    ...overrides,
  }
}

const saveTool = { type: "function", name: "save", description: "", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } }

describe("Kiro payload conversion", () => {
  test("uses the Kiro issue #73 body-size threshold by default and supports env overrides", () => {
    expect(PAYLOAD_SIZE_LIMIT_BYTES).toBe(1_200_000)
    expect(kiroPayloadSizeLimitBytes({ KIRO_PAYLOAD_SIZE_LIMIT_BYTES: "900000" })).toBe(900_000)
    expect(kiroPayloadSizeLimitBytes({ KIRO_MAX_PAYLOAD_SIZE_MB: "1.25" })).toBe(1_250_000)
    expect(kiroPayloadSizeLimitBytes({ KIRO_PAYLOAD_SIZE_LIMIT_BYTES: "nope", KIRO_MAX_PAYLOAD_SIZE_MB: "0" })).toBe(PAYLOAD_SIZE_LIMIT_BYTES)
  })

  test("builds structural Kiro payload with tools and instructions", () => {
    const payload = convertCanonicalToKiroPayload(request({ tools: [saveTool] }), [saveTool], { modelId: "claude-sonnet-4.5", authType: "kiro_desktop", profileArn: "arn", instructions: "Be helpful" })

    expect(payload.profileArn).toBe("arn")
    expect(payload.conversationState.conversationId).toMatch(/[0-9a-f-]{36}/)
    expect(payload.conversationState.chatTriggerType).toBe("MANUAL")
    expect(payload.conversationState.currentMessage.userInputMessage).toMatchObject({ modelId: "claude-sonnet-4.5", origin: "AI_EDITOR" })
    expect(JSON.stringify(payload)).toContain("Be helpful")
    expect(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0].toolSpecification).toMatchObject({ name: "save", description: "Tool: save", inputSchema: { json: { type: "object", properties: {} } } })
  })

  test("omits empty history when there are no prior turns", () => {
    const payload = convertCanonicalToKiroPayload(request({ input: [] }), [], { modelId: "m", authType: "aws_sso_oidc" })

    expect(payload.conversationState.history).toBeUndefined()
    expect(payload.conversationState.currentMessage.userInputMessage.content).toBe("Continue")
  })

  test("moves assistant-final messages into history and uses Continue for current message", () => {
    const payload = convertCanonicalToKiroPayload(
      request({ input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }, { role: "assistant", content: [{ type: "output_text", text: "done" }] }] }),
      [],
      { modelId: "m", authType: "aws_sso_oidc" },
    )

    expect(payload.conversationState.history).toEqual([
      { userInputMessage: { content: "hello", modelId: "m", origin: "AI_EDITOR" } },
      { assistantResponseMessage: { content: "done" } },
    ])
    expect(payload.conversationState.currentMessage.userInputMessage.content).toBe("Continue")
  })

  test("extracts tool-role results into current message and uses Continue when the turn has only tool results", () => {
    const payload = convertCanonicalToKiroPayload(
      request({ input: [{ role: "assistant", content: [{ type: "function_call", call_id: "call_1", name: "save", arguments: "{}" }] }, { role: "tool", content: [{ type: "function_call_output", call_id: "call_1", output: "ok" }] }] }),
      [saveTool],
      { modelId: "m", authType: "aws_sso_oidc" },
    )

    expect(payload.profileArn).toBeUndefined()
    expect(payload.conversationState.currentMessage.userInputMessage.content).toBe("Continue")
    expect(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults).toEqual([{ toolUseId: "call_1", content: [{ text: "ok" }], status: "success" }])
  })

  test("preserves matching structured tool results when tools are enabled", () => {
    const payload = convertCanonicalToKiroPayload(
      request({
        input: [
          { role: "user", content: [{ type: "input_text", text: "please save" }] },
          { role: "assistant", content: [{ type: "function_call", call_id: "call_1", name: "save", arguments: "{\"x\":1}" }] },
          { role: "tool", content: [{ type: "function_call_output", call_id: "call_1", output: "ok" }] },
        ],
      }),
      [saveTool],
      { modelId: "m", authType: "aws_sso_oidc" },
    )

    const current = payload.conversationState.currentMessage.userInputMessage
    expect(current.userInputMessageContext?.toolResults).toEqual([{ toolUseId: "call_1", content: [{ text: "ok" }], status: "success" }])
    expect(JSON.stringify(payload.conversationState.history)).toContain("toolUses")
  })

  test("embeds system instructions into history when present and into current message when history is empty", () => {
    const withHistory = convertCanonicalToKiroPayload(
      request({ input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }, { role: "assistant", content: [{ type: "output_text", text: "done" }] }] }),
      [],
      { modelId: "m", authType: "aws_sso_oidc", instructions: "System prompt" },
    )
    const currentOnly = convertCanonicalToKiroPayload(request({ input: [] }), [], { modelId: "m", authType: "aws_sso_oidc", instructions: "System prompt" })

    expect(withHistory.conversationState.history?.[0]).toEqual({ userInputMessage: { content: "System prompt\n\nhello", modelId: "m", origin: "AI_EDITOR" } })
    expect(withHistory.conversationState.currentMessage.userInputMessage.content).toBe("Continue")
    expect(currentOnly.conversationState.currentMessage.userInputMessage.content).toBe("System prompt\n\nContinue")
  })

  test("converts tools to text when effective tools are empty using exact formats", () => {
    const payload = convertCanonicalToKiroPayload(
      request({
        input: [
          { role: "assistant", content: [{ type: "function_call", call_id: "call_1", name: "save", arguments: "{\"x\":1}" }] },
          { role: "tool", content: [{ type: "function_call_output", call_id: "call_1", output: "ok" }] },
        ],
      }),
      [],
      { modelId: "m", authType: "aws_sso_oidc" },
    )

    expect(payload.conversationState.history).toEqual([
      { userInputMessage: { content: "(empty)", modelId: "m", origin: "AI_EDITOR" } },
      { assistantResponseMessage: { content: "[Tool: save (call_1)]\n{\"x\":1}" } },
    ])
    expect(payload.conversationState.currentMessage.userInputMessage.content).toBe("[Tool Result (call_1)]\nok")
    expect(JSON.stringify(payload)).not.toContain("toolUses")
    expect(JSON.stringify(payload)).not.toContain("toolResults")
  })

  test("named toolChoice cleans the whole pre-split array while preserving the selected tool", () => {
    const payload = convertCanonicalToKiroPayload(
      request({
        toolChoice: { type: "function", name: "save" },
        input: [
          { role: "assistant", content: [{ type: "function_call", call_id: "call_1", name: "save", arguments: "{\"x\":1}" }, { type: "function_call", call_id: "call_2", name: "skip", arguments: "{}" }] },
          { role: "tool", content: [{ type: "function_call_output", call_id: "call_1", output: "saved" }, { type: "function_call_output", call_id: "call_2", output: "skipped" }] },
        ],
      }),
      [saveTool],
      { modelId: "m", authType: "aws_sso_oidc" },
    )

    const current = payload.conversationState.currentMessage.userInputMessage
    expect(current.content).toBe("[Tool Result (call_2)]\nskipped")
    expect(current.userInputMessageContext?.toolResults).toEqual([{ toolUseId: "call_1", content: [{ text: "saved" }], status: "success" }])
    expect(JSON.stringify(payload.conversationState.history)).toContain('"toolUseId":"call_1"')
    expect(JSON.stringify(payload.conversationState.history)).toContain("[Tool: skip (call_2)]")
    expect(JSON.stringify(current.userInputMessageContext ?? {})).not.toContain("call_2")
  })

  test("moves overflowing tool descriptions into the system prompt", () => {
    const longDescription = "d".repeat(10_001)
    const payload = convertCanonicalToKiroPayload(
      request({ tools: [{ ...saveTool, description: longDescription }] }),
      [{ ...saveTool, description: longDescription }],
      { modelId: "m", authType: "aws_sso_oidc" },
    )

    expect(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0].toolSpecification.description).toBe("See system prompt for full documentation for save.")
    expect(payload.conversationState.currentMessage.userInputMessage.content).toContain("Tool documentation:")
    expect(payload.conversationState.currentMessage.userInputMessage.content).toContain(longDescription)
  })

  test("prefers parameters over input_schema and falls back to input_schema then default schema", () => {
    const payload = convertCanonicalToKiroPayload(
      request({
        tools: [
          {
            type: "function",
            name: "primary",
            parameters: { type: "object", properties: { preferred: { type: "string", required: [], additionalProperties: false } }, required: [], additionalProperties: false },
            input_schema: { type: "object", properties: { ignored: { type: "number" } } },
          },
          {
            type: "function",
            name: "fallback",
            input_schema: { type: "object", properties: { fallback: { type: "number", additionalProperties: false } }, required: [], additionalProperties: false },
          },
          { type: "function", name: "default" },
        ],
      }),
      [
        {
          type: "function",
          name: "primary",
          parameters: { type: "object", properties: { preferred: { type: "string", required: [], additionalProperties: false } }, required: [], additionalProperties: false },
          input_schema: { type: "object", properties: { ignored: { type: "number" } } },
        },
        {
          type: "function",
          name: "fallback",
          input_schema: { type: "object", properties: { fallback: { type: "number", additionalProperties: false } }, required: [], additionalProperties: false },
        },
        { type: "function", name: "default" },
      ],
      { modelId: "m", authType: "aws_sso_oidc" },
    )

    expect(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools).toEqual([
      { toolSpecification: { name: "primary", description: "Tool: primary", inputSchema: { json: { type: "object", properties: { preferred: { type: "string" } } } } } },
      { toolSpecification: { name: "fallback", description: "Tool: fallback", inputSchema: { json: { type: "object", properties: { fallback: { type: "number" } } } } } },
      { toolSpecification: { name: "default", description: "Tool: default", inputSchema: { json: { type: "object", properties: {} } } } },
    ])
  })

  test("converts image data URLs and unsupported attachments into expected payload fields and placeholders", () => {
    const payload = convertCanonicalToKiroPayload(
      request({
        input: [{
          role: "user",
          content: [
            { type: "input_image", image_url: "data:image/png;base64,abc" },
            { type: "input_image", image_url: "https://example.test/image.png" },
            { type: "input_file", filename: "a.txt", file_data: `data:text/plain;base64,${Buffer.from("doc").toString("base64")}` },
            { type: "input_file", filename: "bin.pdf", file_data: `data:application/pdf;base64,${Buffer.from("%PDF").toString("base64")}` },
          ],
        }],
      }),
      [],
      { modelId: "m", authType: "aws_sso_oidc" },
    )

    expect(payload.conversationState.currentMessage.userInputMessage.images).toEqual([{ format: "png", source: { bytes: "abc" } }])
    expect(payload.conversationState.currentMessage.userInputMessage.content).toContain("[Unsupported: URL-based image skipped")
    expect(payload.conversationState.currentMessage.userInputMessage.content).toContain("Document: a.txt\n\ndoc")
    expect(payload.conversationState.currentMessage.userInputMessage.content).toContain("[Unsupported: binary document \"bin.pdf\" skipped")
  })

  test("includes profileArn only for Desktop auth and omits it for SSO", () => {
    const desktop = convertCanonicalToKiroPayload(request(), [], { modelId: "m", authType: "kiro_desktop", profileArn: "arn:desktop" })
    const sso = convertCanonicalToKiroPayload(request(), [], { modelId: "m", authType: "aws_sso_oidc", profileArn: "arn:sso" })

    expect(desktop.profileArn).toBe("arn:desktop")
    expect(sso.profileArn).toBeUndefined()
  })

  test("omits empty toolUses from assistant history entries", () => {
    const payload = convertCanonicalToKiroPayload(
      request({ input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }, { role: "assistant", content: [{ type: "output_text", text: "done" }] }] }),
      [saveTool],
      { modelId: "m", authType: "aws_sso_oidc" },
    )

    expect(payload.conversationState.history?.[1]).toEqual({ assistantResponseMessage: { content: "done" } })
  })

  test("injects thinking tags for supported reasoningEffort values", () => {
    for (const [reasoningEffort, budget] of Object.entries(REASONING_EFFORT_BUDGETS)) {
      const payload = convertCanonicalToKiroPayload(request({ reasoningEffort }), [], { modelId: "m", authType: "aws_sso_oidc" })
      expect(payload.conversationState.currentMessage.userInputMessage.content).toContain("<thinking_mode>enabled</thinking_mode>")
      expect(payload.conversationState.currentMessage.userInputMessage.content).toContain(`<max_thinking_length>${budget}</max_thinking_length>`)
    }
  })

  test("logs warnings for stripped server-tool content and unsupported attachments", () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message?: unknown) => warnings.push(String(message))
    try {
      convertCanonicalToKiroPayload(
        request({ input: [{ role: "user", content: [{ type: "web_search" }, { type: "input_image", image_url: "https://example.test/image.png" }, { type: "input_file", filename: "remote.pdf", file_url: "https://example.test/doc.pdf" }] }] }),
        [],
        { modelId: "m", authType: "aws_sso_oidc" },
      )
    } finally {
      console.warn = originalWarn
    }
    expect(warnings.some((warning) => warning.includes("Stripping historical server-tool content"))).toBe(true)
    expect(warnings.some((warning) => warning.includes("URL-based image"))).toBe(true)
    expect(warnings.some((warning) => warning.includes("URL-based or file-ID-based"))).toBe(true)
  })

  test("logs warnings for messages containing only stripped server-tool content", () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message?: unknown) => warnings.push(String(message))
    try {
      convertCanonicalToKiroPayload(
        request({ input: [{ role: "user", content: [{ type: "web_search" }] }] }),
        [],
        { modelId: "m", authType: "aws_sso_oidc" },
      )
    } finally {
      console.warn = originalWarn
    }
    expect(warnings.some((warning) => warning.includes("Stripping historical server-tool content"))).toBe(true)
  })

  test("trimming removes oldest history, re-embeds instructions, and converts orphaned results to text", () => {
    const oldText = "x".repeat(180_000)
    const newText = "y".repeat(410_000)
    const warnings: string[] = []
    let notice: KiroPayloadTrimNotice | undefined
    const originalWarn = console.warn
    console.warn = (message?: unknown) => warnings.push(String(message))
    let payload!: ReturnType<typeof convertCanonicalToKiroPayload>
    try {
      payload = convertCanonicalToKiroPayload(
        request({
          input: [
            { role: "user", content: [{ type: "input_text", text: `old-user-${oldText}` }] },
            { role: "assistant", content: [{ type: "output_text", text: `old-assistant-${oldText}` }] },
            { role: "user", content: [{ type: "input_text", text: `new-user-${newText}` }] },
            { role: "assistant", content: [{ type: "function_call", call_id: "call_1", name: "save", arguments: "{}" }] },
            { role: "tool", content: [{ type: "function_call_output", call_id: "call_1", output: "ok" }] },
          ],
        }),
        [saveTool],
        { modelId: "m", authType: "aws_sso_oidc", instructions: "System prompt", payloadSizeLimitBytes: 400_000, onTrim: (item) => { notice = item } },
      )
    } finally {
      console.warn = originalWarn
    }

    const serialized = JSON.stringify(payload)
    expect(new TextEncoder().encode(serialized).length).toBeLessThan(400_000)
    expect(serialized).not.toContain("old-user-")
    expect(serialized).not.toContain("new-user-")
    expect(serialized).not.toContain('"toolUses"')
    expect(payload.conversationState.currentMessage.userInputMessage.content).toContain("System prompt")
    expect(payload.conversationState.currentMessage.userInputMessage.content.match(/System prompt/g)).toHaveLength(1)
    expect(payload.conversationState.currentMessage.userInputMessage.content).toContain("[Tool Result (call_1)]\nok")
    expect(notice?.removedHistoryEntries).toBeGreaterThan(0)
    expect(notice?.finalSize).toBeLessThanOrEqual(notice?.limit ?? 0)
    expect(warnings).toContain(trimNoticeText(notice!))
  })

  test("throws typed errors for oversized final payload and long tool names", () => {
    expect(() => convertCanonicalToKiroPayload(request(), [{ ...saveTool, name: "x".repeat(65) }], { modelId: "m", authType: "aws_sso_oidc" })).toThrow(ToolNameTooLongError)
    expect(() => convertCanonicalToKiroPayload(request({ input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(410_000) }] }] }), [], { modelId: "m", authType: "aws_sso_oidc", payloadSizeLimitBytes: 400_000 })).toThrow(PayloadTooLargeError)
  })

  test("property: schema sanitization is idempotent", () => {
    for (let index = 0; index < 100; index += 1) {
      const schema = { type: "object", required: index % 2 ? ["x"] : [], additionalProperties: false, properties: { x: { type: "string", additionalProperties: true, required: [] } } }
      expect(sanitizeToolSchema(sanitizeToolSchema(schema))).toEqual(sanitizeToolSchema(schema))
    }
  })
})
