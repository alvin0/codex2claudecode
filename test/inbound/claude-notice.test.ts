import { describe, expect, test } from "bun:test"
import type { Canonical_Event, Canonical_FeatureNotice, Canonical_Response, Canonical_StreamResponse } from "../../src/core/canonical"
import { StreamTelemetryCollector } from "../../src/core/stream-telemetry"
import { CLAUDE_NOTICE_MARKER, prependClaudeWarning, renderClaudeFeatureWarning } from "../../src/inbound/claude/notice"
import { canonicalResponseToClaudeMessage, claudeCanonicalStreamResponse } from "../../src/inbound/claude/response"
import type { ClaudeMessagesRequest } from "../../src/inbound/types"
import { textNotices } from "../native/observation"
import { readSse } from "../helpers"

function degrade(feature: Canonical_FeatureNotice["feature"], detail: string): Canonical_FeatureNotice {
  return { feature, policy: "degrade", detail }
}

function emulate(feature: Canonical_FeatureNotice["feature"], detail: string): Canonical_FeatureNotice {
  return { feature, policy: "emulate", detail }
}

describe("renderClaudeFeatureWarning", () => {
  test("renders nothing for an empty notice list", () => {
    expect(renderClaudeFeatureWarning([])).toBe("")
  })

  test("renders nothing when every notice is emulate-only", () => {
    const emulateOnly = [emulate("structuredOutput", "schema enforced by prompt"), emulate("webSearch", "served through MCP")]
    expect(renderClaudeFeatureWarning(emulateOnly)).toBe("")
    // Requirement 9.2: an emulate notice must be invisible to the client, so the rendering
    // equals the rendering with those notices removed.
    expect(renderClaudeFeatureWarning(emulateOnly)).toBe(renderClaudeFeatureWarning([]))
  })

  test("renders one header line plus one line for a single degrade notice", () => {
    const warning = renderClaudeFeatureWarning([degrade("sampling", "temperature=0.2 was not sent upstream")])
    expect(warning.split("\n")).toEqual([
      "[gateway] 1 requested feature was not honored as sent:",
      "- sampling: temperature=0.2 was not sent upstream",
    ])
  })

  test("renders one combined warning for several notices", () => {
    const warning = renderClaudeFeatureWarning([
      degrade("sampling", "temperature=0.2 was not sent upstream"),
      degrade("toolChoiceForced", 'tool_choice "required" was applied by narrowing the tool list'),
      degrade("stopSequences", "stop sequences were dropped"),
    ])
    const lines = warning.split("\n")
    // Requirement 9.4: one warning segment for the whole request, not one per notice.
    expect(lines.filter((line) => line.includes(CLAUDE_NOTICE_MARKER))).toHaveLength(1)
    expect(lines[0]).toBe("[gateway] 3 requested features were not honored as sent:")
    expect(lines.slice(1)).toEqual([
      "- sampling: temperature=0.2 was not sent upstream",
      '- toolChoiceForced: tool_choice "required" was applied by narrowing the tool list',
      "- stopSequences: stop sequences were dropped",
    ])
  })

  test("drops only emulate notices when both policies are present", () => {
    const warning = renderClaudeFeatureWarning([
      emulate("structuredOutput", "schema enforced by prompt"),
      degrade("sampling", "temperature=0.2 was not sent upstream"),
      emulate("webSearch", "served through MCP"),
    ])
    expect(warning).toBe(["[gateway] 1 requested feature was not honored as sent:", "- sampling: temperature=0.2 was not sent upstream"].join("\n"))
  })

  test("collapses exact duplicates and counts them once", () => {
    const warning = renderClaudeFeatureWarning([
      degrade("sampling", "temperature=0.2 was not sent upstream"),
      degrade("sampling", "temperature=0.2 was not sent upstream"),
      degrade("sampling", "temperature=0.2 was not sent upstream"),
    ])
    expect(warning).toBe(["[gateway] 1 requested feature was not honored as sent:", "- sampling: temperature=0.2 was not sent upstream"].join("\n"))
  })

  test("keeps near-duplicates that share a feature but differ in detail", () => {
    const warning = renderClaudeFeatureWarning([
      degrade("sampling", "temperature=0.2 was not sent upstream"),
      degrade("sampling", "top_p=0.9 was not sent upstream"),
    ])
    expect(warning.split("\n").slice(1)).toEqual([
      "- sampling: temperature=0.2 was not sent upstream",
      "- sampling: top_p=0.9 was not sent upstream",
    ])
  })

  test("preserves first-seen order when a duplicate arrives later", () => {
    const warning = renderClaudeFeatureWarning([
      degrade("sampling", "temperature dropped"),
      degrade("stopSequences", "stop sequences dropped"),
      degrade("sampling", "temperature dropped"),
      degrade("toolChoiceForced", "tool list narrowed"),
    ])
    expect(textNotices(warning).map((notice) => notice.feature)).toEqual(["sampling", "stopSequences", "toolChoiceForced"])
  })

  test("flattens a multi-line detail so one notice stays one line", () => {
    const warning = renderClaudeFeatureWarning([degrade("mcpToolset", "tools/list failed:\n  connection reset\n")])
    expect(warning.split("\n")).toEqual([
      "[gateway] 1 requested feature was not honored as sent:",
      "- mcpToolset: tools/list failed: connection reset",
    ])
  })
})

