// Property 6 for feature-notice collection (task 8.5).
//
// The example-based blocks already cover fixed sequences: `CanonicalStreamAccumulator feature
// notices` in `test/core/canonical-accumulator.test.ts`, `StreamTelemetryCollector feature notices`
// in `test/core/stream-telemetry.test.ts`, `collectKiroResponse feature notices` in
// `test/upstream/kiro/parse.test.ts`, and the telemetry-in-request-log tests in
// `test/request-logs.test.ts`. This file covers what none of them can: that the three clauses hold
// for *any* canonical event sequence, with notices at arbitrary positions and counts — including
// several notices landing between two `text_delta`s, inside a tool-call pair, and inside an open
// thinking block, which no example exercises.
//
// Both collectors named by Requirement 8.2 are covered: the shared non-streaming fold
// (`CanonicalStreamAccumulator`, task 8.2) and the streaming collector
// (`StreamTelemetryCollector`, task 8.3). `collectKiroResponse()` is deliberately excluded — its
// notice fold reads events from `iterateKiroEvents()`, which emits no `feature_notice` today
// (producing one is task 10.3/10.4), so its positive arm is unreachable from a test without
// fabricating events the parser cannot emit. Its negative arm — a wire sequence carrying no notice
// omits the field — is already covered in `test/upstream/kiro/parse.test.ts`.
//
// **Validates: Requirements 8.2, 8.3, 8.4**

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type {
  Canonical_Event,
  Canonical_FeatureNotice,
  Canonical_FeatureNoticePolicy,
  Canonical_StreamResponse,
  Canonical_Usage,
} from "../../src/core/canonical"
import { CanonicalStreamAccumulator, accumulateCanonicalStream } from "../../src/core/canonical-accumulator"
import { PROVIDER_FEATURES } from "../../src/core/provider-capabilities"
import type { StreamTelemetry } from "../../src/core/stream-telemetry"
import { StreamTelemetryCollector } from "../../src/core/stream-telemetry"
import { mergeCanonicalUsage } from "../../src/core/usage"

// ---------------------------------------------------------------------------------------------
// Generators — notices
// ---------------------------------------------------------------------------------------------

/**
 * Text characters allowed inside generated strings. Excludes `<` and `[` so generated content never
 * reaches an inline-markup interpreter, which would add noise a failure could be blamed on rather
 * than on the property.
 */
const SAFE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.=".split("")

function safeText(minLength: number, maxLength: number) {
  return fc.array(fc.constantFrom(...SAFE_CHARS), { minLength, maxLength }).map((chars) => chars.join(""))
}

/**
 * The two allowed policies, spelled through the canonical alias so a change to
 * {@link Canonical_FeatureNoticePolicy} breaks this file at compile time instead of leaving it
 * generating a stale vocabulary. `native` and `reject` travel their own paths (Requirement 8.6).
 */
const NOTICE_POLICIES = ["degrade", "emulate"] as const satisfies readonly Canonical_FeatureNoticePolicy[]

/**
 * A small pool of realistic details, weighted above freely generated text.
 *
 * The pool exists to make *exact* duplicates common: with 12 features, 2 policies, and 4 details,
 * a plan of four notices repeats an entry often. The no-dedupe guarantee is therefore proven by the
 * general property rather than only by the duplicate-specific run below.
 */
const NOTICE_DETAILS = [
  "temperature=0.2 was not sent upstream",
  "response_format emulated via a tool",
  "thinking.budgetTokens=8000 mapped to effort=medium",
  "tool_choice=required degraded to auto",
]

const noticeDetail = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...NOTICE_DETAILS) },
  // Non-empty by construction (Requirement 8.1).
  { weight: 1, arbitrary: safeText(1, 20).map((text) => `detail ${text}`) },
)

/** Features come from the real vocabulary, never from invented names. */
const featureNotice: fc.Arbitrary<Canonical_FeatureNotice> = fc.record({
  feature: fc.constantFrom(...PROVIDER_FEATURES),
  policy: fc.constantFrom(...NOTICE_POLICIES),
  detail: noticeDetail,
})

interface NoticeInsertion {
  notice: Canonical_FeatureNotice
  /** Insertion slot; reduced modulo the event count, so every position is reachable. */
  at: number
}

const noticeInsertion: fc.Arbitrary<NoticeInsertion> = fc.record({ notice: featureNotice, at: fc.nat({ max: 40 }) })

