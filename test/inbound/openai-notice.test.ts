import { describe, expect, test } from "bun:test"
import type { Canonical_Event, Canonical_FeatureNotice, Canonical_Response, Canonical_StreamResponse } from "../../src/core/canonical"
import type { RequestProxyLog } from "../../src/core/types"
import { StreamTelemetryCollector } from "../../src/core/stream-telemetry"
import { OpenAI_Inbound_Provider } from "../../src/inbound/openai"
import {
  canonicalResponseToChatCompletion,
  canonicalResponseToResponsesBody,
  openAICanonicalStreamResponse,
} from "../../src/inbound/openai/response"
import { OPENAI_NOTICE_MARKER, prependOpenAIWarning, renderOpenAIFeatureWarning } from "../../src/inbound/openai/notice"
import { textNotices } from "../native/observation"
import { readSse } from "../helpers"

function degrade(feature: Canonical_FeatureNotice["feature"], detail: string): Canonical_FeatureNotice {
  return { feature, policy: "degrade", detail }
}

function emulate(feature: Canonical_FeatureNotice["feature"], detail: string): Canonical_FeatureNotice {
  return { feature, policy: "emulate", detail }
}

const SAMPLING = degrade("sampling", "temperature=0.2 was not sent upstream")
const TOOL_CHOICE = degrade("toolChoiceForced", 'tool_choice "required" was applied by narrowing the tool list')

describe("renderOpenAIFeatureWarning", () => {
  test("renders nothing for an empty notice list", () => {
    expect(renderOpenAIFeatureWarning([])).toBe("")
  })

  test("renders nothing when every notice is emulate-only", () => {
    const emulateOnly = [emulate("structuredOutput", "schema enforced by prompt"), emulate("webSearch", "served through MCP")]
    expect(renderOpenAIFeatureWarning(emulateOnly)).toBe("")
    // Requirement 9.2: an emulate notice must be invisible to the client, so the rendering
    // equals the rendering with those notices removed.
    expect(renderOpenAIFeatureWarning(emulateOnly)).toBe(renderOpenAIFeatureWarning([]))
  })

  test("names the feature on one line for a single degrade notice", () => {
    expect(renderOpenAIFeatureWarning([SAMPLING]).split("\n")).toEqual(["[gateway] not honored as sent: sampling"])
  })

  test("carries no detail prose into the rendered warning", () => {
    expect(renderOpenAIFeatureWarning([SAMPLING])).not.toInclude("temperature=0.2")
  })

  test("renders one combined warning for several notices", () => {
    const warning = renderOpenAIFeatureWarning([SAMPLING, TOOL_CHOICE, degrade("stopSequences", "stop sequences were dropped")])
    const lines = warning.split("\n")
    // Requirement 9.4: one warning segment for the whole request, not one per notice.
    expect(lines.filter((line) => line.includes(OPENAI_NOTICE_MARKER))).toHaveLength(1)
    expect(lines).toEqual(["[gateway] not honored as sent: sampling, toolChoiceForced, stopSequences"])
  })

  test("drops only emulate notices when both policies are present", () => {
    const warning = renderOpenAIFeatureWarning([
      emulate("structuredOutput", "schema enforced by prompt"),
      SAMPLING,
      emulate("webSearch", "served through MCP"),
    ])
    expect(warning).toBe("[gateway] not honored as sent: sampling")
  })

  test("collapses exact duplicates and counts them once", () => {
    expect(renderOpenAIFeatureWarning([SAMPLING, SAMPLING, SAMPLING])).toBe(renderOpenAIFeatureWarning([SAMPLING]))
  })

  test("collapses near-duplicates that share a feature but differ in detail", () => {
    const warning = renderOpenAIFeatureWarning([SAMPLING, degrade("sampling", "top_p=0.9 was not sent upstream")])
    expect(warning).toBe("[gateway] not honored as sent: sampling")
  })

  test("preserves first-seen order when a duplicate arrives later", () => {
    const warning = renderOpenAIFeatureWarning([
      degrade("sampling", "temperature dropped"),
      degrade("stopSequences", "stop sequences dropped"),
      degrade("sampling", "temperature dropped"),
      degrade("toolChoiceForced", "tool list narrowed"),
    ])
    expect(textNotices(warning).map((notice) => notice.feature)).toEqual(["sampling", "stopSequences", "toolChoiceForced"])
  })

  test("a multi-line detail cannot break the warning across lines", () => {
    expect(renderOpenAIFeatureWarning([degrade("mcpToolset", "tools/list failed:\n  connection reset\n")]).split("\n")).toEqual([
      "[gateway] not honored as sent: mcpToolset",
    ])
  })

  test("renders the same information the harness parser reads off a Claude body", () => {
    // One marker and one line shape for both inbound formats, so `textNotices()` stays the
    // single parser. What makes this rendering OpenAI-shaped is where the text lands.
    const parsed = textNotices(renderOpenAIFeatureWarning([SAMPLING, TOOL_CHOICE]))
    expect(parsed.map((notice) => notice.feature)).toEqual(["sampling", "toolChoiceForced"])
    expect(parsed.map((notice) => notice.detail)).toEqual([undefined, undefined])
  })
})

