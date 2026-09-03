import { describe, expect, test } from "bun:test"

import type { Canonical_Event, Canonical_FeatureNotice, Canonical_Response, Canonical_StreamResponse } from "../../src/core/canonical"
import type { RequestHandlerContext, Upstream_Provider } from "../../src/core/interfaces"
import { StreamTelemetryCollector } from "../../src/core/stream-telemetry"
import { canonicalResponseTelemetrySummary } from "../../src/core/stream-telemetry-summary"
import type { RequestProxyLog } from "../../src/core/types"
import { Claude_Inbound_Provider } from "../../src/inbound/claude"
import { claudeCanonicalStreamResponse } from "../../src/inbound/claude/response"
import { OpenAI_Inbound_Provider } from "../../src/inbound/openai"
import { openAICanonicalStreamResponse } from "../../src/inbound/openai/response"
import { collectKiroResponse, streamKiroResponse } from "../../src/upstream/kiro/parse"
import { readSse } from "../helpers"

// The payload measured across ~30 live Kiro calls (`.omc/research/kiro-wire-spike.md` §2).
const MEASURED_METERING_PAYLOAD = '{"unit":"credit","unitPlural":"credits","usage":0.0148}'

function canonicalStream(events: Canonical_Event[]): Canonical_StreamResponse {
  return {
    type: "canonical_stream",
    status: 200,
    id: "resp_credits",
    model: "m",
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events
      },
    },
  }
}

function upstreamBody(body: string) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  }))
}

async function readClaudeSse(events: Canonical_Event[], telemetry?: StreamTelemetryCollector) {
  return readSse(claudeCanonicalStreamResponse(canonicalStream(events), { model: "fallback", messages: [], stream: true }, { heartbeatMs: 0, telemetry }))
}

describe("Kiro metering reaches the telemetry snapshot through the Claude inbound provider", () => {
  test("a stream carrying a metering frame reports the measured credits", async () => {
    const telemetry = new StreamTelemetryCollector({ requestId: "req_credits", provider: "kiro", model: "claude-sonnet-4.5", streaming: true })
    const canonical = streamKiroResponse(upstreamBody(`{"content":"hello"}${MEASURED_METERING_PAYLOAD}{"usage":4}`), "claude-sonnet-4.5", [], 3)

    const sse = await readSse(claudeCanonicalStreamResponse(canonical, { model: "fallback", messages: [], stream: true }, { heartbeatMs: 0, telemetry }))

    expect(telemetry.finalize().providerCredits).toBe(0.0148)
    // Requirement 5.4: the metering frame changed nothing else on the wire.
    const text = sse
      .filter((event) => event.event === "content_block_delta" && event.data.delta?.type === "text_delta")
      .map((event) => event.data.delta.text)
      .join("")
    expect(text).toBe("hello")
    const messageDelta = sse.find((event) => event.event === "message_delta")
    expect(messageDelta?.data.usage.output_tokens).toBe(4)
    expect(JSON.stringify(sse)).not.toContain("0.0148")
  })

  test("two metering frames in one stream total the spend", async () => {
    const telemetry = new StreamTelemetryCollector()
    const canonical = streamKiroResponse(upstreamBody(`{"content":"hi"}${MEASURED_METERING_PAYLOAD}{"unit":"credit","usage":0.0052}{"usage":2}`), "claude-sonnet-4.5", [], 3)

    await readSse(claudeCanonicalStreamResponse(canonical, { model: "fallback", messages: [], stream: true }, { heartbeatMs: 0, telemetry }))

    expect(telemetry.finalize().providerCredits).toBeCloseTo(0.02, 10)
  })

  test("a stream with no metering frame omits providerCredits and completes", async () => {
    const telemetry = new StreamTelemetryCollector()
    const canonical = streamKiroResponse(upstreamBody('{"content":"hello"}{"usage":4}'), "claude-sonnet-4.5", [], 3)

    const sse = await readSse(claudeCanonicalStreamResponse(canonical, { model: "fallback", messages: [], stream: true }, { heartbeatMs: 0, telemetry }))

    expect(telemetry.finalize().providerCredits).toBeUndefined()
    expect(sse.at(-1)?.event).toBe("message_stop")
  })
})