describe("prependClaudeWarning", () => {
  test("returns the text unchanged when there is no warning", () => {
    expect(prependClaudeWarning("model text", "")).toBe("model text")
  })

  test("returns the warning alone when there is no text", () => {
    const warning = renderClaudeFeatureWarning([degrade("sampling", "temperature dropped")])
    expect(prependClaudeWarning("", warning)).toBe(warning)
  })

  test("returns an empty string when both inputs are empty", () => {
    expect(prependClaudeWarning("", "")).toBe("")
  })

  test("separates the warning from the model text with a blank line", () => {
    const warning = renderClaudeFeatureWarning([degrade("sampling", "temperature dropped")])
    const combined = prependClaudeWarning("Here is the answer.", warning)
    expect(combined).toBe(`${warning}\n\nHere is the answer.`)
    expect(combined.endsWith("Here is the answer.")).toBe(true)
  })
})

describe("rendered warning round-trips through the harness parser", () => {
  test("the harness reads back every notice, in order, with details intact", () => {
    const notices = [
      degrade("sampling", "temperature=0.2 was not sent upstream"),
      degrade("toolChoiceForced", 'tool_choice "required" was applied by narrowing the tool list'),
    ]
    const combined = prependClaudeWarning("ok", renderClaudeFeatureWarning(notices))
    const parsed = textNotices(combined)
    expect(parsed.map((notice) => notice.feature)).toEqual(["sampling", "toolChoiceForced"])
    expect(parsed.map((notice) => notice.detail)).toEqual([
      "temperature=0.2 was not sent upstream",
      'tool_choice "required" was applied by narrowing the tool list',
    ])
    expect(parsed.every((notice) => notice.source === "text")).toBe(true)
  })

  test("the blank line stops the parser before model text that looks like a notice line", () => {
    const combined = prependClaudeWarning("- sampling: this line is model text", renderClaudeFeatureWarning([degrade("sampling", "temperature dropped")]))
    expect(textNotices(combined)).toEqual([{ feature: "sampling", detail: "temperature dropped", source: "text" }])
  })

  test("the harness sees no notice when nothing degraded", () => {
    const combined = prependClaudeWarning("ok", renderClaudeFeatureWarning([emulate("structuredOutput", "schema enforced by prompt")]))
    expect(combined).toBe("ok")
    expect(textNotices(combined)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Placement. Two render paths reach a Claude client — the message body and the SSE stream. Both
// are checked for the same three things: one warning segment, ahead of the first text content,
// and a notice-free render byte-identical to the pre-change output.
// ---------------------------------------------------------------------------------------------

const SAMPLING = degrade("sampling", "temperature=0.2 was not sent upstream")
const TOOL_CHOICE = degrade("toolChoiceForced", 'tool_choice "required" was applied by narrowing the tool list')
const WARNING = renderClaudeFeatureWarning([SAMPLING, TOOL_CHOICE])

function canonicalResponse(overrides: Partial<Canonical_Response> = {}): Canonical_Response {
  return {
    type: "canonical_response",
    id: "resp_notice",
    model: "m",
    stopReason: "end_turn",
    content: [{ type: "text", text: "Here is the answer." }],
    usage: { inputTokens: 3, outputTokens: 4 },
    ...overrides,
  }
}

function canonicalStream(events: Canonical_Event[]): Canonical_StreamResponse {
  return {
    type: "canonical_stream",
    status: 200,
    id: "resp_notice",
    model: "m",
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events
      },
    },
  }
}

const CLAUDE_REQUEST: ClaudeMessagesRequest = { model: "m", messages: [{ role: "user", content: "hi" }] }

function markerCount(serialized: string) {
  return serialized.split(CLAUDE_NOTICE_MARKER).length - 1
}

/** Text of the message body's content blocks, in block order. */
function bodyText(body: { content: any[] }) {
  return body.content.filter((block) => block.type === "text").map((block) => block.text as string).join("")
}

async function readClaudeStream(events: Canonical_Event[], telemetry?: StreamTelemetryCollector) {
  return readSse(claudeCanonicalStreamResponse(canonicalStream(events), CLAUDE_REQUEST, { heartbeatMs: 0, ...(telemetry ? { telemetry } : {}) }))
}

/** Text the client actually saw, in arrival order, from `text_delta` content block deltas. */
function streamedText(sse: Array<{ event?: string; data: any }>) {
  return sse
    .filter((event) => event.data?.delta?.type === "text_delta")
    .map((event) => event.data.delta.text as string)
    .join("")
}

const TEXT_EVENTS: Canonical_Event[] = [
  { type: "text_delta", delta: "Here is " },
  { type: "text_delta", delta: "the answer." },
  { type: "message_stop", stopReason: "end_turn" },
]

const NOTICE_EVENTS: Canonical_Event[] = [
  { type: "feature_notice", feature: "sampling", policy: "degrade", detail: "temperature=0.2 was not sent upstream" },
  { type: "feature_notice", feature: "toolChoiceForced", policy: "degrade", detail: 'tool_choice "required" was applied by narrowing the tool list' },
]

describe("placement — Claude message body", () => {
  test("one warning segment leads the first text block", async () => {
    const body = await canonicalResponseToClaudeMessage(canonicalResponse({ featureNotices: [SAMPLING, TOOL_CHOICE] }), CLAUDE_REQUEST)
    expect(markerCount(JSON.stringify(body))).toBe(1)
    expect(body.content[0]).toEqual({ type: "text", text: `${WARNING}\n\nHere is the answer.` })
  })

  test("the harness parser reads the notices back off the rendered body", async () => {
    const body = await canonicalResponseToClaudeMessage(canonicalResponse({ featureNotices: [SAMPLING, TOOL_CHOICE] }), CLAUDE_REQUEST)
    expect(textNotices(bodyText(body))).toEqual([
      { feature: "sampling", detail: "temperature=0.2 was not sent upstream", source: "text" },
      { feature: "toolChoiceForced", detail: 'tool_choice "required" was applied by narrowing the tool list', source: "text" },
    ])
  })

  test("a notice-free body is byte-identical to the same body rendered with an empty notice list", async () => {
    const withoutField = await canonicalResponseToClaudeMessage(canonicalResponse(), CLAUDE_REQUEST)
    const withEmptyList = await canonicalResponseToClaudeMessage(canonicalResponse({ featureNotices: [] }), CLAUDE_REQUEST)
    const withEmulateOnly = await canonicalResponseToClaudeMessage(
      canonicalResponse({ featureNotices: [emulate("structuredOutput", "schema enforced by prompt")] }),
      CLAUDE_REQUEST,
    )
    expect(JSON.stringify(withEmptyList)).toBe(JSON.stringify(withoutField))
    // Requirement 9.2 on this path: an emulate notice changes nothing a client can see.
    expect(JSON.stringify(withEmulateOnly)).toBe(JSON.stringify(withoutField))
  })

  test("adds no block type and no field a text-carrying body does not already produce", async () => {
    const warned = await canonicalResponseToClaudeMessage(canonicalResponse({ featureNotices: [SAMPLING] }), CLAUDE_REQUEST)
    const plain = await canonicalResponseToClaudeMessage(canonicalResponse(), CLAUDE_REQUEST)
    expect(Object.keys(warned)).toEqual(Object.keys(plain))
    expect(warned.content.map((block: any) => block.type)).toEqual(plain.content.map((block: any) => block.type))
    expect(Object.keys(warned.content[0])).toEqual(Object.keys(plain.content[0]))
  })

  test("keeps the existing text block's own members, prefixing only its text", async () => {
    const citation = { type: "web_search_result_location", url: "https://example.com", title: "Example", encrypted_index: "", cited_text: "Here" }
    const warned = await canonicalResponseToClaudeMessage(
      canonicalResponse({
        content: [{ type: "text", text: "Here is the answer.", annotations: [{ type: "url_citation", url: "https://example.com", title: "Example", start_index: 0, end_index: 4 }] }],
        featureNotices: [SAMPLING],
      }),
      CLAUDE_REQUEST,
    )
    expect(warned.content[0]).toEqual({ type: "text", text: `${renderClaudeFeatureWarning([SAMPLING])}\n\nHere is the answer.`, citations: [citation] })
  })

  test("creates a text block only when the response has none", async () => {
    const warned = await canonicalResponseToClaudeMessage(
      canonicalResponse({
        content: [{ type: "tool_call", id: "fc_1", callId: "call_1", name: "Read", arguments: "{}" }],
        featureNotices: [SAMPLING],
      }),
      CLAUDE_REQUEST,
    )
    expect(markerCount(JSON.stringify(warned))).toBe(1)
    // The created block leads the content, so the warning precedes the model's first block.
    expect(warned.content.map((block: any) => block.type)).toEqual(["text", "tool_use"])
    expect(warned.content[0]).toEqual({ type: "text", text: renderClaudeFeatureWarning([SAMPLING]) })
  })

  test("prefixes the first text block rather than creating one when text sits after a tool call", async () => {
    const warned = await canonicalResponseToClaudeMessage(
      canonicalResponse({
        content: [
          { type: "tool_call", id: "fc_1", callId: "call_1", name: "Read", arguments: "{}" },
          { type: "text", text: "Here is the answer." },
        ],
        featureNotices: [SAMPLING],
      }),
      CLAUDE_REQUEST,
    )
    expect(warned.content.map((block: any) => block.type)).toEqual(["tool_use", "text"])
    expect(warned.content[1].text).toBe(`${renderClaudeFeatureWarning([SAMPLING])}\n\nHere is the answer.`)
  })
})

describe("placement — Claude SSE stream", () => {
  test("one warning segment precedes the first text delta", async () => {
    const telemetry = new StreamTelemetryCollector({ requestId: "req_notice", provider: "kiro", model: "m", streaming: true })
    const sse = await readClaudeStream([...NOTICE_EVENTS, ...TEXT_EVENTS], telemetry)
    const text = streamedText(sse)
    expect(markerCount(text)).toBe(1)
    expect(text).toBe(`${WARNING}\n\nHere is the answer.`)
    expect(text.indexOf(CLAUDE_NOTICE_MARKER)).toBe(0)
    // Requirement 8.2: the same notices also reach telemetry, unrendered and undeduped.
    expect(telemetry.finalize().featureNotices).toEqual([SAMPLING, TOOL_CHOICE])
  })

  test("the harness parser reads the notices back off the streamed text", async () => {
    const sse = await readClaudeStream([...NOTICE_EVENTS, ...TEXT_EVENTS])
    expect(textNotices(streamedText(sse)).map((notice) => notice.feature)).toEqual(["sampling", "toolChoiceForced"])
  })

  test("the warning rides the same content block as the model text", async () => {
    const sse = await readClaudeStream([...NOTICE_EVENTS, ...TEXT_EVENTS])
    const textDeltas = sse.filter((event) => event.data?.delta?.type === "text_delta")
    expect([...new Set(textDeltas.map((event) => event.data.index))]).toEqual([0])
    expect(sse.filter((event) => event.event === "content_block_start")).toHaveLength(1)
  })

  test("a notice-free stream is byte-identical to the same stream carrying emulate notices", async () => {
    const plain = await readClaudeStream(TEXT_EVENTS)
    const emulateOnly = await readClaudeStream([
      { type: "feature_notice", feature: "structuredOutput", policy: "emulate", detail: "schema enforced by prompt" },
      ...TEXT_EVENTS,
    ])
    expect(JSON.stringify(emulateOnly)).toBe(JSON.stringify(plain))
  })

  test("introduces no SSE event name and no delta type the notice-free stream lacks", async () => {
    // Counts differ — a longer text is more deltas — so the vocabulary is what is compared.
    const names = (sse: Array<{ event?: string; data: any }>) => [...new Set(sse.map((event) => event.event))].sort()
    const deltaTypes = (sse: Array<{ data: any }>) => [...new Set(sse.map((event) => event.data?.delta?.type).filter(Boolean))].sort()
    const warned = await readClaudeStream([...NOTICE_EVENTS, ...TEXT_EVENTS])
    const plain = await readClaudeStream(TEXT_EVENTS)
    expect(names(warned)).toEqual(names(plain))
    expect(deltaTypes(warned)).toEqual(deltaTypes(plain))
  })

  test("a text_done that opens the block carries the warning too", async () => {
    const sse = await readClaudeStream([...NOTICE_EVENTS, { type: "text_done", text: "Here is the answer." }, { type: "message_stop", stopReason: "end_turn" }])
    expect(streamedText(sse)).toBe(`${WARNING}\n\nHere is the answer.`)
  })

  test("a stream that carried no text still delivers the warning in a created text block", async () => {
    const sse = await readClaudeStream([...NOTICE_EVENTS, { type: "message_stop", stopReason: "end_turn" }])
    expect(markerCount(streamedText(sse))).toBe(1)
    expect(streamedText(sse)).toBe(WARNING)
    expect(sse.filter((event) => event.event === "content_block_start").map((event) => event.data.content_block.type)).toEqual(["text"])
  })

  test("a tool-call-only stream gets a text block created for the warning", async () => {
    const sse = await readClaudeStream([
      ...NOTICE_EVENTS,
      { type: "tool_call_done", callId: "call_1", name: "Read", arguments: "{}" },
      { type: "message_stop", stopReason: "tool_use" },
    ])
    expect(streamedText(sse)).toBe(WARNING)
    expect(sse.filter((event) => event.event === "content_block_start").map((event) => event.data.content_block.type)).toEqual(["tool_use", "text"])
  })

  test("does not split the text block when a notice arrives between two deltas", async () => {
    const sse = await readClaudeStream([
      { type: "text_delta", delta: "Here is " },
      ...NOTICE_EVENTS,
      { type: "text_delta", delta: "the answer." },
      { type: "message_stop", stopReason: "end_turn" },
    ])
    expect(sse.filter((event) => event.event === "content_block_start")).toHaveLength(1)
    expect(streamedText(sse)).toBe(`Here is the answer.\n\n${WARNING}`)
  })
})

describe("late notices", () => {
  test("a notice decided after the text started trails the current text block", async () => {
    const sse = await readClaudeStream([
      { type: "text_delta", delta: "Here is the answer." },
      ...NOTICE_EVENTS,
      { type: "message_stop", stopReason: "end_turn" },
    ])
    const text = streamedText(sse)
    expect(markerCount(text)).toBe(1)
    expect(text).toBe(`Here is the answer.\n\n${WARNING}`)
    // Trailing or leading, the harness still reads both notices out of the same segment.
    expect(textNotices(text).map((notice) => notice.feature)).toEqual(["sampling", "toolChoiceForced"])
  })

  test("a late notice stays inside the text block it trails", async () => {
    const sse = await readClaudeStream([
      { type: "text_delta", delta: "Here is the answer." },
      ...NOTICE_EVENTS,
      { type: "message_stop", stopReason: "end_turn" },
    ])
    const indexes = [...new Set(sse.filter((event) => event.data?.delta?.type === "text_delta").map((event) => event.data.index))]
    expect(indexes).toEqual([0])
    expect(sse.filter((event) => event.event === "content_block_start")).toHaveLength(1)
  })

  test("notices split across the text boundary render one segment on each side, never a repeat", async () => {
    const sse = await readClaudeStream([
      NOTICE_EVENTS[0]!,
      { type: "text_delta", delta: "Here is the answer." },
      NOTICE_EVENTS[1]!,
      { type: "message_stop", stopReason: "end_turn" },
    ])
    const text = streamedText(sse)
    // Two segments is what design D2's ordering rule forces here, not a second delivery
    // mechanism: a notice decided after text was emitted cannot lead that text. Requirement 9.4
    // still holds per flush — the early notice renders in the leading segment only, the late one
    // in the trailing segment only, and neither appears twice.
    expect(text).toBe(
      `${renderClaudeFeatureWarning([SAMPLING])}\n\nHere is the answer.\n\n${renderClaudeFeatureWarning([TOOL_CHOICE])}`,
    )
    expect(text.split("- sampling:")).toHaveLength(2)
    expect(text.split("- toolChoiceForced:")).toHaveLength(2)
  })

  test("a late emulate-only notice leaves the stream byte-identical", async () => {
    const plain = await readClaudeStream(TEXT_EVENTS)
    const lateEmulate = await readClaudeStream([
      { type: "text_delta", delta: "Here is " },
      { type: "feature_notice", feature: "structuredOutput", policy: "emulate", detail: "schema enforced by prompt" },
      { type: "text_delta", delta: "the answer." },
      { type: "message_stop", stopReason: "end_turn" },
    ])
    expect(JSON.stringify(lateEmulate)).toBe(JSON.stringify(plain))
  })
})