// ---------------------------------------------------------------------------------------------
// Generators — the surrounding canonical event stream
// ---------------------------------------------------------------------------------------------

/**
 * Events are generated in groups rather than one at a time so that multi-event shapes stay coherent
 * — a tool call is a delta plus a done, a thinking block is an optional signature plus a delta —
 * while a notice can still be inserted *between* the members of a group.
 */
const messageStartGroup = safeText(3, 8).map<Canonical_Event[]>((suffix) => [
  { type: "message_start", id: `resp_wire_${suffix}`, model: "test-model" },
])

const textDeltaGroup = safeText(1, 12).map<Canonical_Event[]>((delta) => [{ type: "text_delta", delta }])

const textDoneGroup = safeText(1, 12).map<Canonical_Event[]>((text) => [{ type: "text_done", text }])

/**
 * With and without an explicit signature. The signature-less arm is the only shape that makes the
 * accumulator mint a value (`sig_` plus 16 hex characters), which is what the normalizer below
 * exists for. Generated signatures carry a `wire_` prefix so they can never be mistaken for one.
 */
const thinkingGroup = fc
  .tuple(safeText(1, 10), fc.option(safeText(6, 20), { nil: undefined }))
  .map<Canonical_Event[]>(([text, signature]) =>
    signature === undefined
      ? [{ type: "thinking_delta", text }]
      : [{ type: "thinking_signature", signature: `wire_${signature}` }, { type: "thinking_delta", text }],
  )

/** A label-only thinking delta, the other arm of the `text ?? label` read. */
const thinkingLabelGroup = safeText(1, 10).map<Canonical_Event[]>((label) => [{ type: "thinking_delta", label }])

const toolCallGroup = fc
  .tuple(fc.constantFrom("get_weather", "save_note"), safeText(3, 6), safeText(1, 8))
  .map<Canonical_Event[]>(([name, idSuffix, query]) => {
    const callId = `call_wire_${idSuffix}`
    return [
      { type: "tool_call_delta", callId, name, argumentsDelta: "{\"q\":" },
      { type: "tool_call_done", callId, name, arguments: JSON.stringify({ q: query }) },
    ]
  })

/** A delta with no matching done, so the finalize-time flush of pending tool calls also runs. */
const pendingToolCallGroup = fc
  .tuple(fc.constantFrom("get_weather", "save_note"), safeText(3, 6))
  .map<Canonical_Event[]>(([name, idSuffix]) => [
    { type: "tool_call_delta", callId: `call_wire_${idSuffix}`, name, argumentsDelta: "{\"partial\":true}" },
  ])

const serverToolGroup = safeText(1, 8).map<Canonical_Event[]>((query) => [
  { type: "server_tool_block", blocks: [{ type: "web_search_tool_result", query }] },
])

const usageGroup = fc
  .record({
    inputTokens: fc.nat({ max: 5000 }),
    outputTokens: fc.nat({ max: 2000 }),
    cacheReadInputTokens: fc.option(fc.nat({ max: 1000 }), { nil: undefined }),
    cacheCreationInputTokens: fc.option(fc.nat({ max: 1000 }), { nil: undefined }),
    outputReasoningTokens: fc.option(fc.nat({ max: 500 }), { nil: undefined }),
    providerCredits: fc.option(fc.double({ min: 0, max: 2, noNaN: true, noDefaultInfinity: true }), { nil: undefined }),
  })
  .map<Canonical_Event[]>((usage) => [{ type: "usage", usage: definedOnly(usage) }])

const completionGroup = fc
  .tuple(fc.constantFrom("end_turn", "max_tokens"), fc.option(fc.nat({ max: 1500 }), { nil: undefined }))
  .map<Canonical_Event[]>(([stopReason, outputTokens]) => [
    {
      type: "completion",
      stopReason,
      ...(outputTokens === undefined ? {} : { usage: { inputTokens: 0, outputTokens } }),
    },
  ])

const messageStopGroup = fc
  .constantFrom("end_turn", "max_tokens", "stop_sequence")
  .map<Canonical_Event[]>((stopReason) => [{ type: "message_stop", stopReason }])

const errorGroup = safeText(1, 10).map<Canonical_Event[]>((message) => [{ type: "error", message }])