describe("Claude inbound provider feeds credits from canonical usage events", () => {
  test("records credits from a usage event", async () => {
    const telemetry = new StreamTelemetryCollector()
    await readClaudeSse([
      { type: "text_delta", delta: "hi" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1, providerCredits: 0.25 } },
      { type: "message_stop", stopReason: "end_turn" },
    ], telemetry)
    expect(telemetry.finalize().providerCredits).toBe(0.25)
  })

  test("records credits from a completion event", async () => {
    const telemetry = new StreamTelemetryCollector()
    await readClaudeSse([
      { type: "text_delta", delta: "hi" },
      { type: "completion", usage: { inputTokens: 0, outputTokens: 1, providerCredits: 0.5 }, stopReason: "end_turn" },
    ], telemetry)
    expect(telemetry.finalize().providerCredits).toBe(0.5)
  })

  test("sums credits across usage and completion events", async () => {
    const telemetry = new StreamTelemetryCollector()
    await readClaudeSse([
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1, providerCredits: 0.25 } },
      { type: "completion", usage: { inputTokens: 0, outputTokens: 2, providerCredits: 0.75 }, stopReason: "end_turn" },
    ], telemetry)
    expect(telemetry.finalize().providerCredits).toBe(1)
  })

  test("leaves credits unmeasured when usage events carry none", async () => {
    const telemetry = new StreamTelemetryCollector()
    await readClaudeSse([
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "message_stop", stopReason: "end_turn" },
    ], telemetry)
    expect(telemetry.finalize().providerCredits).toBeUndefined()
  })

  test("renders the same wire bytes with and without a collector attached", async () => {
    const events: Canonical_Event[] = [
      { type: "text_delta", delta: "hi" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1, providerCredits: 0.25 } },
      { type: "message_stop", stopReason: "end_turn" },
    ]
    const withCollector = await readClaudeSse(events, new StreamTelemetryCollector())
    const withoutCollector = await readClaudeSse(events)
    expect(stripVolatile(withoutCollector)).toEqual(stripVolatile(withCollector))
  })
})

