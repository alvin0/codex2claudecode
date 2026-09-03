// Property 10 for the Kiro metering channel (task 7.5).
//
// The unit tests in `test/upstream/kiro/metering.test.ts` cover the two classifier functions, and
// the `describe("Kiro metering frames become provider credits and nothing else")` block in
// `test/upstream/kiro/parse.test.ts` covers a handful of fixed frame sequences. This file covers
// the part neither can: that the isolation holds for *any* frame sequence, with metering payloads
// at arbitrary positions and counts — including inside a tool-use triple, which no example test
// exercises.
//
// The generator is grounded in the frame kinds measured across ~30 live Kiro calls
// (`.omc/research/kiro-wire-spike.md` §2) and is seeded, via fast-check `examples`, with the exact
// recorded sequence carrying one metering payload (Requirement 5.6).
//
// **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.6**

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_Event } from "../../../src/core/canonical"
import { collectKiroResponse, streamKiroResponse } from "../../../src/upstream/kiro/parse"

// ---------------------------------------------------------------------------------------------
// Recorded wire material (`.omc/research/kiro-wire-spike.md` §2)
// ---------------------------------------------------------------------------------------------

/** The measured `meteringEvent` payload, verbatim. */
const MEASURED_METERING_FRAME = "{\"unit\":\"credit\",\"unitPlural\":\"credits\",\"usage\":0.0148}"
const MEASURED_METERING_USAGE = 0.0148
/** The measured `assistantResponseEvent` text delta, verbatim. */
const MEASURED_CONTENT_FRAME = "{\"content\":\"ello spike\"}"
/** The measured `reasoningContentEvent` — signature only, no text, and no scanner pattern matches it. */
const MEASURED_SIGNATURE_FRAME = "{\"signature\":\"EqwCCpEBnotarealsignaturevalueonlyshapeandlength\"}"
/** The measured `contextUsageEvent` for a near-empty request. */
const MEASURED_CONTEXT_FRAME = "{\"contextUsagePercentage\":0.6485}"

/**
 * The recorded sequence used to seed the properties: content, the discarded reasoning signature,
 * one metering payload, then the context-usage tail. Expressed as the (base groups, metering plan)
 * pair the generators produce, so it is fed through the identical code path as a generated case.
 */
const RECORDED_BASE_GROUPS: string[][] = [[MEASURED_CONTENT_FRAME], [MEASURED_SIGNATURE_FRAME], [MEASURED_CONTEXT_FRAME]]
const RECORDED_METERING_PLAN: MeteringInsertion[] = [{ usage: MEASURED_METERING_USAGE, at: 2 }]

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

/**
 * Text characters allowed inside generated payload strings.
 *
 * Deliberately excludes `{`, `"`, `:`, `<`, `[`, and `(`. The frame scanner is prefix-based, so a
 * generated content value containing `{"unit":` or `{"content":` would create a nested boundary
 * match; task 7.1 established that `findEventStart` returns the earliest match so the enclosing
 * frame still wins, but generating adversarial framing here would mean a failure could be the
 * generator's fault rather than the property's. The other exclusions keep the generated text out of
 * unrelated interpreters that would add their own noise to the differential: `<` for
 * `ThinkingBlockExtractor` tag detection, `[` for the `[Called … with args: …]` bracket tool-call
 * extractor, and `(` for the `(empty)` sentinel skip.
 */
const SAFE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.".split("")

function safeText(minLength: number, maxLength: number) {
  return fc.array(fc.constantFrom(...SAFE_CHARS), { minLength, maxLength }).map((chars) => chars.join(""))
}

/** `assistantResponseEvent` — a plain text delta. */
const contentGroup = fc.oneof(
  fc.constant<string[]>([MEASURED_CONTENT_FRAME]),
  safeText(1, 24).map((content) => [JSON.stringify({ content })]),
)

/**
 * `assistantResponseEvent` whose text carries the inline `<thinking>` tags `ThinkingBlockExtractor`
 * exists to strip. Included because this is the only frame kind that makes the parser mint the
 * volatile values the differential has to cope with — the thinking block index and the
 * `sig_…` placeholder signature.
 */