/** Event kinds both collectors tolerate without acting on them. */
const noiseGroup = fc.oneof(
  safeText(1, 8).map<Canonical_Event[]>((label) => [{ type: "lifecycle", label }]),
  fc
    .tuple(fc.constantFrom("text", "thinking"), fc.nat({ max: 3 }))
    .map<Canonical_Event[]>(([blockType, index]) => [
      { type: "content_block_start", blockType, index },
      { type: "content_block_stop", index },
    ]),
  safeText(1, 8).map<Canonical_Event[]>((id) => [{ type: "message_item_done", item: { id } }]),
)

const eventGroup = fc.oneof(
  { weight: 5, arbitrary: textDeltaGroup },
  { weight: 3, arbitrary: thinkingGroup },
  { weight: 3, arbitrary: toolCallGroup },
  { weight: 3, arbitrary: usageGroup },
  { weight: 2, arbitrary: messageStopGroup },
  { weight: 2, arbitrary: serverToolGroup },
  { weight: 1, arbitrary: textDoneGroup },
  { weight: 1, arbitrary: thinkingLabelGroup },
  { weight: 1, arbitrary: pendingToolCallGroup },
  { weight: 1, arbitrary: completionGroup },
  { weight: 1, arbitrary: messageStartGroup },
  { weight: 1, arbitrary: errorGroup },
  { weight: 1, arbitrary: noiseGroup },
)

const baseGroups = fc.array(eventGroup, { maxLength: 6 })

function definedOnly(usage: Record<string, number | undefined>): Partial<Canonical_Usage> {
  return Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) as Partial<Canonical_Usage>
}

// ---------------------------------------------------------------------------------------------
// Sequence assembly
// ---------------------------------------------------------------------------------------------

/**
 * Build the with-notices and without-notices event lists from one generated case, plus the notice
 * list the collectors are required to reproduce.
 *
 * The without-notices list is the reference for the token clause: it is the same sequence with
 * *every* notice removed, which is exactly the comparison Requirement 8.4 names. Several notices
 * mapping to one slot stay in plan order, so `expectedNotices` is emission order by construction.
 */
function buildSequences(groups: Canonical_Event[][], insertions: NoticeInsertion[]) {
  const withoutNotices = groups.flat()
  const slots = new Map<number, Canonical_FeatureNotice[]>()
  for (const insertion of insertions) {
    const at = insertion.at % (withoutNotices.length + 1)
    slots.set(at, [...(slots.get(at) ?? []), insertion.notice])
  }

  const withNotices: Canonical_Event[] = []
  const expectedNotices: Canonical_FeatureNotice[] = []
  for (let index = 0; index <= withoutNotices.length; index += 1) {
    for (const notice of slots.get(index) ?? []) {
      withNotices.push({ type: "feature_notice", ...notice })
      expectedNotices.push(notice)
    }
    if (index < withoutNotices.length) withNotices.push(withoutNotices[index]!)
  }
  return { withNotices, withoutNotices, expectedNotices }
}

function makeStream(events: Canonical_Event[]): Canonical_StreamResponse {
  return {
    type: "canonical_stream",
    status: 200,
    id: "resp_property",
    model: "test-model",
    events: (async function* () {
      for (const event of events) yield event
    })(),
  }
}

// ---------------------------------------------------------------------------------------------
// Volatile value normalization
// ---------------------------------------------------------------------------------------------

/**
 * The one value the accumulator mints per run: the placeholder thinking signature
 * `sig_` + 16 hex characters, produced from `crypto.randomUUID()` when a thinking block closes
 * without a `thinking_signature`.
 *
 * It differs between the with-notices run and the without-notices run **by construction** — it is a
 * fresh random value, not a function of the input — so comparing it would fail for a reason that has
 * nothing to do with notices. Normalizing exactly this pattern keeps the rest of the comparison
 * exact: block order, block types, text, tool ids that came off the wire, arguments, stop reason,
 * and every token member are compared unmodified. Weakening the differential to a block count would
 * let a notice silently split a text block or move a token.
 */
const MINTED_SIGNATURE = /^sig_[0-9a-f]{16}$/
const MINTED_SIGNATURE_PLACEHOLDER = "<minted-signature>"

function normalizeMintedIds(value: unknown): unknown {
  if (typeof value === "string") return MINTED_SIGNATURE.test(value) ? MINTED_SIGNATURE_PLACEHOLDER : value
  if (Array.isArray(value)) return value.map(normalizeMintedIds)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeMintedIds(entry)]))
  }
  return value
}