describe("OpenAI inbound provider feeds credits from canonical usage events", () => {
  test("records credits on the responses stream shape", async () => {
    const telemetry = new StreamTelemetryCollector()
    const response = openAICanonicalStreamResponse(
      canonicalStream([
        { type: "text_delta", delta: "hi" },
        { type: "usage", usage: { inputTokens: 1, outputTokens: 1, providerCredits: 0.25 } },
        { type: "completion", usage: { inputTokens: 0, outputTokens: 2, providerCredits: 0.75 } },
        { type: "message_stop", stopReason: "end_turn" },
      ]),
      "/v1/responses",
      { model: "m", input: "hi" },
      { telemetry },
    )
    const sse = await readSse(response)
    expect(telemetry.finalize().providerCredits).toBe(1)
    expect(JSON.stringify(sse)).not.toContain("0.25")
  })

  test("records credits on the chat-completions stream shape", async () => {
    const telemetry = new StreamTelemetryCollector()
    const response = openAICanonicalStreamResponse(
      canonicalStream([
        { type: "text_delta", delta: "hi" },
        { type: "usage", usage: { inputTokens: 1, outputTokens: 1, providerCredits: 0.25 } },
        { type: "completion", usage: { inputTokens: 0, outputTokens: 2, providerCredits: 0.75 } },
        { type: "message_stop", stopReason: "end_turn" },
      ]),
      "/v1/chat/completions",
      { model: "m", messages: [] },
      { telemetry },
    )
    // The chat-completions shape closes with `data: [DONE]`, which is not JSON.
    const chunks = (await response.text()).trim().split("\n\n").map((chunk) => chunk.replace(/^data: /, ""))
    expect(telemetry.finalize().providerCredits).toBe(1)
    expect(chunks.at(-1)).toBe("[DONE]")
    expect(chunks.join("")).not.toContain("0.25")
  })

  test("leaves credits unmeasured when usage events carry none", async () => {
    const telemetry = new StreamTelemetryCollector()
    const response = openAICanonicalStreamResponse(
      canonicalStream([
        { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
        { type: "message_stop", stopReason: "end_turn" },
      ]),
      "/v1/responses",
      { model: "m", input: "hi" },
      { telemetry },
    )
    await readSse(response)
    expect(telemetry.finalize().providerCredits).toBeUndefined()
  })

  test("streams unchanged when no collector is supplied", async () => {
    const events: Canonical_Event[] = [
      { type: "text_delta", delta: "hi" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1, providerCredits: 0.25 } },
      { type: "message_stop", stopReason: "end_turn" },
    ]
    const withCollector = await readSse(openAICanonicalStreamResponse(canonicalStream(events), "/v1/responses", { model: "m", input: "hi" }, { telemetry: new StreamTelemetryCollector() }))
    const withoutCollector = await readSse(openAICanonicalStreamResponse(canonicalStream(events), "/v1/responses", { model: "m", input: "hi" }))
    expect(stripVolatile(withoutCollector)).toEqual(stripVolatile(withCollector))
  })
})

/** Drops the ids and timestamps a fresh render regenerates so two renders are comparable. */
function stripVolatile(events: Array<{ event?: string; data: unknown }>) {
  return JSON.parse(
    JSON.stringify(events).replace(/"(id|created_at|created|signature)":\s*("[^"]*"|\d+)/g, '"$1":"-"'),
  )
}

// ---------------------------------------------------------------------------
// The other half of the chain: the collector is constructed by the inbound
// provider itself, and its finalized snapshot lands on the `RequestProxyLog`
// object the provider handed to `context.onProxy`. The describes above prove
// renderer → collector with a collector the test supplies; these prove
// handle() → collector → proxy log with no collector supplied by the test, which
// is what the runtime does.
// ---------------------------------------------------------------------------

/** A Kiro-shaped upstream whose stream carries the measured metering payload. */
function meteringUpstream(bytes: string): Upstream_Provider {
  return {
    providerKind: "kiro",
    proxy: async () => streamKiroResponse(upstreamBody(bytes), "claude-sonnet-4.5", [], 3),
    checkHealth: async () => ({ ok: true }),
  }
}

/** `logBody: false` deliberately: telemetry must not depend on body capture. */
function proxyCapturingContext(requestId: string): { context: RequestHandlerContext; logs: RequestProxyLog[] } {
  const logs: RequestProxyLog[] = []
  return {
    logs,
    context: { requestId, logBody: false, quiet: true, onProxy: (log) => logs.push(log) },
  }
}

describe("provider credits reach RequestProxyLog.telemetry through the Claude inbound provider", () => {
  test("a streaming request records the measured credits on the proxy log", async () => {
    const provider = new Claude_Inbound_Provider({ expectedUpstreamKind: "kiro" })
    const { context, logs } = proxyCapturingContext("req_claude_credits")

    const response = await provider.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }], stream: true }),
      }),
      { path: "/v1/messages", method: "POST" },
      meteringUpstream(`{"content":"hello"}${MEASURED_METERING_PAYLOAD}{"usage":4}`),
      context,
    )
    const sse = await readSse(response)

    expect(logs).toHaveLength(1)
    expect(logs[0].telemetry?.providerCredits).toBe(0.0148)
    // Requirement 8.3's omission survives the projection: no notice arrived, so the
    // member is absent rather than present-as-`[]` or present-as-`undefined`.
    expect("featureNotices" in logs[0].telemetry!).toBe(false)
    // Requirement 5.4: the metering payload stays off the client's wire.
    expect(JSON.stringify(sse)).not.toContain("0.0148")
    expect(sse.at(-1)?.event).toBe("message_stop")
  })

  test("a streaming request with no metering payload reports credits unmeasured", async () => {
    const provider = new Claude_Inbound_Provider({ expectedUpstreamKind: "kiro" })
    const { context, logs } = proxyCapturingContext("req_claude_no_credits")

    const response = await provider.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }], stream: true }),
      }),
      { path: "/v1/messages", method: "POST" },
      meteringUpstream('{"content":"hello"}{"usage":4}'),
      context,
    )
    await readSse(response)

    // Present-with-`undefined`, not absent: "not measured" is a reported answer.
    expect(logs[0].telemetry).toBeDefined()
    expect("providerCredits" in logs[0].telemetry!).toBe(true)
    expect(logs[0].telemetry?.providerCredits).toBeUndefined()
  })
})