const thinkingContentGroup = fc.tuple(safeText(1, 16), safeText(1, 16)).map(([thought, tail]) => [
  JSON.stringify({ content: `<thinking>${thought}</thinking>${tail}` }),
])

/** `toolUseEvent` — the measured three-stage shape, emitted as three consecutive frames. */
const toolUseGroup = fc.tuple(fc.constantFrom("get_weather", "save_note"), safeText(3, 8), safeText(1, 12)).map(([name, idSuffix, query]) => {
  // `bdrk` matches the measured id prefix and also guarantees the id cannot look like a minted
  // 32-hex-character identifier, so the volatile-id normalizer below leaves it alone.
  const toolUseId = `toolu_bdrk_01${idSuffix}`
  return [
    JSON.stringify({ name, toolUseId }),
    JSON.stringify({ input: JSON.stringify({ query }), name, toolUseId }),
    JSON.stringify({ name, stop: true, toolUseId }),
  ]
})

/** `contextUsageEvent` — drives the input-token estimate, so it must stay metering-independent. */
const contextUsageGroup = fc.oneof(
  fc.constant<string[]>([MEASURED_CONTEXT_FRAME]),
  fc.double({ min: 0.01, max: 99, noNaN: true, noDefaultInfinity: true }).map((contextUsagePercentage) => [JSON.stringify({ contextUsagePercentage })]),
)

/** `reasoningContentEvent` — matched by no scanner pattern, so it is discarded as noise today. */
const signatureGroup = fc.oneof(
  fc.constant<string[]>([MEASURED_SIGNATURE_FRAME]),
  safeText(20, 60).map((body) => [JSON.stringify({ signature: `EqwCCpEB${body}` })]),
)

const frameGroup = fc.oneof(
  { weight: 4, arbitrary: contentGroup },
  { weight: 2, arbitrary: toolUseGroup },
  { weight: 2, arbitrary: contextUsageGroup },
  { weight: 1, arbitrary: thinkingContentGroup },
  { weight: 1, arbitrary: signatureGroup },
)

const baseGroups = fc.array(frameGroup, { maxLength: 5 })

interface MeteringInsertion {
  usage: number
  /** Insertion slot; reduced modulo the flattened frame count, so any position is reachable. */
  at: number
}

const meteringUsage = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(MEASURED_METERING_USAGE, 0.0052, 0) },
  { weight: 1, arbitrary: fc.double({ min: 0, max: 5, noNaN: true, noDefaultInfinity: true }) },
)

const meteringInsertion: fc.Arbitrary<MeteringInsertion> = fc.record({ usage: meteringUsage, at: fc.nat({ max: 32 }) })

// ---------------------------------------------------------------------------------------------
// Frame assembly
// ---------------------------------------------------------------------------------------------

function meteringFrame(usage: number) {
  return usage === MEASURED_METERING_USAGE ? MEASURED_METERING_FRAME : JSON.stringify({ unit: "credit", unitPlural: "credits", usage })
}

/**
 * Build the with-metering and without-metering frame lists from one generated case. The
 * without-metering list is the reference: it is the same sequence with every metering frame
 * removed, which is exactly the comparison Property 10 names.
 */
function buildSequences(groups: string[][], insertions: MeteringInsertion[]) {
  const withoutMetering = groups.flat()
  const slots = new Map<number, number[]>()
  for (const insertion of insertions) {
    const at = insertion.at % (withoutMetering.length + 1)
    slots.set(at, [...(slots.get(at) ?? []), insertion.usage])
  }
  const withMetering: string[] = []
  const meteringUsagesInOrder: number[] = []
  for (let index = 0; index <= withoutMetering.length; index += 1) {
    for (const usage of slots.get(index) ?? []) {
      withMetering.push(meteringFrame(usage))
      meteringUsagesInOrder.push(usage)
    }
    if (index < withoutMetering.length) withMetering.push(withoutMetering[index])
  }
  // Summed in wire order with the same `0` seed the parser uses, so float accumulation is
  // bit-identical to `(providerCredits ?? 0) + credits` rather than merely close.
  const expectedCredits = meteringUsagesInOrder.reduce((total, usage) => total + usage, 0)
  return { withMetering, withoutMetering, meteringUsagesInOrder, expectedCredits }
}