// ---------------------------------------------------------------------------------------------
// Collector drivers
// ---------------------------------------------------------------------------------------------

interface CollectorObservation {
  /** The collected notices, or `undefined` when the field was omitted. */
  notices: Canonical_FeatureNotice[] | undefined
  /** Whether the key is genuinely present, as opposed to present-with-`undefined`. */
  hasNoticeKey: boolean
  /** Everything the collector reports *other than* notices — the differential's subject. */
  rest: unknown
  /** Token totals, pulled out so the Requirement 8.4 clause reads as itself. */
  tokens: { inputTokens: number; outputTokens: number }
}

/** Shared non-streaming fold (task 8.2). */
async function observeAccumulator(events: Canonical_Event[]): Promise<CollectorObservation> {
  const result = await accumulateCanonicalStream(makeStream(events))
  const { featureNotices, ...rest } = result
  return {
    notices: featureNotices,
    hasNoticeKey: "featureNotices" in result,
    rest: normalizeMintedIds(rest),
    tokens: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
  }
}

/**
 * Streaming collector (task 8.3), driven the way an inbound renderer drives it.
 *
 * `StreamTelemetryCollector` is a record-as-you-go API rather than a stream consumer, so this
 * driver stands in for the renderer: it walks the canonical events, records notices, credits, and
 * errors as they pass, merges usage with the same `mergeCanonicalUsage()` the renderers use, and
 * counts blocks off the shared accumulator's finalized content rather than re-deriving block
 * boundaries here. `markFirstToken()` fires on content-bearing events only — a notice carries no
 * model output, so it must not start the clock.
 */
function observeTelemetry(events: Canonical_Event[]): CollectorObservation {
  const collector = new StreamTelemetryCollector({
    requestId: "req_property",
    provider: "test-upstream",
    model: "test-model",
    streaming: true,
  })
  const accumulator = new CanonicalStreamAccumulator("resp_property", "test-model")
  const usage: Canonical_Usage = { inputTokens: 0, outputTokens: 0 }

  for (const event of events) {
    accumulator.apply(event)
    switch (event.type) {
      case "feature_notice":
        collector.recordFeatureNotice(event)
        break
      case "text_delta":
      case "text_done":
      case "thinking_delta":
      case "tool_call_delta":
        collector.markFirstToken()
        break
      case "usage":
        mergeCanonicalUsage(usage, event.usage)
        if (typeof event.usage.providerCredits === "number") collector.recordProviderCredits(event.usage.providerCredits)
        collector.usageSource = "upstream_exact"
        break
      case "completion":
        if (event.usage) mergeCanonicalUsage(usage, event.usage)
        break
      case "error":
        collector.recordStreamError()
        collector.terminalEvent = "error"
        break
      case "message_stop":
        collector.terminalEvent = "message_stop"
        break
      default:
        break
    }
  }

  for (const block of accumulator.finalize().content) {
    if (block.type === "text") collector.recordTextBlock()
    if (block.type === "thinking") collector.recordThinkingBlock()
    if (block.type === "tool_call") collector.recordClientToolCall()
    if (block.type === "server_tool") collector.recordServerToolCall()
  }

  const telemetry = collector.finalize()
  return {
    notices: telemetry.featureNotices,
    hasNoticeKey: "featureNotices" in telemetry,
    rest: comparableTelemetry(telemetry, usage),
    tokens: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  }
}

/**
 * The telemetry snapshot minus notices, with the two wall-clock members replaced: `durationMs` and
 * `firstTokenMs` are timings, so they differ between two runs of the same input. Whether the first
 * token was marked at all is still compared, since a notice must not mark one.
 */
function comparableTelemetry(telemetry: StreamTelemetry, usage: Canonical_Usage) {
  const { featureNotices: _notices, durationMs: _duration, firstTokenMs, ...rest } = telemetry
  return { ...rest, firstTokenMarked: firstTokenMs !== undefined, usage }
}

// ---------------------------------------------------------------------------------------------
// The three clauses of Property 6
// ---------------------------------------------------------------------------------------------