describe("prependOpenAIWarning", () => {
  test("returns the text unchanged when there is no warning", () => {
    expect(prependOpenAIWarning("model text", "")).toBe("model text")
  })

  test("returns the warning alone when there is no text", () => {
    const warning = renderOpenAIFeatureWarning([SAMPLING])
    expect(prependOpenAIWarning("", warning)).toBe(warning)
  })

  test("separates the warning from the model text with a blank line", () => {
    const warning = renderOpenAIFeatureWarning([SAMPLING])
    expect(prependOpenAIWarning("Here is the answer.", warning)).toBe(`${warning}\n\nHere is the answer.`)
  })
})

// ---------------------------------------------------------------------------------------------
// Placement. Four render paths reach a client: Responses and chat-completions, each streaming
// and non-streaming. Every one is checked for the same three things — one warning segment, ahead
// of the first text content, and a notice-free render byte-identical to the pre-change output.
// ---------------------------------------------------------------------------------------------

const WARNING = renderOpenAIFeatureWarning([SAMPLING, TOOL_CHOICE])

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

/** Volatile members — generated ids and second-resolution clocks — normalized away. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== "object") return value
  const normalized: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (key === "created" || key === "created_at" || key === "completed_at") {
      normalized[key] = 0
      continue
    }
    if ((key === "id" || key === "item_id" || key === "call_id") && typeof member === "string" && /^(msg|rs|fc|call)_/.test(member)) {
      normalized[key] = member.replace(/^([a-z]+)_.*/, "$1_x")
      continue
    }
    normalized[key] = stable(member)
  }
  return normalized
}

function markerCount(serialized: string) {
  return serialized.split(OPENAI_NOTICE_MARKER).length - 1
}

function responsesOutputText(body: Record<string, any>) {
  return (body.output as any[])
    .filter((item) => item.type === "message")
    .flatMap((item) => (item.content as any[]).filter((part) => part.type === "output_text").map((part) => part.text as string))
    .join("")
}

async function readResponsesStream(events: Canonical_Event[], telemetry?: StreamTelemetryCollector) {
  return readSse(openAICanonicalStreamResponse(canonicalStream(events), "/v1/responses", { model: "m", input: "hi" }, { featureNotices: true, ...(telemetry ? { telemetry } : {}) }))
}

/** `data: [DONE]` is not JSON, so the chat shape gets its own reader rather than `readSse()`. */
async function readChatStream(events: Canonical_Event[], telemetry?: StreamTelemetryCollector) {
  const response = openAICanonicalStreamResponse(canonicalStream(events), "/v1/chat/completions", { model: "m", messages: [] }, { featureNotices: true, ...(telemetry ? { telemetry } : {}) })
  const body = await response.text()
  return body
    .split("\n\n")
    .map((chunk) => chunk.replace(/^data: /, ""))
    .filter((chunk) => chunk && chunk !== "[DONE]")
    .map((chunk) => ({ event: undefined as string | undefined, data: JSON.parse(chunk) as any }))
}