describe("provider credits reach RequestProxyLog.telemetry through the OpenAI inbound provider", () => {
  test("a streaming request records the measured credits on the proxy log", async () => {
    const provider = new OpenAI_Inbound_Provider({ expectedUpstreamKind: "kiro" })
    const { context, logs } = proxyCapturingContext("req_openai_credits")

    const response = await provider.handle(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4.5", input: "hi", stream: true }),
      }),
      { path: "/v1/responses", method: "POST" },
      meteringUpstream(`{"content":"hello"}${MEASURED_METERING_PAYLOAD}{"usage":4}`),
      context,
    )
    const sse = await readSse(response)

    expect(logs).toHaveLength(1)
    expect(logs[0].telemetry?.providerCredits).toBe(0.0148)
    expect("featureNotices" in logs[0].telemetry!).toBe(false)
    expect(JSON.stringify(sse)).not.toContain("0.0148")
  })

  test("a streaming request with no metering payload reports credits unmeasured", async () => {
    const provider = new OpenAI_Inbound_Provider({ expectedUpstreamKind: "kiro" })
    const { context, logs } = proxyCapturingContext("req_openai_no_credits")

    const response = await provider.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }], stream: true }),
      }),
      { path: "/v1/chat/completions", method: "POST" },
      meteringUpstream('{"content":"hello"}{"usage":4}'),
      context,
    )
    await response.text()

    expect(logs[0].telemetry).toBeDefined()
    expect("providerCredits" in logs[0].telemetry!).toBe(true)
    expect(logs[0].telemetry?.providerCredits).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The non-streaming half of the same chain (task 8.4b). No collector exists on
// this path, so the summary is projected off `Canonical_Response` instead. These
// are the requests the 10 Kiro live cases actually make — `test/native/cases.ts`
// sends `stream: false` — which is why the gap was invisible until 8.6's gate.
// ---------------------------------------------------------------------------

/**
 * A Kiro-shaped upstream that answers a non-streaming canonical request the way the real
 * one does: `src/upstream/kiro/index.ts` returns `collectKiroResponse()` rather than a
 * canonical stream when `request.stream` is falsy.
 */
function nonStreamingMeteringUpstream(bytes: string): Upstream_Provider {
  return {
    providerKind: "kiro",
    proxy: async (request) => request.stream
      ? streamKiroResponse(upstreamBody(bytes), "claude-sonnet-4.5", [], 3)
      : collectKiroResponse(upstreamBody(bytes), "claude-sonnet-4.5", [], 3),
    checkHealth: async () => ({ ok: true }),
  }
}