function assertProperty6(
  noticed: CollectorObservation,
  bare: CollectorObservation,
  expectedNotices: Canonical_FeatureNotice[],
) {
  // Clause 1 — order- and count-preserving, one entry per event, repeats kept. `toEqual` is deep
  // and strict about extra keys, so an entry that smuggled the event's `type` member through would
  // fail here too.
  if (expectedNotices.length) {
    expect(noticed.hasNoticeKey).toBe(true)
    expect(noticed.notices).toEqual(expectedNotices)
  } else {
    // Clause 2 — omitted rather than empty, for the generated case whose plan is empty.
    expect(noticed.hasNoticeKey).toBe(false)
    expect(noticed.notices).toBeUndefined()
  }

  // Clause 2 — the reference run carries no key at all, not a present-but-`undefined` one.
  expect(bare.hasNoticeKey).toBe(false)
  expect(bare.notices).toBeUndefined()

  // Clause 3 — token-neutral (Requirement 8.4), stated as itself.
  expect(noticed.tokens).toEqual(bare.tokens)
  // …and the stronger form: content blocks, stop reason, and every other reported member are
  // identical too, so a notice cannot split a text block or shift a counter.
  expect(noticed.rest).toEqual(bare.rest)
}

async function checkBothCollectors(groups: Canonical_Event[][], insertions: NoticeInsertion[]) {
  const { withNotices, withoutNotices, expectedNotices } = buildSequences(groups, insertions)

  // Requirement 8.2 has two halves — the shared fold and the streaming collector — and both are
  // held to the identical assertion body.
  assertProperty6(await observeAccumulator(withNotices), await observeAccumulator(withoutNotices), expectedNotices)
  assertProperty6(observeTelemetry(withNotices), observeTelemetry(withoutNotices), expectedNotices)
}

// ---------------------------------------------------------------------------------------------
// Seed case
// ---------------------------------------------------------------------------------------------

/**
 * A hand-written seed: two text deltas that a notice lands between, a usage event, and a stop.
 * The plan puts two *identical* notices in the same slot, so the seed alone proves the no-dedupe
 * guarantee for adjacent repeats, and a third notice later in the stream.
 */
const SEED_GROUPS: Canonical_Event[][] = [
  [{ type: "message_start", id: "resp_seed", model: "test-model" }],
  [{ type: "text_delta", delta: "Hello" }],
  [{ type: "text_delta", delta: " world" }],
  [{ type: "usage", usage: { inputTokens: 100, outputTokens: 25 } }],
  [{ type: "message_stop", stopReason: "end_turn" }],
]

const SEED_PLAN: NoticeInsertion[] = [
  { notice: { feature: "sampling", policy: "degrade", detail: NOTICE_DETAILS[0]! }, at: 2 },
  { notice: { feature: "sampling", policy: "degrade", detail: NOTICE_DETAILS[0]! }, at: 2 },
  { notice: { feature: "thinkingBudget", policy: "degrade", detail: NOTICE_DETAILS[2]! }, at: 3 },
]

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

describe("Feature notice collection properties", () => {
  test("Feature: native-api-mode, Property 6: Feature notices are order- and count-preserving and token-neutral", async () => {
    await fc.assert(fc.asyncProperty(baseGroups, fc.array(noticeInsertion, { maxLength: 5 }), checkBothCollectors), {
      numRuns: 150,
      examples: [[SEED_GROUPS, SEED_PLAN]],
    })
  })

  test("Feature: native-api-mode, Property 6: Feature notices are order- and count-preserving and token-neutral — exact duplicates are never collapsed", async () => {
    // One generated notice repeated two to six times at arbitrary positions. The collected list must
    // be that notice repeated the same number of times: no dedupe by `(feature, detail)`, and no
    // collapsing of adjacent repeats.
    const duplicatePlan = fc
      .tuple(featureNotice, fc.array(fc.nat({ max: 40 }), { minLength: 2, maxLength: 6 }))
      .map(([notice, positions]) => positions.map((at) => ({ notice, at })))

    await fc.assert(fc.asyncProperty(baseGroups, duplicatePlan, checkBothCollectors), {
      numRuns: 150,
      examples: [[SEED_GROUPS, [SEED_PLAN[0]!, SEED_PLAN[1]!]]],
    })
  })

  test("Feature: native-api-mode, Property 6: Feature notices are order- and count-preserving and token-neutral — a stream with no notice omits the field", async () => {
    // Requirement 8.3 over arbitrary sequences: the key is absent, and both collectors complete
    // without throwing. Reaching the assertions at all is the no-throw half.
    await fc.assert(
      fc.asyncProperty(baseGroups, async (groups) => {
        await checkBothCollectors(groups, [])
      }),
      { numRuns: 150, examples: [[SEED_GROUPS]] },
    )
  })
})