/** Text the client actually saw, in arrival order, from `response.output_text.delta` events. */
function responsesDeltaText(sse: Array<{ event?: string; data: any }>) {
  return sse.filter((event) => event.event === "response.output_text.delta").map((event) => event.data.delta as string).join("")
}

/** Text the client actually saw, in arrival order, from `chat.completion.chunk` content deltas. */
function chatDeltaText(sse: Array<{ event?: string; data: any }>) {
  return sse
    .filter((event) => typeof event.data?.choices?.[0]?.delta?.content === "string")
    .map((event) => event.data.choices[0].delta.content as string)
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

describe("placement — Responses API, non-streaming", () => {
  test("one warning segment leads the first output_text part", () => {
    const body = canonicalResponseToResponsesBody(canonicalResponse({ featureNotices: [SAMPLING, TOOL_CHOICE] }), { model: "m", input: "hi" }, { featureNotices: true }) as Record<string, any>
    expect(markerCount(JSON.stringify(body))).toBe(1)
    expect(responsesOutputText(body)).toBe(`${WARNING}\n\nHere is the answer.`)
    expect(textNotices(responsesOutputText(body)).map((notice) => notice.feature)).toEqual(["sampling", "toolChoiceForced"])
  })

  test("a notice-free body is byte-identical to the same body rendered with an empty notice list", () => {
    const request = { model: "m", input: "hi" }
    const withoutField = canonicalResponseToResponsesBody(canonicalResponse(), request, { featureNotices: true })
    const withEmptyList = canonicalResponseToResponsesBody(canonicalResponse({ featureNotices: [] }), request, { featureNotices: true })
    const withEmulateOnly = canonicalResponseToResponsesBody(canonicalResponse({ featureNotices: [emulate("structuredOutput", "schema enforced by prompt")] }), request, { featureNotices: true })
    expect(JSON.stringify(stable(withEmptyList))).toBe(JSON.stringify(stable(withoutField)))
    // Requirement 9.2 on this path.
    expect(JSON.stringify(stable(withEmulateOnly))).toBe(JSON.stringify(stable(withoutField)))
  })

  test("adds no output item type a text-carrying response does not already produce", () => {
    const warned = canonicalResponseToResponsesBody(canonicalResponse({ featureNotices: [SAMPLING] }), { model: "m", input: "hi" }, { featureNotices: true }) as Record<string, any>
    const plain = canonicalResponseToResponsesBody(canonicalResponse(), { model: "m", input: "hi" }, { featureNotices: true }) as Record<string, any>
    expect((warned.output as any[]).map((item) => item.type)).toEqual((plain.output as any[]).map((item) => item.type))
  })

  test("a tool-call-only response carries the warning in a created text part", () => {
    const body = canonicalResponseToResponsesBody(
      canonicalResponse({
        content: [{ type: "tool_call", id: "fc_1", callId: "call_1", name: "Read", arguments: "{}" }],
        featureNotices: [SAMPLING],
      }),
      { model: "m", input: "hi" },
      { featureNotices: true },
    ) as Record<string, any>
    expect(markerCount(JSON.stringify(body))).toBe(1)
    expect(responsesOutputText(body)).toBe(renderOpenAIFeatureWarning([SAMPLING]))
    // The warning precedes every other output item, so it precedes the model's first content.
    expect((body.output as any[])[0].type).toBe("message")
  })
})

describe("placement — chat completions, non-streaming", () => {
  test("one warning segment leads the assistant content", () => {
    const body = canonicalResponseToChatCompletion(canonicalResponse({ featureNotices: [SAMPLING, TOOL_CHOICE] }), { featureNotices: true }) as Record<string, any>
    expect(markerCount(JSON.stringify(body))).toBe(1)
    expect(body.choices[0].message.content).toBe(`${WARNING}\n\nHere is the answer.`)
  })

  test("a notice-free body is byte-identical to the same body rendered with an empty notice list", () => {
    const withoutField = canonicalResponseToChatCompletion(canonicalResponse(), { featureNotices: true })
    const withEmptyList = canonicalResponseToChatCompletion(canonicalResponse({ featureNotices: [] }), { featureNotices: true })
    const withEmulateOnly = canonicalResponseToChatCompletion(canonicalResponse({ featureNotices: [emulate("webSearch", "served through MCP")] }), { featureNotices: true })
    expect(JSON.stringify(stable(withEmptyList))).toBe(JSON.stringify(stable(withoutField)))
    expect(JSON.stringify(stable(withEmulateOnly))).toBe(JSON.stringify(stable(withoutField)))
  })

  test("adds no field the notice-free body lacks", () => {
    const warned = canonicalResponseToChatCompletion(canonicalResponse({ featureNotices: [SAMPLING] }), { featureNotices: true }) as Record<string, any>
    const plain = canonicalResponseToChatCompletion(canonicalResponse(), { featureNotices: true }) as Record<string, any>
    expect(Object.keys(warned)).toEqual(Object.keys(plain))
    expect(Object.keys(warned.choices[0].message)).toEqual(Object.keys(plain.choices[0].message))
  })

  test("a tool-call-only response answers with the warning as its content instead of null", () => {
    const body = canonicalResponseToChatCompletion(
      canonicalResponse({
        content: [{ type: "tool_call", id: "fc_1", callId: "call_1", name: "Read", arguments: "{}" }],
        featureNotices: [SAMPLING],
      }),
      { featureNotices: true },
    ) as Record<string, any>
    expect(body.choices[0].message.content).toBe(renderOpenAIFeatureWarning([SAMPLING]))
    expect(body.choices[0].message.tool_calls).toHaveLength(1)
  })
})

describe("placement — Responses API, streaming", () => {
  test("one warning segment precedes the first text delta", async () => {
    const telemetry = new StreamTelemetryCollector({ requestId: "req_notice", provider: "kiro", model: "m", streaming: true })
    const sse = await readResponsesStream([...NOTICE_EVENTS, ...TEXT_EVENTS], telemetry)
    const streamed = responsesDeltaText(sse)
    expect(markerCount(streamed)).toBe(1)
    expect(streamed).toBe(`${WARNING}\n\nHere is the answer.`)
    expect(streamed.indexOf(OPENAI_NOTICE_MARKER)).toBe(0)
    // Requirement 8.2: the same notices also reach telemetry, unrendered and undeduped.
    expect(telemetry.finalize().featureNotices).toEqual([SAMPLING, TOOL_CHOICE])
  })

  test("the completed body carries the same one segment", async () => {
    const sse = await readResponsesStream([...NOTICE_EVENTS, ...TEXT_EVENTS])
    const completed = sse.find((event) => event.event === "response.completed")
    expect(markerCount(JSON.stringify(completed?.data.response.output))).toBe(1)
    expect(responsesOutputText(completed!.data.response)).toBe(`${WARNING}\n\nHere is the answer.`)
  })

  test("a notice-free stream is byte-identical to the same stream carrying emulate notices", async () => {
    const plain = await readResponsesStream(TEXT_EVENTS)
    const emulateOnly = await readResponsesStream([
      { type: "feature_notice", feature: "structuredOutput", policy: "emulate", detail: "schema enforced by prompt" },
      ...TEXT_EVENTS,
    ])
    expect(JSON.stringify(stable(emulateOnly))).toBe(JSON.stringify(stable(plain)))
  })

  test("introduces no SSE event name the notice-free stream lacks", async () => {
    // Counts differ — a longer text is more deltas — so the vocabulary is what is compared.
    const names = (sse: Array<{ event?: string }>) => [...new Set(sse.map((event) => event.event))].sort()
    expect(names(await readResponsesStream([...NOTICE_EVENTS, ...TEXT_EVENTS]))).toEqual(names(await readResponsesStream(TEXT_EVENTS)))
  })

  test("a stream that carried no text still delivers the warning", async () => {
    const sse = await readResponsesStream([...NOTICE_EVENTS, { type: "message_stop", stopReason: "end_turn" }])
    expect(markerCount(responsesDeltaText(sse))).toBe(1)
    expect(responsesDeltaText(sse)).toBe(WARNING)
  })
})

describe("placement — chat completions, streaming", () => {
  test("one warning segment precedes the first content delta", async () => {
    const telemetry = new StreamTelemetryCollector({ requestId: "req_notice", provider: "kiro", model: "m", streaming: true })
    const sse = await readChatStream([...NOTICE_EVENTS, ...TEXT_EVENTS], telemetry)
    const streamed = chatDeltaText(sse)
    expect(markerCount(streamed)).toBe(1)
    expect(streamed).toBe(`${WARNING}\n\nHere is the answer.`)
    expect(streamed.indexOf(OPENAI_NOTICE_MARKER)).toBe(0)
    expect(telemetry.finalize().featureNotices).toEqual([SAMPLING, TOOL_CHOICE])
  })

  test("a notice-free stream is byte-identical to the same stream carrying emulate notices", async () => {
    const plain = await readChatStream(TEXT_EVENTS)
    const emulateOnly = await readChatStream([
      { type: "feature_notice", feature: "structuredOutput", policy: "emulate", detail: "schema enforced by prompt" },
      ...TEXT_EVENTS,
    ])
    expect(JSON.stringify(stable(emulateOnly))).toBe(JSON.stringify(stable(plain)))
  })

  test("introduces no chunk field the notice-free stream lacks", async () => {
    const plain = await readChatStream(TEXT_EVENTS)
    const warned = await readChatStream([...NOTICE_EVENTS, ...TEXT_EVENTS])
    const fields = (sse: Array<{ data: any }>) => [
      ...new Set(sse.flatMap((event) => [
        ...Object.keys(event.data ?? {}),
        ...Object.keys(event.data?.choices?.[0]?.delta ?? {}).map((key) => `delta.${key}`),
      ])),
    ].sort()
    expect(fields(warned)).toEqual(fields(plain))
  })

  test("a stream that carried no text still delivers the warning", async () => {
    const sse = await readChatStream([...NOTICE_EVENTS, { type: "message_stop", stopReason: "end_turn" }])
    expect(chatDeltaText(sse)).toBe(WARNING)
  })
})

describe("late notices", () => {
  test("a notice decided after the text started trails the Responses text block", async () => {
    const sse = await readResponsesStream([
      { type: "text_delta", delta: "Here is the answer." },
      ...NOTICE_EVENTS,
      { type: "message_stop", stopReason: "end_turn" },
    ])
    const streamed = responsesDeltaText(sse)
    expect(markerCount(streamed)).toBe(1)
    expect(streamed).toBe(`Here is the answer.\n\n${WARNING}`)
  })

  test("a notice decided after the text started trails the chat content", async () => {
    const sse = await readChatStream([
      { type: "text_delta", delta: "Here is the answer." },
      ...NOTICE_EVENTS,
      { type: "message_stop", stopReason: "end_turn" },
    ])
    expect(chatDeltaText(sse)).toBe(`Here is the answer.\n\n${WARNING}`)
  })
})

// ---------------------------------------------------------------------------------------------
// Placement — the error response (task 14b).
//
// The path a rejected request takes, which none of the suites above reach: no Responses body, no
// chat completion, no stream. Driven through `OpenAI_Inbound_Provider.handle()` so the assertions
// are about the bytes the real branch emits, including the passthrough branch that must not
// render at all.
// ---------------------------------------------------------------------------------------------
const ERROR_BODY = "This upstream does not support sampling: temperature=0.2 was not sent upstream. Use an upstream that honors generation controls instead."
function erroringUpstream(featureNotices?: Canonical_FeatureNotice[]) {
  return {
    proxy: () =>
      Promise.resolve({
        type: "canonical_error" as const,
        status: 400,
        headers: new Headers(),
        body: ERROR_BODY,
        ...(featureNotices ? { featureNotices } : {}),
      }),
    checkHealth: () => Promise.resolve({ ok: true }),
  }
}
async function openAIErrorFor(featureNotices?: Canonical_FeatureNotice[], options: { passthrough?: boolean; onProxy?: (log: RequestProxyLog) => void } = {}) {
  const response = await new OpenAI_Inbound_Provider({ passthrough: options.passthrough ?? false, featureNotices: true }).handle(
    new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
    { path: "/v1/responses", method: "POST" },
    erroringUpstream(featureNotices),
    { requestId: "req_notice_error", logBody: false, quiet: true, ...(options.onProxy ? { onProxy: options.onProxy } : {}) },
  )
  return { response, text: await response.text() }
}
describe("placement — OpenAI error response", () => {
  test("one warning segment leads the error message", async () => {
    const { response, text } = await openAIErrorFor([SAMPLING, TOOL_CHOICE])
    expect(response.status).toBe(400)
    expect(markerCount(text)).toBe(1)
    const body = JSON.parse(text)
    // The warning leads the one prose field the OpenAI error shape has, and the message the
    // client would have received without it is still there behind the blank line.
    expect(body.error.message).toBe(`${WARNING}\n\n${ERROR_BODY}`)
    expect(body.error.message.endsWith(ERROR_BODY)).toBe(true)
  })
  test("the harness parser reads the notices back off the error body", async () => {
    const { text } = await openAIErrorFor([SAMPLING, TOOL_CHOICE])
    expect(textNotices(JSON.parse(text).error.message)).toEqual([
      { feature: "sampling", source: "text" },
      { feature: "toolChoiceForced", source: "text" },
    ])
  })
  test("a notice-free error is byte-identical to the same error carrying an empty list", async () => {
    const withoutField = await openAIErrorFor()
    const withEmptyList = await openAIErrorFor([])
    expect(withEmptyList.text).toBe(withoutField.text)
    expect(JSON.parse(withoutField.text).error.message).toBe(ERROR_BODY)
  })
  test("an emulate-only error is byte-identical to the notice-free one", async () => {
    const withoutField = await openAIErrorFor()
    const emulateOnly = await openAIErrorFor([emulate("structuredOutput", "schema enforced by prompt"), emulate("webSearch", "served through MCP")])
    // Requirement 9.2 on this path too: an emulate notice stays telemetry-only.
    expect(emulateOnly.text).toBe(withoutField.text)
  })
  test("adds no field and no header the notice-free error lacks", async () => {
    const warned = await openAIErrorFor([SAMPLING])
    const plain = await openAIErrorFor()
    const warnedBody = JSON.parse(warned.text)
    const plainBody = JSON.parse(plain.text)
    expect(Object.keys(warnedBody)).toEqual(Object.keys(plainBody))
    expect(Object.keys(warnedBody.error)).toEqual(Object.keys(plainBody.error))
    expect(warnedBody.error.type).toBe(plainBody.error.type)
    expect(warned.response.status).toBe(plain.response.status)
    expect([...warned.response.headers.keys()].sort()).toEqual([...plain.response.headers.keys()].sort())
  })
  test("passthrough mode forwards the error bytes unrendered", async () => {
    // Requirement 15.5: a byte forward stays a byte forward, so the notices reach this client
    // through telemetry only.
    const logs: RequestProxyLog[] = []
    const { response, text } = await openAIErrorFor([SAMPLING], { passthrough: true, onProxy: (log) => logs.push(log) })
    expect(response.status).toBe(400)
    expect(text).toBe(ERROR_BODY)
    expect(markerCount(text)).toBe(0)
    expect(logs[0]?.telemetry?.featureNotices).toEqual([SAMPLING])
  })
  test("the notices reach telemetry on the proxy log, rendered nowhere else", async () => {
    const logs: RequestProxyLog[] = []
    const emulated = emulate("structuredOutput", "schema enforced by prompt")
    const { response } = await openAIErrorFor([SAMPLING, emulated], { onProxy: (log) => logs.push(log) })
    expect(response.status).toBe(400)
    // Unrendered and undeduped, both policies, exactly as on the 200 paths (Requirement 8.8).
    expect(logs[0]?.telemetry?.featureNotices).toEqual([SAMPLING, emulated])
  })
})
