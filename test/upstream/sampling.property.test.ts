// Feature: native-api-mode, Property 21: Upstreams diverge from one canonical sampling input per the matrix.
//
// **Validates: Requirements 14.1, 14.2, 14.4, 14.6**
//
// ## What this file adds over the example tests
//
// `test/upstream/codex-sampling.test.ts` and `test/upstream/copilot/sampling.test.ts` already pin the
// spellings on chosen fixtures, each against one upstream. The generative claim here is the *shape of
// the divergence*: **one** canonical `sampling` object is handed to all three upstream builders in the
// same iteration, and each body is checked against the cell its own directory declares. Three bodies
// built from three separate fixtures could agree by accident and this property would still catch it —
// the request is shared, so the only variable is the upstream.
//
// ## Why the numeric space is the whole numeric space
//
// Task 15.1 recorded it, and both mappers read it back: a sub-member is forwarded when it is
// `typeof "number"`, with no range check, no finiteness filter, and no clamping. So `-0`, `NaN`, both
// infinities, subnormals, and values far outside any documented range are all sampling requests that
// reach the wire unchanged, and the same-value clause has to hold over all of them. Comparison is
// `Object.is` rather than `toBe`-on-`===` for exactly that reason: `NaN === NaN` is false and
// `-0 === 0` is true, so `===` would both reject a correctly forwarded `NaN` and accept a sign-flipped
// zero. Non-numeric values are off-contract — the inbound mappers drop them — and are not generated.
//
// ## The three clauses, and what each one is protecting
//
// - **Codex** carries **none** of the mapped Responses fields, and the body's key set is disjoint
//   from `RESPONSES_REJECTED_FIELDS`. On this upstream those are one statement rather than two:
//   `.omc/research/kiro-wire-spike.md` §11.2 sent `temperature`, `top_p`, and `max_output_tokens`
//   one per run and measured `400 {"detail":"Unsupported parameter: <name>"}` for each against a 200
//   control carrying none of them, so all three are denylist entries. This clause read "carries each
//   mapped Responses field with the value the client sent" until that probe; it is restated rather
//   than dropped, because "the field is absent" is a claim worth making about a request that
//   otherwise dies with a 400 (Requirement 14.2). What keeps the denylist itself honest is
//   `test/upstream/codex-denylist.test.ts` — this property cannot tell a complete list from an
//   incomplete one, which is exactly how Run_Record 16 passed offline while the live gate failed.
// - **Copilot** carries the same mapped fields and carries neither `max_tokens` nor `stop`.
//   `Copilot_Client.proxy()` posts to `/responses`, so the chat-completions spelling would be a latent
//   400 there, and the Responses API has no stop parameter at all (Requirement 14.4).
// - **Kiro** carries none of them, at any depth. Kiro answers 200 to unknown fields and discards them
//   (§4), which is precisely why the absence has to be asserted rather than trusted: a leaked
//   `temperature` would never surface as an error, it would surface as a client silently not getting
//   the sampling it asked for. The payload-level companion invariants — no `inferenceConfig`, no
//   `systemPrompt` — are Property 13 in `test/upstream/kiro/payload-shape.property.test.ts`.
//
// The notice half of the divergence — who *tells* the client — is Property 22 in
// `test/upstream/sampling-divergence.property.test.ts`. This file is about bytes on the wire only,
// and after the §11.2 correction that split matters more, not less: Codex dropping the field is
// only acceptable because Property 22 asserts the client is told, and neither file can see the
// other's half.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_Request } from "../../src/core/canonical"
import type { JsonObject } from "../../src/core/types"
import { canonicalToCodexBody } from "../../src/upstream/codex/parse"
import { CODEX_SAMPLING_RESPONSES_FIELDS, RESPONSES_REJECTED_FIELDS } from "../../src/upstream/codex/sampling"
import { buildCopilotResponsesBody } from "../../src/upstream/copilot/parse"
import { COPILOT_SAMPLING_DROPPED_FIELDS, COPILOT_SAMPLING_RESPONSES_FIELDS, copilotSamplingFields } from "../../src/upstream/copilot/sampling"
import { convertCanonicalToKiroPayload } from "../../src/upstream/kiro"

