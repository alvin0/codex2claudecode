import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_Request } from "../../../src/core/canonical"
import { convertCanonicalToKiroPayload, sanitizeToolSchema } from "../../../src/upstream/kiro"
import { PAYLOAD_SIZE_LIMIT_BYTES } from "../../../src/upstream/kiro/constants"

const tool = { type: "function", name: "save", description: "save", parameters: { type: "object", properties: {} } }
const textChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,_-".split("")
const nameChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_".split("")
const encoder = new TextEncoder()

function safeText(maxLength: number) {
  return fc.array(fc.constantFrom(...textChars), { minLength: 1, maxLength }).map((chars) => chars.join(""))
}

function safeName(maxLength: number) {
  return fc.array(fc.constantFrom(...nameChars), { minLength: 1, maxLength }).map((chars) => chars.join(""))
}

function request(input: Canonical_Request["input"], tools = [tool], toolChoice?: Canonical_Request["toolChoice"]): Canonical_Request {
  return { model: "m", input, tools, toolChoice, stream: false, passthrough: false, metadata: {} }
}

describe("Kiro payload properties", () => {
  test("Property 7: payload conversion structural correctness", () => {
    fc.assert(fc.property(safeText(100), (text) => {
      const payload = convertCanonicalToKiroPayload(request([{ role: "user", content: [{ type: "input_text", text }] }]), [tool], { modelId: "m", authType: "aws_sso_oidc" })
      expect(payload.conversationState.conversationId).toMatch(/[0-9a-f-]{36}/)
      expect(payload.conversationState.chatTriggerType).toBe("MANUAL")
      expect(payload.conversationState.currentMessage.userInputMessage.content.length).toBeGreaterThan(0)
      expect(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools).toHaveLength(1)
      expect(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0].toolSpecification.name).toBe("save")
    }), { numRuns: 100 })
  })

  test("Property 8: tool-role extraction correctness", () => {
    fc.assert(fc.property(fc.oneof(fc.constant(""), safeText(50)), (output) => {
      const payload = convertCanonicalToKiroPayload(
        request([
          { role: "assistant", content: [{ type: "function_call", call_id: "call_1", name: "save", arguments: "{}" }] },
          { role: "tool", content: [{ type: "function_call_output", call_id: "call_1", output }] },
        ]),
        [tool],
        { modelId: "m", authType: "aws_sso_oidc" },
      )

      expect(payload.conversationState.currentMessage.userInputMessage.content).toBe("Continue")
      expect(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults).toEqual([
        { toolUseId: "call_1", content: [{ text: output || "(empty result)" }], status: "success" },
      ])
    }), { numRuns: 100 })
  })

  test("Property 9: schema sanitization idempotence", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), (required, additional) => {
      const schema = { type: "object", ...(required ? { required: [] } : {}), ...(additional ? { additionalProperties: false } : {}), properties: { x: { type: "string", required: [], additionalProperties: true } } }
      expect(sanitizeToolSchema(sanitizeToolSchema(schema))).toEqual(sanitizeToolSchema(schema))
    }), { numRuns: 100 })
  })

  test("Property 10: content and tool call structure are preserved without named toolChoice", () => {
    fc.assert(fc.property(safeText(100), fc.integer({ min: 0, max: 1000 }), (text, value) => {
      const payload = convertCanonicalToKiroPayload(
        request([
          { role: "user", content: [{ type: "input_text", text }] },
          { role: "assistant", content: [{ type: "function_call", call_id: "call_1", name: "save", arguments: JSON.stringify({ value }) }] },
        ]),
        [tool],
        { modelId: "m", authType: "aws_sso_oidc" },
      )

      expect(JSON.stringify(payload)).toContain(text)
      const assistant = payload.conversationState.history?.find((entry) => "assistantResponseMessage" in entry)
      expect(assistant).toEqual({ assistantResponseMessage: { content: "(empty)", toolUses: [{ toolUseId: "call_1", name: "save", input: { value } }] } })
    }), { numRuns: 100 })
  })

  test("Property 11: no-tools conversion removes structured tool fields and uses exact text formats", () => {
    fc.assert(fc.property(safeName(20), safeText(50), (name, output) => {
      const payload = convertCanonicalToKiroPayload(
        request([
          { role: "assistant", content: [{ type: "function_call", call_id: "call_1", name, arguments: "{}" }] },
          { role: "tool", content: [{ type: "function_call_output", call_id: "call_1", output }] },
        ], []),
        [],
        { modelId: "m", authType: "aws_sso_oidc" },
      )

      const history = payload.conversationState.history ?? []
      const serialized = JSON.stringify(payload)
      expect(history[1]).toEqual({ assistantResponseMessage: { content: `[Tool: ${name} (call_1)]\n{}` } })
      expect(payload.conversationState.currentMessage.userInputMessage.content).toBe(`[Tool Result (call_1)]\n${output}`)
      expect(serialized).not.toContain("toolUses")
      expect(serialized).not.toContain("toolResults")
    }), { numRuns: 100 })
  })

  test("Property 14: orphaned toolResults convert to text in history and current message", () => {
    fc.assert(fc.property(safeText(40), safeText(40), (historyOutput, currentOutput) => {
      const payload = convertCanonicalToKiroPayload(
        request([
          { role: "user", content: [{ type: "input_text", text: "start" }] },
          { role: "assistant", content: [{ type: "output_text", text: "done" }] },
          { role: "tool", content: [{ type: "function_call_output", call_id: "missing_1", output: historyOutput }] },
          { role: "assistant", content: [{ type: "output_text", text: "again" }] },
          { role: "tool", content: [{ type: "function_call_output", call_id: "missing_2", output: currentOutput }] },
        ]),
        [tool],
        { modelId: "m", authType: "aws_sso_oidc" },
      )

      const orphanHistory = payload.conversationState.history?.find((entry) => "userInputMessage" in entry && entry.userInputMessage.content.includes("missing_1"))
      expect(orphanHistory).toEqual({ userInputMessage: { content: `[Tool Result (missing_1)]\n${historyOutput}`, modelId: "m", origin: "AI_EDITOR" } })
      expect(payload.conversationState.currentMessage.userInputMessage.content).toContain(`[Tool Result (missing_2)]\n${currentOutput}`)
      expect(JSON.stringify(payload)).not.toContain("\"toolResults\"")
    }), { numRuns: 100 })
  })

  test("Property 15: trimming converges and preserves payload invariants", () => {
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      fc.assert(fc.property(fc.integer({ min: 2, max: 3 }), (pairCount) => {
        const largeText = "x".repeat(110_000)
        const input: Canonical_Request["input"] = []
        for (let index = 0; index < pairCount; index += 1) {
          input.push({ role: "user", content: [{ type: "input_text", text: `user-${index}-${largeText}` }] })
          input.push({ role: "assistant", content: [{ type: "output_text", text: `assistant-${index}-${largeText}` }] })
        }
        input.push({ role: "tool", content: [{ type: "function_call_output", call_id: "missing", output: "orphan" }] })

        const payload = convertCanonicalToKiroPayload(request(input), [tool], { modelId: "m", authType: "aws_sso_oidc", instructions: "System prompt", payloadSizeLimitBytes: 400_000 })
        const serialized = JSON.stringify(payload)
        const history = payload.conversationState.history ?? []
        const instructionTarget = history.find((entry) => "userInputMessage" in entry)?.userInputMessage.content ?? payload.conversationState.currentMessage.userInputMessage.content

        expect(encoder.encode(serialized).length).toBeLessThanOrEqual(PAYLOAD_SIZE_LIMIT_BYTES)
        if (history.length) expect("userInputMessage" in history[0]).toBe(true)
        for (let index = 1; index < history.length; index += 1) expect("userInputMessage" in history[index]).not.toBe("userInputMessage" in history[index - 1])
        expect(instructionTarget).toContain("System prompt")
        expect(payload.conversationState.currentMessage.userInputMessage.content).toContain("[Tool Result (missing)]\norphan")
        expect(serialized).not.toContain("\"toolResults\"")
        for (const entry of history) {
          if ("userInputMessage" in entry) expect(entry.userInputMessage.content.length).toBeGreaterThan(0)
          else expect(entry.assistantResponseMessage.content.length).toBeGreaterThan(0)
        }
      }), { numRuns: 100 })
    } finally {
      console.warn = originalWarn
    }
  })
})
