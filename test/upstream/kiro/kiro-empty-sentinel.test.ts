import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { collectKiroResponse, streamKiroResponse } from "../../../src/upstream/kiro/parse"
import type { Canonical_Event } from "../../../src/core/canonical"

// --- Helpers ---

function kiroStream(events: unknown[]) {
  const encoder = new TextEncoder()
  const data = events.map((e) => JSON.stringify(e)).join("")
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(data))
        controller.close()
      },
    }),
  )
}

async function collectEvents(response: { events: AsyncIterable<Canonical_Event> }) {
  const events: Canonical_Event[] = []
  for await (const event of response.events) {
    events.push(event)
  }
  return events
}

// --- Unit Tests (Tasks 6.1–6.5) ---

describe("Kiro sentinel filter", () => {
  // Task 6.1: content: "(empty)" produces no text_delta events
  test("sentinel content produces no text_delta events", async () => {
    const response = streamKiroResponse(kiroStream([{ content: "(empty)" }, { stop: true, usage: 5 }]), "test-model", [], 100)
    const events = await collectEvents(response)

    const textDeltas = events.filter((e) => e.type === "text_delta")
    expect(textDeltas).toHaveLength(0)
  })

  // Task 6.2: content: "(empty)" is not concatenated into accumulated text
  test("sentinel content is not concatenated into accumulated text", async () => {
    const response = await collectKiroResponse(kiroStream([{ content: "(empty)" }, { stop: true, usage: 5 }]), "test-model", [], 100)

    const textBlocks = response.content.filter((b) => b.type === "text")
    // Either no text blocks, or none contain "(empty)"
    for (const block of textBlocks) {
      if (block.type === "text") {
        expect(block.text).not.toContain("(empty)")
      }
    }
  })

  // Task 6.3: sentinel followed by real content only yields the real content
  test("sentinel followed by real content only yields real content", async () => {
    const response = streamKiroResponse(kiroStream([{ content: "(empty)" }, { content: "hello world" }, { stop: true, usage: 10 }]), "test-model", [], 100)
    const events = await collectEvents(response)

    const textDeltas = events.filter((e) => e.type === "text_delta")
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0]).toMatchObject({ type: "text_delta", delta: "hello world" })
  })

  // Task 6.4: near-sentinel strings are NOT filtered
  test("near-sentinel strings are NOT filtered", async () => {
    const nearSentinels = ["(empty) ", "(EMPTY)", "(empty", "empty)"]

    for (const content of nearSentinels) {
      const response = streamKiroResponse(kiroStream([{ content }, { stop: true, usage: 5 }]), "test-model", [], 100)
      const events = await collectEvents(response)

      const textDeltas = events.filter((e) => e.type === "text_delta")
      expect(textDeltas.length).toBeGreaterThanOrEqual(1)
      const allDeltaText = textDeltas.map((e) => (e as { delta: string }).delta).join("")
      expect(allDeltaText).toContain(content)
    }
  })

  // Task 6.5: collectKiroResponse excludes sentinel from response text
  test("collectKiroResponse excludes sentinel from response text", async () => {
    const response = await collectKiroResponse(kiroStream([{ content: "(empty)" }, { content: "real text" }, { stop: true, usage: 10 }]), "test-model", [], 100)

    const allText = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("")

    expect(allText).toBe("real text")
    expect(allText).not.toContain("(empty)")
  })
})

// --- Property-Based Tests (Tasks 7.2–7.3) ---

describe("Kiro sentinel property-based tests", () => {
  // Task 7.2 [PBT-fix]: For any number of "(empty)" sentinel events, no text_delta with "(empty)" is yielded
  // **Validates: Requirements 2.4, 2.5, 2.6**
  test("no text_delta with sentinel value is ever yielded regardless of sentinel count", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (sentinelCount) => {
        const events: unknown[] = []
        for (let i = 0; i < sentinelCount; i++) {
          events.push({ content: "(empty)" })
        }
        events.push({ stop: true, usage: 5 })

        const response = streamKiroResponse(kiroStream(events), "test-model", [], 100)
        const collected = await collectEvents(response)

        const textDeltas = collected.filter((e) => e.type === "text_delta")
        for (const delta of textDeltas) {
          if (delta.type === "text_delta") {
            expect(delta.delta).not.toBe("(empty)")
          }
        }
        // With only sentinel events, there should be no text_delta at all
        expect(textDeltas).toHaveLength(0)
      }),
      { numRuns: 50 },
    )
  })

  // Task 7.3 [PBT-preservation]: For any non-sentinel content string, streamKiroResponse produces a text_delta with the exact content
  // **Validates: Requirements 3.7, 3.8, 3.9**
  test("non-sentinel content always produces a text_delta with exact content", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((s) => s !== "(empty)"),
        async (content) => {
          const response = streamKiroResponse(kiroStream([{ content }, { stop: true, usage: 5 }]), "test-model", [], 100)
          const collected = await collectEvents(response)

          const textDeltas = collected.filter((e) => e.type === "text_delta")
          const allDeltaText = textDeltas.map((e) => (e as { delta: string }).delta).join("")
          expect(allDeltaText).toBe(content)
        },
      ),
      { numRuns: 100 },
    )
  })
})