// ---------------------------------------------------------------------------------------------
// The canonical → Responses mapping, stated independently of the code under test
// ---------------------------------------------------------------------------------------------

type SamplingMember = "maxOutputTokens" | "temperature" | "topP"

/**
 * The three numeric controls and their Responses spellings.
 *
 * Written out here rather than read from either mapper on purpose: this is the *expectation* side of
 * the property. Deriving it from a mapper would reduce the same-value clause to "the mapper agrees
 * with itself", and a mapper that emitted nothing at all would pass. With the table independent, a
 * Copilot request carrying a numeric control and a body missing the field is a failure — and the
 * Codex absence clause is a claim about these specific names rather than about whatever the current
 * builder happens to spell.
 *
 * `satisfies` keeps it total against {@link SamplingMember}, so a fourth numeric control added to the
 * canonical contract cannot be added to the mappers without being added here.
 */
const RESPONSES_FIELD_BY_MEMBER = {
  maxOutputTokens: "max_output_tokens",
  temperature: "temperature",
  topP: "top_p",
} as const satisfies Record<SamplingMember, string>

const SAMPLING_MEMBERS = Object.keys(RESPONSES_FIELD_BY_MEMBER) as readonly SamplingMember[]

/** Every Responses field name a sampling mapper is allowed to produce. */
const MAPPED_RESPONSES_FIELDS: readonly string[] = Object.values(RESPONSES_FIELD_BY_MEMBER)

/**
 * The two spellings Requirement 14.4 names for Copilot by their absence.
 *
 * Kept apart from {@link RESPONSES_REJECTED_FIELDS}, which is Codex's own recorded denylist: the two
 * lists happen to overlap today, and folding them together would make the Copilot clause silently
 * change meaning the next time Codex records a new rejected parameter.
 */
const COPILOT_FORBIDDEN_FIELDS = ["max_tokens", "stop"] as const

/**
 * Names that must not appear anywhere in a Kiro payload: the mapped Responses fields, the spellings
 * Codex records as rejected, and the camel-case forms a Kiro-shaped translation would reach for.
 *
 * Deduplicated through a `Set`, which became necessary rather than tidy when §11.2 put all three
 * mapped spellings onto the rejected list: the two sources now overlap completely, and the negative
 * control below compares this list against a leaky payload by equality, so a repeated name would
 * fail it while nothing was actually wrong.
 */
const KIRO_FORBIDDEN_KEYS: readonly string[] = [
  ...new Set([...MAPPED_RESPONSES_FIELDS, ...RESPONSES_REJECTED_FIELDS, "maxTokens", "topP", "stopSequences", "inferenceConfig"]),
]

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/** The generated sampling object: at least one control set, so no iteration is a no-op. */
interface SamplingInput {
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
}

const KIRO_TOOL: JsonObject = { type: "function", name: "save", description: "save a note", parameters: { type: "object", properties: {} } }

/**
 * One canonical request, shared by all three builders in an iteration.
 *
 * The conversation half is fixed and deliberately dull — a single short user text and one tool with an
 * empty schema. The property is about the sampling fields, and generated message or tool text could
 * introduce a key named `temperature` into the payload that the Kiro deep walk would then report as a
 * leak. Holding the payload's other content constant keeps a failure attributable to sampling.
 */
function requestWith(sampling: SamplingInput | undefined): Canonical_Request {
  return {
    model: "gpt-5.4",
    instructions: "be brief",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [KIRO_TOOL],
    stream: false,
    passthrough: false,
    metadata: {},
    ...(sampling ? { sampling } : {}),
  }
}

/**
 * Numbers a client can actually put on the wire.
 *
 * The named cases are the ones a filter would get wrong: both zeroes (a request for deterministic
 * sampling, and the value truthiness reads as absent), the documented range ends, out-of-range and
 * negative values, the extreme magnitudes, and the three non-finite values. `fc.double()` without
 * `noNaN`/`noDefaultInfinity` restrictions fills in the rest, including more non-finite draws.
 */
const NUMERIC_EDGE_CASES: readonly number[] = [
  0,
  -0,
  1,
  2,
  0.7,
  -1,
  1e300,
  Number.EPSILON,
  Number.MIN_VALUE,
  Number.MAX_VALUE,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
]

const numberArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...NUMERIC_EDGE_CASES) },
  { weight: 3, arbitrary: fc.double() },
  { weight: 2, arbitrary: fc.integer({ min: -1000, max: 200_000 }) },
)

const stopSequencesArb = fc.array(fc.oneof(fc.constantFrom("STOP", "HALT", "\n\n", ""), fc.string({ maxLength: 8 })), { maxLength: 3 })

/**
 * A sampling object with at least one member present.
 *
 * `fc.record` with every key optional would generate `{}`, which is "the client asked for nothing"
 * wearing the shape of a request — a real case, but one where every clause below holds vacuously. It
 * is covered by its own example clause instead, so the generative runs always carry intent.
 */
const samplingArb: fc.Arbitrary<SamplingInput> = fc
  .record(
    {
      maxOutputTokens: numberArb,
      temperature: numberArb,
      topP: numberArb,
      stopSequences: stopSequencesArb,
    },
    { requiredKeys: [] },
  )
  .filter((sampling) => Object.keys(sampling).length > 0)

// ---------------------------------------------------------------------------------------------
// Observation helpers
// ---------------------------------------------------------------------------------------------

/** `Object.is` so a forwarded `NaN` passes and a sign-flipped zero fails. */
function expectSameValue(body: JsonObject, field: string, expected: number, upstream: string): void {
  if (!Object.hasOwn(body, field)) {
    throw new Error(`${upstream} body is missing ${field}, which the canonical request set to ${String(expected)}`)
  }
  const actual = body[field]
  if (!Object.is(actual, expected)) {
    throw new Error(`${upstream} body carries ${field}=${String(actual)} where the canonical request said ${String(expected)}`)
  }
}

/** Every key present anywhere in a value, at any depth, including inside arrays. */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into)
    return into
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key)
      collectKeys(child, into)
    }
  }
  return into
}

function kiroPayload(request: Canonical_Request): JsonObject {
  return convertCanonicalToKiroPayload(request, [KIRO_TOOL], { modelId: "claude-sonnet-4-5", authType: "aws_sso_oidc", instructions: request.instructions }) as unknown as JsonObject
}

// ---------------------------------------------------------------------------------------------
// Property 21
// ---------------------------------------------------------------------------------------------

