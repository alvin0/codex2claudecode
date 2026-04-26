import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { AwsEventStreamParser, collectKiroResponse, ThinkingBlockExtractor } from "../../../src/upstream/kiro"
import { DEFAULT_MAX_INPUT_TOKENS } from "../../../src/upstream/kiro/constants"

function response(text: string) {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() } }))
}

const textChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _-".split("")

function safeText(maxLength: number) {
  return fc.array(fc.constantFrom(...textChars), { minLength: 1, maxLength }).map((chars) => chars.join(""))
}

describe("Kiro parser properties", () => {
  test("Property 17: AWS event-stream parsing correctness", () => {
    fc.assert(fc.property(safeText(30), fc.integer({ min: 0, max: 999 }), (content, usage) => {
      const parser = new AwsEventStreamParser()
      const first = `prefix {"content":"${content}`
      const second = `"}{"content":"${content}"}{"usage":${usage}} suffix`

      expect(parser.feed(new TextEncoder().encode(first))).toEqual([])
      expect(parser.feed(new TextEncoder().encode(second))).toEqual([{ content }, { usage }])
      expect(parser.feed(new TextEncoder().encode('{"content":"next"}'))).toEqual([{ content: "next" }])
    }), { numRuns: 100 })
  })

  test("Property 18: thinking block extraction", () => {
    fc.assert(fc.property(safeText(30), safeText(30), fc.boolean(), (thinking, regular, shortTag) => {
      const extractor = new ThinkingBlockExtractor()
      const open = shortTag ? "<think>" : "<thinking>"
      const close = shortTag ? "</think>" : "</thinking>"
      expect(extractor.feed(`${open}${thinking}${close}${regular}`)).toEqual({ thinking, regular })
    }), { numRuns: 100 })
  })

  test("Property 19: bracket-style tool call extraction preserves ordering and content", async () => {
    await fc.assert(fc.asyncProperty(safeText(20), safeText(20), fc.integer({ min: 0, max: 1000 }), async (prefix, suffix, value) => {
      const collected = await collectKiroResponse(response(JSON.stringify({ content: `${prefix}[Called save with args: {"value":${value}}]${suffix}` })), "m", [{ type: "function", name: "save" }], 1)
      expect(collected.stopReason).toBe("tool_use")
      expect(collected.content).toMatchObject([
        { type: "text", text: prefix },
        { type: "tool_call", name: "save", arguments: JSON.stringify({ value }) },
        { type: "text", text: suffix },
      ])
    }), { numRuns: 100 })
  })

  test("Property 20: token count estimation uses exact context percentage formula", async () => {
    await fc.assert(fc.asyncProperty(safeText(20), fc.integer({ min: 1, max: 100 }), async (text, percentage) => {
      const collected = await collectKiroResponse(response(`{"content":"${text}"}{"contextUsagePercentage":${percentage}}`), "m", [], 1)
      expect(collected.usage.outputTokens).toBeGreaterThanOrEqual(0)
      expect(collected.usage.inputTokens).toBe(Math.max(0, Math.floor((percentage / 100) * DEFAULT_MAX_INPUT_TOKENS) - collected.usage.outputTokens))
    }), { numRuns: 100 })
  })
})