describe("provider credits reach RequestProxyLog.telemetry on the non-streaming Claude path", () => {
  test("a non-streaming request records the measured credits on the proxy log", async () => {
    const provider = new Claude_Inbound_Provider({ expectedUpstreamKind: "kiro" })
    const { context, logs } = proxyCapturingContext("req_claude_credits_sync")

    const response = await provider.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }], stream: false }),
      }),
      { path: "/v1/messages", method: "POST" },
      nonStreamingMeteringUpstream(`{"content":"hello"}${MEASURED_METERING_PAYLOAD}{"usage":4}`),
      context,
    )
    const body = await response.json() as { content: Array<{ type: string; text?: string }> }

    expect(logs).toHaveLength(1)
    expect(logs[0].telemetry?.providerCredits).toBe(0.0148)
    // Requirement 8.3's omission survives the projection on this path too: no notice
    // arrived, so the member is absent rather than present-as-`[]`.
    expect("featureNotices" in logs[0].telemetry!).toBe(false)
    // Requirement 5.4: the metering payload stays off the client's wire.
    expect(body.content).toEqual([{ type: "text", text: "hello" }])
    expect(JSON.stringify(body)).not.toContain("0.0148")
  })

  test("a non-streaming request with no metering payload reports credits unmeasured", async () => {
    const provider = new Claude_Inbound_Provider({ expectedUpstreamKind: "kiro" })
    const { context, logs } = proxyCapturingContext("req_claude_no_credits_sync")

    await provider.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }], stream: false }),
      }),
      { path: "/v1/messages", method: "POST" },
      nonStreamingMeteringUpstream('{"content":"hello"}{"usage":4}'),
      context,
    )

    // Present-with-`undefined`, not absent: "not measured" is a reported answer, and it
    // is distinct from `0`, which would mean "measured as free".
    expect(logs[0].telemetry).toBeDefined()
    expect("providerCredits" in logs[0].telemetry!).toBe(true)
    expect(logs[0].telemetry?.providerCredits).toBeUndefined()
  })

  test("an omitted `stream` field takes the same non-streaming path", async () => {
    const provider = new Claude_Inbound_Provider({ expectedUpstreamKind: "kiro" })
    const { context, logs } = proxyCapturingContext("req_claude_credits_default")

    await provider.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }),
      }),
      { path: "/v1/messages", method: "POST" },
      nonStreamingMeteringUpstream(`{"content":"hello"}${MEASURED_METERING_PAYLOAD}{"usage":4}`),
      context,
    )

    expect(logs[0].telemetry?.providerCredits).toBe(0.0148)
  })

  test("credits reach the log when a streaming upstream is accumulated for a non-streaming client", async () => {
    const provider = new Claude_Inbound_Provider({ expectedUpstreamKind: "kiro" })
    const { context, logs } = proxyCapturingContext("req_claude_credits_accumulated")

    await provider.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }], stream: false }),
      }),
      { path: "/v1/messages", method: "POST" },
      // Ignores `request.stream` and always streams, so the inbound takes its
      // `isCanonicalStream` + non-streaming-client accumulate branch.
      meteringUpstream(`{"content":"hello"}${MEASURED_METERING_PAYLOAD}{"usage":4}`),
      context,
    )

    expect(logs[0].telemetry?.providerCredits).toBe(0.0148)
    expect("featureNotices" in logs[0].telemetry!).toBe(false)
  })
})