describe("Upstream sampling divergence", () => {
  /**
   * Codex: each mapped Responses field carries the value the client sent, and the finished body shares
   * no key with the recorded rejected list.
   *
   * **Validates: Requirements 14.1, 14.2**
   */
  test("Feature: native-api-mode, Property 21: Upstreams diverge from one canonical sampling input per the matrix — the Codex body carries no sampling field and no rejected field", () => {
    fc.assert(
      fc.property(samplingArb, (sampling) => {
        const request = requestWith(sampling)
        const body = canonicalToCodexBody(request)

        // Restated from "each mapped field carries the value the client sent". The generated space
        // is unchanged and the request is unchanged; only the expectation moved, because §11.2
        // measured every one of these three names answered `400 Unsupported parameter`.
        for (const member of SAMPLING_MEMBERS) {
          expect(Object.hasOwn(body, RESPONSES_FIELD_BY_MEMBER[member])).toBe(false)
        }

        // Requirement 14.2, as a set statement rather than a per-field check: nothing the endpoint
        // refuses survives, whatever the client sent or a future builder adds.
        const keys = new Set(Object.keys(body))
        const overlap = RESPONSES_REJECTED_FIELDS.filter((field) => keys.has(field))
        expect(overlap).toEqual([])

        // Anti-vacuity, and the reason the two clauses above are not the same clause: a builder
        // that returned `{}` would satisfy both. The envelope is still built.
        expect(body.model).toBe("gpt-5.4")
        expect(Object.hasOwn(body, "input")).toBe(true)
        expect(Object.hasOwn(body, "instructions")).toBe(true)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * Why the Codex clause above is an absence rather than a mapping: the recorded spelling of every
   * canonical control is a name this endpoint refuses (§11.2, §11.7 item 2).
   *
   * Read together with the clause above this is the whole statement — "no field is emitted" plus
   * "there was no emittable field to begin with" — and each half fails for a different edit. The
   * measurement side of the same relation is `test/upstream/codex-denylist.test.ts`.
   *
   * **Validates: Requirement 14.2**
   */
  test("Feature: native-api-mode, Property 21: every Responses spelling of a canonical control is on the Codex rejected list", () => {
    expect([...CODEX_SAMPLING_RESPONSES_FIELDS].sort()).toEqual([...MAPPED_RESPONSES_FIELDS].sort() as typeof CODEX_SAMPLING_RESPONSES_FIELDS[number][])
    for (const field of CODEX_SAMPLING_RESPONSES_FIELDS) expect(RESPONSES_REJECTED_FIELDS).toContain(field)
  })

  /**
   * Copilot: the same mapped fields with the same values, and neither `max_tokens` nor `stop`.
   *
   * **Validates: Requirement 14.4**
   */
  test("Feature: native-api-mode, Property 21: Upstreams diverge from one canonical sampling input per the matrix — the Copilot body carries the mapped Responses fields and no max_tokens or stop", () => {
    fc.assert(
      fc.property(samplingArb, (sampling) => {
        const body = buildCopilotResponsesBody(requestWith(sampling))

        for (const member of SAMPLING_MEMBERS) {
          const value = sampling[member]
          const field = RESPONSES_FIELD_BY_MEMBER[member]
          if (typeof value === "number") expectSameValue(body, field, value, "copilot")
          else expect(Object.hasOwn(body, field)).toBe(false)
        }

        for (const field of COPILOT_FORBIDDEN_FIELDS) expect(Object.hasOwn(body, field)).toBe(false)
        // The dropped member has no wire target under any spelling this layer could have guessed.
        expect(Object.hasOwn(body, "stop_sequences")).toBe(false)
        expect(COPILOT_SAMPLING_DROPPED_FIELDS).toContain("stopSequences")

        const fragment = copilotSamplingFields(sampling) as unknown as Record<string, number>
        for (const [field, value] of Object.entries(fragment)) expectSameValue(body, field, value, "copilot")
        // Only the recorded field names ever appear, so a new emission has to be declared.
        for (const field of Object.keys(fragment)) expect(COPILOT_SAMPLING_RESPONSES_FIELDS).toContain(field as (typeof COPILOT_SAMPLING_RESPONSES_FIELDS)[number])
      }),
      { numRuns: 300 },
    )
  })

  /**
   * Kiro: none of the sampling field names appear in the payload, at any depth.
   *
   * Depth matters here in a way it does not for the other two. A Responses body is flat, so a leak
   * would be a top-level key; a Kiro payload nests two levels deep before it reaches the message, so a
   * plausible wrong implementation puts the controls inside `conversationState` or an
   * `inferenceConfig` block rather than at the root. A top-level-only check would pass that.
   *
   * **Validates: Requirement 14.6**
   */
  test("Feature: native-api-mode, Property 21: Upstreams diverge from one canonical sampling input per the matrix — the Kiro payload carries none of them", () => {
    fc.assert(
      fc.property(samplingArb, (sampling) => {
        const keys = collectKeys(kiroPayload(requestWith(sampling)))
        const leaked = KIRO_FORBIDDEN_KEYS.filter((key) => keys.has(key))
        expect(leaked).toEqual([])
      }),
      { numRuns: 300 },
    )
  })

  /**
   * The headline: one canonical object, three builders, in one iteration.
   *
   * This is what makes the file a divergence property rather than three independent absence checks —
   * the same input is present on Codex, present on Copilot, and absent on Kiro at the same time, so a
   * change that made two upstreams behave alike fails here even if each per-upstream clause was
   * adjusted to match.
   *
   * **Validates: Requirements 14.1, 14.2, 14.4, 14.6**
   */
  test("Feature: native-api-mode, Property 21: Upstreams diverge from one canonical sampling input per the matrix — one input, three outcomes", () => {
    fc.assert(
      fc.property(samplingArb, (sampling) => {
        const request = requestWith(sampling)
        const codex = canonicalToCodexBody(request)
        const copilot = buildCopilotResponsesBody(request)
        const kiroKeys = collectKeys(kiroPayload(request))

        const numericMembers = SAMPLING_MEMBERS.filter((member) => typeof sampling[member] === "number")

        for (const member of numericMembers) {
          const field = RESPONSES_FIELD_BY_MEMBER[member]
          const value = sampling[member] as number
          // Present, with the value the client sent, on the one Responses upstream that takes it…
          expectSameValue(copilot, field, value, "copilot")
          // …and absent on both upstreams that do not, for two different measured reasons: Codex
          // answers `400 Unsupported parameter` to this very name (§11.2), Kiro answers 200 and
          // discards it (§4). The divergence used to run two-present against one-absent; it now
          // runs one-present against two-absent, and it is still one request.
          expect(Object.hasOwn(codex, field)).toBe(false)
          expect(kiroKeys.has(field)).toBe(false)
        }

        // A request whose only control is a stop list reaches no Responses upstream at all: neither
        // has a field for it, so both bodies carry nothing from it while Kiro stays empty as well.
        if (numericMembers.length === 0) {
          for (const field of MAPPED_RESPONSES_FIELDS) {
            expect(Object.hasOwn(codex, field)).toBe(false)
            expect(Object.hasOwn(copilot, field)).toBe(false)
          }
        }

        // Anti-vacuity for the new shape: Copilot really is the present side, so "absent on Codex"
        // is a divergence rather than three upstreams agreeing to send nothing.
        if (numericMembers.length > 0) {
          expect(numericMembers.some((member) => Object.hasOwn(copilot, RESPONSES_FIELD_BY_MEMBER[member]))).toBe(true)
        }
      }),
      { numRuns: 300 },
    )
  })

  /**
   * The negative control for the Kiro clause.
   *
   * `collectKeys` reporting nothing is only evidence if it *can* report something. A payload-shaped
   * object with the controls buried two levels down must be caught; otherwise the Kiro clause above
   * would pass against a detector that always returns the empty set — the one failure mode an
   * absence assertion has.
   */
  test("Feature: native-api-mode, Property 21: the Kiro absence check detects a leak when one exists", () => {
    const leaky = {
      conversationState: {
        currentMessage: { userInputMessage: { content: "hello", inferenceConfig: { temperature: 0.5, max_output_tokens: 10 } } },
        history: [{ userInputMessage: { content: "hi", top_p: 0.9 } }],
      },
    }

    const keys = collectKeys(leaky)
    expect(KIRO_FORBIDDEN_KEYS.filter((key) => keys.has(key)).sort()).toEqual(["inferenceConfig", "max_output_tokens", "temperature", "top_p"])
  })

  /**
   * A request carrying no `sampling` member adds no key to any of the three, so the presence clauses
   * above are about fields the client asked for and not about fields that are always there.
   *
   * **Validates: Requirements 14.1, 14.4, 14.6**
   */
  test("Feature: native-api-mode, Property 21: a request carrying no sampling member adds no sampling key anywhere", () => {
    const request = requestWith(undefined)
    const codex = canonicalToCodexBody(request)
    const copilot = buildCopilotResponsesBody(request)
    const kiroKeys = collectKeys(kiroPayload(request))

    for (const field of MAPPED_RESPONSES_FIELDS) {
      expect(Object.hasOwn(codex, field)).toBe(false)
      expect(Object.hasOwn(copilot, field)).toBe(false)
      expect(kiroKeys.has(field)).toBe(false)
    }
    for (const field of RESPONSES_REJECTED_FIELDS) expect(Object.hasOwn(codex, field)).toBe(false)
  })

  /**
   * An empty `sampling` object is present-but-empty: the one shape where "the member exists" and "the
   * client asked for a control" come apart. It must behave like an absent member on the wire.
   *
   * **Validates: Requirements 14.1, 14.4, 14.6**
   */
  test("Feature: native-api-mode, Property 21: an empty sampling object behaves like an absent one", () => {
    const request = requestWith({})
    const codex = canonicalToCodexBody(request)
    const copilot = buildCopilotResponsesBody(request)

    for (const field of MAPPED_RESPONSES_FIELDS) {
      expect(Object.hasOwn(codex, field)).toBe(false)
      expect(Object.hasOwn(copilot, field)).toBe(false)
    }
    expect(codex).toEqual(canonicalToCodexBody(requestWith(undefined)))
    expect(copilot).toEqual(buildCopilotResponsesBody(requestWith(undefined)))
  })
})