function response(frames: string[]) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame))
      controller.close()
    },
  }))
}

// ---------------------------------------------------------------------------------------------
// Volatile value normalization
// ---------------------------------------------------------------------------------------------

/**
 * Identifiers the Kiro parser mints per run from `crypto.randomUUID()`: `sig_…` thinking
 * signatures, `fc_…` content-block ids, `resp_…` response ids, and `toolu_…` ids invented for
 * bracket-extracted calls. Each is 32 lowercase hex characters after the prefix.
 *
 * These differ between the with-metering run and the without-metering run **by construction** —
 * they are fresh random values, not a function of the input — so comparing them would fail for a
 * reason that has nothing to do with metering. Normalizing exactly this pattern keeps the rest of
 * the comparison byte-exact: event order, event types, block indices, deltas, tool call ids that
 * came off the wire, stop reasons, and every other field are all compared unmodified. The
 * alternative the task warns against — weakening the comparison to an event count or a type list —
 * would let a metering frame silently change a delta or a block index.
 */
const MINTED_ID = /^(?:sig|fc|resp|toolu)_[0-9a-f]{32}$/
const MINTED_ID_PLACEHOLDER = "<minted-id>"

function normalizeMintedIds(value: unknown): unknown {
  if (typeof value === "string") return MINTED_ID.test(value) ? MINTED_ID_PLACEHOLDER : value
  if (Array.isArray(value)) return value.map(normalizeMintedIds)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeMintedIds(entry)]))
  return value
}

// ---------------------------------------------------------------------------------------------
// Path drivers
// ---------------------------------------------------------------------------------------------

/** Streaming path: `iterateKiroEvents` reached through its only public entry, `streamKiroResponse`. */
async function drainStreaming(frames: string[]) {
  const events: Canonical_Event[] = []
  for await (const event of streamKiroResponse(response(frames), "model", [], 7).events) events.push(event)
  const usageEvents = events.flatMap((event) => event.type === "usage" ? [event.usage] : [])
  return {
    /** Every emitted event except `usage` — the list Property 10 requires to be identical. */
    nonUsageEvents: normalizeMintedIds(events.filter((event) => event.type !== "usage")),
    usage: usageEvents[0],
    usageEventCount: usageEvents.length,
  }
}

/** Non-streaming path: `collectKiroResponse`, which consumes the same canonical events. */
async function drainCollected(frames: string[]) {
  const collected = await collectKiroResponse(response(frames), "model", [], 7)
  return {
    /** The collector's observable minus usage: the content it folded plus the stop reason. */
    nonUsageResult: normalizeMintedIds({ id: collected.id, model: collected.model, stopReason: collected.stopReason, content: collected.content }),
    usage: collected.usage,
  }
}

function tokenFieldsOf(usage: Record<string, unknown> | undefined) {
  const { providerCredits, ...tokenFields } = usage ?? {}
  return tokenFields
}

/**
 * The three clauses of Property 10, checked against one generated case on one path.
 *
 * Requirement 5.4 applies to both paths, so both drivers feed this same assertion body.
 */
function assertMeteringIsolation(
  withMetering: { nonUsage: unknown; usage: Record<string, unknown> | undefined },
  withoutMetering: { nonUsage: unknown; usage: Record<string, unknown> | undefined },
  expectedCredits: number,
  meteringCount: number,
) {
  // Clause 1 — the emitted non-usage output is identical with and without the metering frames.
  expect(withMetering.nonUsage).toEqual(withoutMetering.nonUsage)
  // Clause 1 (token half, Requirement 5.4) — metering never lands in a token counter.
  expect(tokenFieldsOf(withMetering.usage)).toEqual(tokenFieldsOf(withoutMetering.usage))
  // Clause 3 — the reference run carries no credit field at all, not an undefined one.
  expect(Object.keys(withoutMetering.usage ?? {})).not.toContain("providerCredits")

  if (meteringCount === 0) {
    // Clause 3 again, for the generated case where the plan itself is empty.
    expect(Object.keys(withMetering.usage ?? {})).not.toContain("providerCredits")
    return
  }
  // Clause 2 — the credit total is the sum of the metering `usage` values, exactly.
  expect(Object.keys(withMetering.usage ?? {})).toContain("providerCredits")
  expect(withMetering.usage?.providerCredits).toBe(expectedCredits)
}