describe("provider credits reach RequestProxyLog.telemetry on the non-streaming OpenAI path", () => {
  test("a non-streaming request records the measured credits on the proxy log", async () => {
    const provider = new OpenAI_Inbound_Provider({ expectedUpstreamKind: "kiro" })
    const { context, logs } = proxyCapturingContext("req_openai_credits_sync")

    const response = await provider.handle(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4.5", input: "hi", stream: false }),
      }),
      { path: "/v1/responses", method: "POST" },
      nonStreamingMeteringUpstream(`{"content":"hello"}${MEASURED_METERING_PAYLOAD}{"usage":4}`),
      context,
    )
    const body = await response.text()

    expect(logs).toHaveLength(1)
    expect(logs[0].telemetry?.providerCredits).toBe(0.0148)
    expect("featureNotices" in logs[0].telemetry!).toBe(false)
    expect(body).not.toContain("0.0148")
  })

  test("a non-streaming request with no metering payload reports credits unmeasured", async () => {
    const provider = new OpenAI_Inbound_Provider({ expectedUpstreamKind: "kiro" })
    const { context, logs } = proxyCapturingContext("req_openai_no_credits_sync")

    await provider.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }),
      }),
      { path: "/v1/chat/completions", method: "POST" },
      nonStreamingMeteringUpstream('{"content":"hello"}{"usage":4}'),
      context,
    )

    expect(logs[0].telemetry).toBeDefined()
    expect("providerCredits" in logs[0].telemetry!).toBe(true)
    expect(logs[0].telemetry?.providerCredits).toBeUndefined()
  })

  test("credits reach the log when a streaming upstream is accumulated for a non-streaming client", async () => {
    const provider = new OpenAI_Inbound_Provider({ expectedUpstreamKind: "kiro" })
    const { context, logs } = proxyCapturingContext("req_openai_credits_accumulated")

    await provider.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }),
      }),
      { path: "/v1/chat/completions", method: "POST" },
      meteringUpstream(`{"content":"hello"}${MEASURED_METERING_PAYLOAD}{"usage":4}`),
      context,
    )

    expect(logs[0].telemetry?.providerCredits).toBe(0.0148)
    expect("featureNotices" in logs[0].telemetry!).toBe(false)
  })
})

// The projection itself, exercised directly on the one input no upstream can produce
// yet: a response carrying notices. Task 10.3/10.4 adds the producer; until then this
// is the only way to gate the notice half of the presence contract.
describe("canonicalResponseTelemetrySummary presence semantics", () => {
  test("omits featureNotices when the response carried none and reports credits", () => {
    const summary = canonicalResponseTelemetrySummary({
      type: "canonical_response",
      id: "resp_1",
      model: "m",
      stopReason: "end_turn",
      content: [],
      usage: { inputTokens: 1, outputTokens: 1, providerCredits: 0.0148 },
    })

    expect("featureNotices" in summary).toBe(false)
    expect(summary.providerCredits).toBe(0.0148)
  })

  test("keeps providerCredits present as undefined when the response measured none", () => {
    const summary = canonicalResponseTelemetrySummary({
      type: "canonical_response",
      id: "resp_2",
      model: "m",
      stopReason: "end_turn",
      content: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    })

    expect("providerCredits" in summary).toBe(true)
    expect(summary.providerCredits).toBeUndefined()
  })

  test("distinguishes measured-as-free from not-measured", () => {
    const free = canonicalResponseTelemetrySummary({
      type: "canonical_response",
      id: "resp_3",
      model: "m",
      stopReason: "end_turn",
      content: [],
      usage: { inputTokens: 1, outputTokens: 1, providerCredits: 0 },
    })

    expect(free.providerCredits).toBe(0)
  })

  test("copies notices in order rather than aliasing the response array", () => {
    const featureNotices: Canonical_FeatureNotice[] = [
      { feature: "webSearch", policy: "emulate", detail: "served by the gateway" },
      { feature: "thinkingBudget", policy: "degrade", detail: "budget ignored" },
    ]
    const response: Canonical_Response = {
      type: "canonical_response",
      id: "resp_4",
      model: "m",
      stopReason: "end_turn",
      content: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      featureNotices: [...featureNotices],
    }

    const summary = canonicalResponseTelemetrySummary(response)

    expect(summary.featureNotices).toEqual([...featureNotices])
    expect(summary.featureNotices).not.toBe(response.featureNotices)
    response.featureNotices!.push({ feature: "mcpToolset", policy: "degrade", detail: "later" })
    expect(summary.featureNotices).toHaveLength(2)
  })
})
