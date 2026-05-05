import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { claudeStreamResponse } from "../../src/inbound/claude/codex-response"
import { readSse, sse } from "../helpers"

function responseFromEvents(events: unknown[]) {
  return new Response(sse(events), { headers: { "content-type": "text/event-stream" } })
}

const minimalRequest = { model: "m", messages: [], stream: true }

/** Filter SSE events to only text-related ones (content_block_start with type "text" and content_block_delta with text_delta). */
function textEvents(events: Array<{ event?: string; data: any }>) {
  return events.filter(
    (e) =>
      (e.data.type === "content_block_start" && e.data.content_block?.type === "text") ||
      (e.data.type === "content_block_delta" && e.data.delta?.type === "text_delta"),
  )
}

describe("empty delta guard", () => {
  test("2.1 single empty delta produces no content_block_start or text_delta events", async () => {
    /**
     * Validates: Requirements 2.1
     * A single empty delta followed by response.completed should produce
     * no text content block and no text_delta events.
     */
    const events = await readSse(
      claudeStreamResponse(
        responseFromEvents([
          { type: "response.output_text.delta", delta: "" },
          { type: "response.completed", response: { usage: { output_tokens: 0 } } },
        ]),
        minimalRequest,
      ),
    )

    const text = textEvents(events)
    expect(text).toHaveLength(0)

    // message_start and message_stop are always emitted
    expect(events.some((e) => e.data.type === "message_start")).toBe(true)
    expect(events.some((e) => e.data.type === "message_stop")).toBe(true)
  })

  test("2.2 empty delta followed by non-empty delta only opens one content block", async () => {
    /**
     * Validates: Requirements 2.1, 3.1
     * An empty delta should be silently discarded. The subsequent non-empty
     * delta should open exactly one content block.
     */
    const events = await readSse(
      claudeStreamResponse(
        responseFromEvents([
          { type: "response.output_text.delta", delta: "" },
          { type: "response.output_text.delta", delta: "hello" },
          { type: "response.completed", response: { usage: { output_tokens: 1 } } },
        ]),
        minimalRequest,
      ),
    )

    const text = textEvents(events)
    const starts = text.filter((e) => e.data.type === "content_block_start")
    const deltas = text.filter((e) => e.data.type === "content_block_delta")

    expect(starts).toHaveLength(1)
    expect(starts[0].data.content_block.type).toBe("text")
    expect(deltas).toHaveLength(1)
    expect(deltas[0].data.delta.text).toBe("hello")
  })

  test("2.3 non-empty delta produces correct content_block_start and text_delta (preservation)", async () => {
    /**
     * Validates: Requirements 3.1
     * Non-empty deltas must continue to open content blocks and emit
     * text_delta events with the correct text.
     */
    const events = await readSse(
      claudeStreamResponse(
        responseFromEvents([
          { type: "response.output_text.delta", delta: "hello world" },
          { type: "response.completed", response: { usage: { output_tokens: 2 } } },
        ]),
        minimalRequest,
      ),
    )

    const text = textEvents(events)
    const starts = text.filter((e) => e.data.type === "content_block_start")
    const deltas = text.filter((e) => e.data.type === "content_block_delta")

    expect(starts).toHaveLength(1)
    expect(starts[0].data.content_block.type).toBe("text")
    expect(deltas).toHaveLength(1)
    expect(deltas[0].data.delta.type).toBe("text_delta")
    expect(deltas[0].data.delta.text).toBe("hello world")
  })

  test("2.4 mixed empty and non-empty deltas only emit events for non-empty deltas", async () => {
    /**
     * Validates: Requirements 2.1, 2.2, 3.1
     * Only non-empty deltas ("hello" and " world") should produce text_delta
     * events. All empty deltas should be silently discarded.
     */
    const deltas = ["", "hello", "", " world", ""]
    const events = await readSse(
      claudeStreamResponse(
        responseFromEvents([
          ...deltas.map((delta) => ({ type: "response.output_text.delta", delta })),
          { type: "response.completed", response: { usage: { output_tokens: 2 } } },
        ]),
        minimalRequest,
      ),
    )

    const text = textEvents(events)
    const textDeltas = text.filter((e) => e.data.type === "content_block_delta")

    expect(textDeltas).toHaveLength(2)
    expect(textDeltas[0].data.delta.text).toBe("hello")
    expect(textDeltas[1].data.delta.text).toBe(" world")

    // Only one content block should be opened for the consecutive non-empty deltas
    const starts = text.filter((e) => e.data.type === "content_block_start")
    expect(starts).toHaveLength(1)
  })
})

describe("property-based tests", () => {
  test("3.2 [PBT-fix] empty deltas produce no text SSE events", async () => {
    /**
     * Validates: Requirements 2.1, 2.2, 2.3
     *
     * Property 1: Bug Condition — For ANY sequence of empty string deltas,
     * claudeStreamResponse produces no content_block_start with type "text"
     * and no content_block_delta with type "text_delta".
     */
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        async (count) => {
          const emptyDeltas = Array.from({ length: count }, () => ({
            type: "response.output_text.delta",
            delta: "",
          }))

          const events = await readSse(
            claudeStreamResponse(
              responseFromEvents([
                ...emptyDeltas,
                { type: "response.completed", response: { usage: { output_tokens: 0 } } },
              ]),
              minimalRequest,
            ),
          )

          const text = textEvents(events)
          return text.length === 0
        },
      ),
      { numRuns: 50 },
    )
  })

  test("3.3 [PBT-preservation] non-empty deltas produce exactly one text_delta with exact text", async () => {
    /**
     * Validates: Requirements 3.1
     *
     * Property 2: Preservation — For ANY generated non-empty string delta,
     * claudeStreamResponse produces exactly one content_block_delta with
     * text_delta containing the exact delta text.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        async (deltaText) => {
          const events = await readSse(
            claudeStreamResponse(
              responseFromEvents([
                { type: "response.output_text.delta", delta: deltaText },
                { type: "response.completed", response: { usage: { output_tokens: 1 } } },
              ]),
              minimalRequest,
            ),
          )

          const text = textEvents(events)
          const deltas = text.filter((e) => e.data.type === "content_block_delta")
          const starts = text.filter((e) => e.data.type === "content_block_start")

          return (
            starts.length === 1 &&
            starts[0].data.content_block.type === "text" &&
            deltas.length === 1 &&
            deltas[0].data.delta.type === "text_delta" &&
            deltas[0].data.delta.text === deltaText
          )
        },
      ),
      { numRuns: 100 },
    )
  })
})