async function checkBothPaths(groups: string[][], insertions: MeteringInsertion[]) {
  const { withMetering, withoutMetering, meteringUsagesInOrder, expectedCredits } = buildSequences(groups, insertions)

  const streamedWith = await drainStreaming(withMetering)
  const streamedWithout = await drainStreaming(withoutMetering)
  assertMeteringIsolation(
    { nonUsage: streamedWith.nonUsageEvents, usage: streamedWith.usage as Record<string, unknown> | undefined },
    { nonUsage: streamedWithout.nonUsageEvents, usage: streamedWithout.usage as Record<string, unknown> | undefined },
    expectedCredits,
    meteringUsagesInOrder.length,
  )
  // A metering frame must not add or remove a usage event either.
  expect(streamedWith.usageEventCount).toBe(streamedWithout.usageEventCount)

  const collectedWith = await drainCollected(withMetering)
  const collectedWithout = await drainCollected(withoutMetering)
  assertMeteringIsolation(
    { nonUsage: collectedWith.nonUsageResult, usage: collectedWith.usage as unknown as Record<string, unknown> },
    { nonUsage: collectedWithout.nonUsageResult, usage: collectedWithout.usage as unknown as Record<string, unknown> },
    expectedCredits,
    meteringUsagesInOrder.length,
  )
}

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

describe("Kiro metering isolation properties", () => {
  test("Feature: native-api-mode, Property 10: Metering payloads change only the credit total", async () => {
    await fc.assert(fc.asyncProperty(baseGroups, fc.array(meteringInsertion, { maxLength: 4 }), checkBothPaths), {
      numRuns: 100,
      // Seed: the recorded sequence carrying one metering payload (Requirement 5.6). Runs first,
      // and is also what a shrunk counterexample is measured against.
      examples: [[RECORDED_BASE_GROUPS, RECORDED_METERING_PLAN]],
    })
  })

  test("Feature: native-api-mode, Property 10: Metering payloads change only the credit total — two or more metering payloads sum", async () => {
    await fc.assert(fc.asyncProperty(baseGroups, fc.array(meteringInsertion, { minLength: 2, maxLength: 5 }), checkBothPaths), {
      numRuns: 100,
      // A preflight call plus the main generate, the shape that made `providerCredits` a sum.
      examples: [[RECORDED_BASE_GROUPS, [{ usage: MEASURED_METERING_USAGE, at: 1 }, { usage: 0.0052, at: 3 }]]],
    })
  })

  test("Feature: native-api-mode, Property 10: Metering payloads change only the credit total — a zero-credit payload is still reported", async () => {
    const planWithZero = fc.tuple(fc.nat({ max: 32 }), fc.array(meteringInsertion, { maxLength: 2 })).map(([at, rest]) => [{ usage: 0, at }, ...rest])
    await fc.assert(fc.asyncProperty(baseGroups, planWithZero, checkBothPaths), {
      numRuns: 100,
      examples: [[RECORDED_BASE_GROUPS, [{ usage: 0, at: 2 }]]],
    })
  })

  test("Feature: native-api-mode, Property 10: Metering payloads change only the credit total — a sequence with no metering payload omits providerCredits", async () => {
    // Requirement 5.3: the field is absent, and the stream still completes. Reaching the
    // assertions at all is the no-throw half; `checkBothPaths` compares the sequence against
    // itself here, so what this run adds is the omission clause over arbitrary frame sequences.
    await fc.assert(fc.asyncProperty(baseGroups, async (groups) => { await checkBothPaths(groups, []) }), {
      numRuns: 100,
      examples: [[RECORDED_BASE_GROUPS]],
    })
  })
})
