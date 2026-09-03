// Feature: native-api-mode, Property 40: An output-length limit is reported, not refused, and the
// sampling controls still reject.
//
// **Validates: Requirements 1.7, 3.5, 3.7, 3.8, 10.5, 10.9, 10.10, 14.3**
//
// ## The load-bearing claim
//
// The first clause is the whole reason task 12b exists. `max_tokens` is **mandatory** in the Claude
// Messages API, so *every* Claude request carries an output-length limit. While `maxOutputTokens`
// was counted as a `sampling` control and Kiro declared `sampling: "reject"`, the moment the inbound
// mapper started forwarding that field every single Claude→Kiro request would have been answered
// with a 400 — not a subset, every one. The clause below is the statement that such a request
// instead reaches an upstream payload, with a notice describing what happened to the limit.
//
// So this file is not "one more matrix cell has a test". It is the regression guard for the product
// refusing every ordinary request from its primary client.
//
// ## Why the resolvers and the payload builder, not the live harness
//
// `resolveKiroFeatures` / `resolveCodexFeatures` / `resolveCopilotFeatures` are pure
// `(request, { strict }) => FeatureDecisions`, and `convertCanonicalToKiroPayload()` is a pure
// request → payload function. Both are reachable with no client, no auth, and no network, which is
// what makes the claim generative over the numeric space rather than pinned to one fixture.
//
// More importantly it makes the claim hold *across* the canonical contract change: nothing populates
// `Canonical_Request.sampling` until task 14, so a harness-level test of this would be vacuous today
// and would only start measuring anything on the day the breakage would otherwise land. Written
// here, the property holds before task 14 populates the member and keeps holding after.
//
// ## How the expectations avoid restating the policies
//
// Hardcoding "Kiro emits a notice for `outputLength`" would pass just as well if a declaration and
// the resolver were changed together in the wrong direction. So every expectation is derived:
// {@link CHANNEL_BY_POLICY} restates the *matrix semantics* — which policy reports, which fails,
// which is silent — independently of `src/core/feature-policy.ts`, and the concrete policy is read
// from each provider's own `capabilities.ts`. This mirrors the idiom in
// `test/upstream/sampling-divergence.property.test.ts` (Property 22). The recorded value of each
// cell is pinned separately, per cell, in `test/upstream/capabilities.property.test.ts` (Property 1).
//
// ## Strict mode is deliberately not asserted here
//
// `resolveFeature()` escalates `degrade → reject` under `NATIVE_STRICT`, so with Kiro declaring
// `outputLength: "degrade"` a strict run returns 400 for every Claude→Kiro request. Task 12b's body
// records that openly as an unresolved reading — it may be the intended meaning of strict mode, or
// strict may need a floor for fields the inbound API makes mandatory — and states that this task
// **does not decide it and does not encode a decision either way**. Asserting either answer here
// would encode one. So the Kiro clauses below run at the default `strict: false`; the general
// escalation rule is already covered, for all 12 features, by Property 5 in
// `test/core/strict.property.test.ts`. The Codex and Copilot clauses do vary `strict`: Copilot
// declares this cell `native`, which never escalates, and the Codex escalation is derived from the
// declaration rather than restated, so neither varies the open Kiro question.
//
// ## The correction this file carries
//
// Codex used to sit beside Copilot as a silent row. `.omc/research/kiro-wire-spike.md` §11.2 sent
// `max_output_tokens: 16` to the Codex Responses endpoint and measured
// `400 {"detail":"Unsupported parameter: max_output_tokens"}` against a 200 control carrying no
// limit, so that cell is `degrade` and Codex reports. Copilot is untouched and still unmeasured. The
// lesson is worth keeping next to the clause: "the Responses API documents this parameter" was the
// argument for both cells, and it turned out not to be an argument about either endpoint.
//
// ## Input space
//
// `maxOutputTokens` is `number` in the canonical contract, and the detection is
// `typeof sampling.maxOutputTokens === "number"`. So the generated space is every number a client
// can actually put in that field — not only "a plausible token count": zero, one, negative,
// non-integer, absurdly large, and the three non-finite values are all `typeof "number"` and are
// therefore all a request for an output-length limit. A non-numeric limit is off-contract and is not
// generated; it never reaches an upstream as a number, so an assertion about it would describe the
// inbound mapper's job rather than this one's.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_FeatureNotice, Canonical_Request } from "../../src/core/canonical"
import type { FeatureDecisions } from "../../src/core/feature-decisions"
import type { FeaturePolicy, ProviderFeature } from "../../src/core/provider-capabilities"
import { FEATURE_POLICIES, PROVIDER_FEATURES } from "../../src/core/provider-capabilities"
import { CODEX_CAPABILITIES } from "../../src/upstream/codex/capabilities"
import { resolveCodexFeatures } from "../../src/upstream/codex/features"
import { COPILOT_CAPABILITIES } from "../../src/upstream/copilot/capabilities"
import { resolveCopilotFeatures } from "../../src/upstream/copilot/features"
import { KIRO_CAPABILITIES } from "../../src/upstream/kiro/capabilities"
import { resolveKiroFeatures } from "../../src/upstream/kiro/features"
import { convertCanonicalToKiroPayload } from "../../src/upstream/kiro/payload"

const OUTPUT_LENGTH = "outputLength" as const satisfies ProviderFeature
const SAMPLING = "sampling" as const satisfies ProviderFeature

// ---------------------------------------------------------------------------------------------
// The upstream table
// ---------------------------------------------------------------------------------------------

interface OutputLengthUpstream {
  /** Directory name, used in failure messages. */
  name: string
  /** The `outputLength` cell, read from this provider's own declaration — never restated here. */
  declaredOutputLength: FeaturePolicy
  /** The `sampling` cell, same rule. The two differing on Kiro is what task 12b bought. */
  declaredSampling: FeaturePolicy
  /** This provider's resolver, a pure function of the request. */
  resolve: (request: Canonical_Request, options?: { strict?: boolean }) => FeatureDecisions
}

const UPSTREAMS: readonly OutputLengthUpstream[] = [
  {
    name: "kiro",
    declaredOutputLength: KIRO_CAPABILITIES.features.outputLength,
    declaredSampling: KIRO_CAPABILITIES.features.sampling,
    resolve: resolveKiroFeatures,
  },
  {
    name: "codex",
    declaredOutputLength: CODEX_CAPABILITIES.features.outputLength,
    declaredSampling: CODEX_CAPABILITIES.features.sampling,
    resolve: resolveCodexFeatures,
  },
  {
    name: "copilot",
    declaredOutputLength: COPILOT_CAPABILITIES.features.outputLength,
    declaredSampling: COPILOT_CAPABILITIES.features.sampling,
    resolve: resolveCopilotFeatures,
  },
]

const KIRO = UPSTREAMS[0]!
/**
 * The two non-Kiro rows, driven from the same table as Kiro.
 *
 * Renamed from `NATIVE_UPSTREAMS`: since spike §11.2 measured `codex.outputLength` as `degrade`,
 * "the native ones" is no longer what these two rows have in common. What they have in common is
 * that the Responses API documents a field for the limit — which turned out not to settle whether a
 * given Responses endpoint accepts it.
 */
const UPSTREAMS_WITH_A_WIRE_TARGET = [UPSTREAMS[1]!, UPSTREAMS[2]!] as const

/** The rows whose own declaration says this feature is silent, read from the declaration. */
const SILENT_OUTPUT_LENGTH_UPSTREAMS = UPSTREAMS.filter((upstream) => upstream.declaredOutputLength === "native")

/**
 * What a caller can observe about one feature after resolution: nothing, one notice, or a failed
 * request. The same vocabulary as `test/core/feature-policy.property.test.ts` and Property 22,
 * because this property is those semantics read for one specific feature.
 */
type OutcomeChannel = "silent" | "notice" | "rejection"

/**
 * The matrix semantics, restated independently of `src/core/feature-policy.ts`.
 *
 * This is the expectation side of the property, so it must not be computed by the code under test.
 * `satisfies` keeps it total: a fifth `FeaturePolicy` member fails to compile here.
 */
const CHANNEL_BY_POLICY = {
  native: "silent",
  emulate: "notice",
  degrade: "notice",
  reject: "rejection",
} as const satisfies Record<FeaturePolicy, OutcomeChannel>

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/**
 * The canonical `sampling` member task 13 declares and task 14 populates, attached through a cast.
 *
 * The same forward-compatible idiom the resolvers use locally (`FutureCanonicalRequestMembers` in
 * each provider's `features.ts`) and the same one `test/upstream/kiro/features.test.ts`,
 * `test/upstream/sampling-divergence.property.test.ts`, and `test/upstream/no-silent-drop.test.ts`
 * already use.
 *
 * The request is built **directly** rather than routed through an inbound mapper on purpose: the
 * mappers drop this field until task 14, so a request built that way would carry no limit at all and
 * every clause below would pass vacuously — the exact failure mode this property exists to catch.
 *
 * `stopSequences` is deliberately absent from this view: it is a third `ProviderFeature` with its own
 * cell, and including it would put an unrelated outcome in the request.
 */
interface SamplingControls {
  maxOutputTokens?: number
  temperature?: number
  topP?: number
}

function requestWithSampling(sampling: SamplingControls): Canonical_Request {
  return {
    model: "claude-sonnet-4-5",
    instructions: "Be helpful",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
    sampling,
  } as Canonical_Request
}

/**
 * Output-length limits a client can actually send. Every one is `typeof "number"`, so every one is a
 * request for a limit and must reach a declared outcome.
 *
 * The named constants are the boundaries worth naming: both zeroes (`-0` is a distinct value with the
 * same `typeof`), one, the Claude and Kiro defaults that appear in the live harness, a negative and a
 * non-integer limit — both nonsense as token counts and both still *sent*, which is the point —
 * the subnormal and maximum magnitudes, and the three non-finite values. `fc.integer` / `fc.double`
 * fill in the rest of the space.
 */
const OUTPUT_LENGTH_EDGE_CASES: readonly number[] = [
  0,
  -0,
  1,
  4,
  256,
  4096,
  200_000,
  -1,
  -4096,
  0.5,
  1.5,
  256.7,
  Number.EPSILON,
  Number.MIN_VALUE,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_VALUE,
  1e300,
  2 ** 31,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
]

const outputLengthArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...OUTPUT_LENGTH_EDGE_CASES) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 1_000_000 }) },
  { weight: 2, arbitrary: fc.double() },
  { weight: 1, arbitrary: fc.integer({ min: -1_000_000, max: 0 }) },
)

/** A temperature or a top-p or both — at least one, so the request always asks for `sampling`. */
const samplingControlsArb: fc.Arbitrary<SamplingControls> = fc
  .record(
    {
      temperature: fc.option(fc.double(), { nil: undefined }),
      topP: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
    },
    { requiredKeys: [] },
  )
  .filter((controls) => typeof controls.temperature === "number" || typeof controls.topP === "number")

// ---------------------------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------------------------

function noticesFor(decisions: FeatureDecisions, feature: ProviderFeature): Canonical_FeatureNotice[] {
  return decisions.notices().filter((notice) => notice.feature === feature)
}

/**
 * The channel this upstream actually used for one feature, plus the exclusivity check.
 *
 * Throws rather than returning a list when more than one channel is used: two channels for one
 * feature is the fifth-outcome failure Requirement 10.8 forbids, and it should name the upstream and
 * the feature rather than surface as a confusing equality mismatch.
 */
function observedChannel(upstream: OutputLengthUpstream, decisions: FeatureDecisions, feature: ProviderFeature): OutcomeChannel {
  const notices = noticesFor(decisions, feature)
  const rejected = decisions.firstRejection()?.feature === feature

  const channels: OutcomeChannel[] = []
  if (notices.length > 0) channels.push("notice")
  if (rejected) channels.push("rejection")
  if (channels.length === 0) channels.push("silent")

  if (channels.length !== 1) {
    throw new Error(`${upstream.name} used ${channels.length} channels for ${feature} (${channels.join(", ")})`)
  }
  if (notices.length > 1) {
    throw new Error(`${upstream.name} emitted ${notices.length} ${feature} notices for one request; exactly one outcome means exactly one notice`)
  }
  return channels[0]!
}

/**
 * Every key appearing anywhere in a JSON-ish value, normalized so that `maxTokens`, `max_tokens`, and
 * `MaxTokens` all collapse to one name.
 *
 * Normalizing rather than matching the exact spelling is deliberate: the claim is that no output-length
 * limit reaches this wire format at all, and a builder that renamed the field on the way out would
 * satisfy a literal `"maxTokens"` check while sending exactly what spike §4 measured being ignored.
 */
function normalizedKeysDeep(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) normalizedKeysDeep(entry, into)
    return into
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      into.add(key.toLowerCase().replaceAll(/[_-]/g, ""))
      normalizedKeysDeep(nested, into)
    }
  }
  return into
}

function kiroPayloadKeys(request: Canonical_Request): Set<string> {
  const payload = convertCanonicalToKiroPayload(request, [], { modelId: "claude-sonnet-4-5", authType: "aws_sso_oidc" })
  return normalizedKeysDeep(payload)
}

/**
 * The whole per-upstream `outputLength` clause: the feature was covered, the channel is the one its
 * own declaration implies, and the channel's payload is well formed.
 */
function assertDeclaredOutputLengthOutcome(upstream: OutputLengthUpstream, sampling: SamplingControls, strict: boolean): OutcomeChannel {
  const decisions = upstream.resolve(requestWithSampling(sampling), { strict })

  // Covered, whatever the outcome (Requirements 10.9, 10.10). A feature that never reached
  // resolution is the silent drop Requirement 10.1 removes, and "zero notices" alone cannot tell
  // the two apart.
  expect(decisions.resolvedFeatures().has(OUTPUT_LENGTH)).toBe(true)

  const expected = strict && upstream.declaredOutputLength === "degrade" ? "rejection" : CHANNEL_BY_POLICY[upstream.declaredOutputLength]
  const observed = observedChannel(upstream, decisions, OUTPUT_LENGTH)
  if (observed !== expected) {
    throw new Error(
      `${upstream.name} declares outputLength=${upstream.declaredOutputLength} (strict=${strict}), which means a ${expected} outcome, ` +
        `but the resolver produced ${observed} for ${JSON.stringify(sampling)}`,
    )
  }

  if (observed === "notice") {
    const notices = noticesFor(decisions, OUTPUT_LENGTH)
    expect(notices).toHaveLength(1)
    // The notice reports the declared policy, not some other reporting policy. Widened to `string`
    // for the comparison only: a notice policy is narrower than a `FeaturePolicy` by construction
    // (Requirement 8.6), and the assertion is that the two agree at runtime.
    const noticePolicy: string = notices[0]!.policy
    expect(noticePolicy).toBe(upstream.declaredOutputLength)
    expect(notices[0]!.detail.trim().length).toBeGreaterThan(0)
  }

  return observed
}

// ---------------------------------------------------------------------------------------------
// Property 40
// ---------------------------------------------------------------------------------------------

describe("Output length is reported rather than refused", () => {
  /**
   * Anti-vacuity, declaration side. Every clause below reads its expectation from a declaration, so
   * all of them would pass against a vocabulary where `outputLength` does not exist as its own
   * feature, or against three upstreams that agree, or against a Kiro whose two cells are the same
   * policy. Each of those is the pre-12b state or a regression back toward it.
   *
   * **Validates: Requirements 1.7, 3.8, 10.9, 10.10**
   */
  test("Feature: native-api-mode, Property 40: outputLength is its own declared feature and Kiro's cell differs from sampling and from the other upstreams", () => {
    // It is a member of the vocabulary, distinct from `sampling` (Requirement 1.7).
    expect(PROVIDER_FEATURES).toContain(OUTPUT_LENGTH)
    expect(PROVIDER_FEATURES).toContain(SAMPLING)
    expect(OUTPUT_LENGTH).not.toBe(SAMPLING)

    for (const upstream of UPSTREAMS) {
      expect(FEATURE_POLICIES).toContain(upstream.declaredOutputLength)
      expect(FEATURE_POLICIES).toContain(upstream.declaredSampling)
    }

    // The split is load-bearing on Kiro: one policy for the limit, a different one for the two
    // controls that have nowhere to go (Requirement 3.8).
    expect(KIRO.declaredOutputLength).not.toBe(KIRO.declaredSampling)
    expect(CHANNEL_BY_POLICY[KIRO.declaredOutputLength]).not.toBe("rejection")
    expect(CHANNEL_BY_POLICY[KIRO.declaredSampling]).toBe("rejection")

    // …and the declarations really do differ across upstreams, which is what the fourth clause
    // observes (Requirement 10.10). Restated: this used to assert that both non-Kiro rows differ
    // from Kiro's cell and are silent, which encoded `codex.outputLength: "native"`. Spike §11.2
    // measured that cell `degrade`, so Codex now agrees with Kiro on this one cell while Copilot is
    // the only silent row left. The divergence claim is kept by naming what still diverges — at
    // least one row silent, at least one row not — instead of by asserting the old partition.
    const channels = UPSTREAMS.map((upstream) => CHANNEL_BY_POLICY[upstream.declaredOutputLength])
    expect(new Set(channels).size).toBeGreaterThan(1)
    expect(channels).toContain("silent")
    for (const upstream of SILENT_OUTPUT_LENGTH_UPSTREAMS) {
      expect(upstream.declaredOutputLength).not.toBe(KIRO.declaredOutputLength)
      expect(CHANNEL_BY_POLICY[upstream.declaredOutputLength]).toBe("silent")
    }
    expect(SILENT_OUTPUT_LENGTH_UPSTREAMS.length).toBeGreaterThan(0)
  })

  /**
   * Anti-vacuity, generator side. The numeric space actually reaches every branch it claims to cover;
   * a generator that quietly produced only plausible token counts would leave the interesting half of
   * `typeof "number"` untested.
   */
  test("Feature: native-api-mode, Property 40: the generated limit space reaches every numeric shape a client can send", () => {
    const samples = fc.sample(outputLengthArb, 1000)

    const categories: Record<string, (value: number) => boolean> = {
      zero: (value) => value === 0,
      one: (value) => value === 1,
      positiveInteger: (value) => Number.isInteger(value) && value > 0,
      negative: (value) => value < 0,
      nonInteger: (value) => Number.isFinite(value) && !Number.isInteger(value),
      veryLarge: (value) => Number.isFinite(value) && Math.abs(value) > 1e15,
      notFinite: (value) => typeof value === "number" && !Number.isFinite(value),
      nan: (value) => Number.isNaN(value),
    }

    for (const [name, predicate] of Object.entries(categories)) {
      expect(samples.some(predicate), `the generator never produced a ${name} limit`).toBe(true)
    }
    // Every generated value is a limit as far as the detection is concerned.
    expect(samples.every((value) => typeof value === "number")).toBe(true)
  })

  /**
   * **The load-bearing clause.** For any canonical request whose only `sampling` sub-member is
   * `maxOutputTokens` — which is every ordinary Claude request, since `max_tokens` is mandatory in the
   * Claude Messages API — Kiro resolution produces **no rejection** and exactly one `outputLength`
   * reporting outcome.
   *
   * **Validates: Requirements 3.7, 10.9, 14.3**
   */
  test("Feature: native-api-mode, Property 40: an output-length limit alone is reported and never refused on Kiro", () => {
    fc.assert(
      fc.property(outputLengthArb, (maxOutputTokens) => {
        const decisions = KIRO.resolve(requestWithSampling({ maxOutputTokens }), { strict: false })

        // No 400, for this field or any other — the request carries nothing else.
        expect(decisions.firstRejection()).toBeUndefined()

        // Exactly one reporting outcome, and it is this feature's.
        expect(assertDeclaredOutputLengthOutcome(KIRO, { maxOutputTokens }, false)).toBe("notice")
        expect(decisions.notices()).toHaveLength(1)
        expect(decisions.notices()[0]!.feature).toBe(OUTPUT_LENGTH)

        // The limit did not leak into the `sampling` cell on the way — that fold is exactly what
        // returned a 400 for every Claude request before the split.
        expect(noticesFor(decisions, SAMPLING)).toEqual([])
        expect(decisions.resolvedFeatures().has(SAMPLING)).toBe(false)
        expect([...decisions.resolvedFeatures()]).toEqual([OUTPUT_LENGTH])
      }),
      { numRuns: 400 },
    )
  })

  /**
   * The second half of the same clause: the request reaches a built upstream payload, and that payload
   * carries no `inferenceConfig` key and no `maxTokens` key at any level — the limit is left off the
   * request rather than sent to be ignored (spike §4).
   *
   * Scoped to the output-length claim only. The broader Kiro payload shape is Property 13's subject
   * (task 15.5) and is not duplicated here.
   *
   * **Validates: Requirements 3.5, 14.3**
   */
  test("Feature: native-api-mode, Property 40: the Kiro payload built from an output-length request carries no limit field", () => {
    fc.assert(
      fc.property(outputLengthArb, (maxOutputTokens) => {
        const keys = kiroPayloadKeys(requestWithSampling({ maxOutputTokens }))

        expect(keys.has("inferenceconfig")).toBe(false)
        expect(keys.has("maxtokens")).toBe(false)
        expect(keys.has("maxoutputtokens")).toBe(false)

        // Anti-vacuity for the key walk itself: it really did see the payload. A walk that returned
        // an empty set would satisfy all three assertions above.
        expect(keys.has("conversationstate")).toBe(true)
        expect(keys.size).toBeGreaterThan(3)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * The second clause: `sampling` still rejects. Splitting the vocabulary must not have quietly
   * softened what happens to `temperature` and `topP`, for which this endpoint has no field at all.
   *
   * **Validates: Requirements 3.8, 10.5**
   */
  test("Feature: native-api-mode, Property 40: a temperature or top-p still produces a rejection naming sampling on Kiro", () => {
    fc.assert(
      fc.property(samplingControlsArb, (controls) => {
        const decisions = KIRO.resolve(requestWithSampling(controls), { strict: false })
        const rejection = decisions.firstRejection()

        expect(decisions.resolvedFeatures().has(SAMPLING)).toBe(true)
        expect(observedChannel(KIRO, decisions, SAMPLING)).toBe("rejection")
        expect(rejection?.feature).toBe(SAMPLING)
        // Requirements 10.3 and 14.5: the 400 names the feature and states an alternative.
        expect(rejection?.message).toContain(SAMPLING)
        expect(rejection?.message).toMatch(/Use .+ instead\./)

        // No limit was sent, so the other feature resolved for nobody.
        expect(decisions.resolvedFeatures().has(OUTPUT_LENGTH)).toBe(false)
        expect(noticesFor(decisions, OUTPUT_LENGTH)).toEqual([])
      }),
      { numRuns: 300 },
    )
  })

  /**
   * The third clause: a request carrying both produces both outcomes **independently**, and the
   * rejection is the `sampling` one.
   *
   * Independence is asserted by comparing against the limit-only request rather than merely counting:
   * the `outputLength` notice a client gets is the same notice whether or not the request also asked
   * for controls this endpoint refuses. That is what "one outcome per feature rather than one per
   * field" means, and it is the reading Property 22 defers to this file.
   *
   * **Validates: Requirements 3.7, 3.8, 10.5, 10.9**
   */
  test("Feature: native-api-mode, Property 40: a request carrying both gets both outcomes, and the rejection is the sampling one", () => {
    fc.assert(
      fc.property(outputLengthArb, samplingControlsArb, (maxOutputTokens, controls) => {
        const both = { ...controls, maxOutputTokens }
        const decisions = KIRO.resolve(requestWithSampling(both), { strict: false })

        // Both features reached resolution — neither is shadowed by the other's outcome.
        expect(decisions.resolvedFeatures().has(OUTPUT_LENGTH)).toBe(true)
        expect(decisions.resolvedFeatures().has(SAMPLING)).toBe(true)

        // Each on its own channel, per its own declaration.
        expect(observedChannel(KIRO, decisions, OUTPUT_LENGTH)).toBe("notice")
        expect(observedChannel(KIRO, decisions, SAMPLING)).toBe("rejection")

        // The rejection is the sampling one, and it is the only one.
        expect(decisions.firstRejection()?.feature).toBe(SAMPLING)

        // Independence: the reporting outcome is byte-identical to the one the limit produces alone.
        const alone = KIRO.resolve(requestWithSampling({ maxOutputTokens }), { strict: false })
        expect(noticesFor(decisions, OUTPUT_LENGTH)).toEqual(noticesFor(alone, OUTPUT_LENGTH))
        expect(noticesFor(decisions, OUTPUT_LENGTH)).toHaveLength(1)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * The fourth clause: the same output-length request is **silent on Copilot** and **reported on
   * Codex**, with `outputLength` present in `resolvedFeatures()` either way.
   *
   * Restated. It used to read "on Codex and Copilot the same request produces zero notices", with
   * both cells `native`. `.omc/research/kiro-wire-spike.md` §11.2 sent `max_output_tokens: 16` to the
   * Codex Responses endpoint and measured `400 {"detail":"Unsupported parameter: max_output_tokens"}`,
   * so that cell is `degrade` (§11.5) and Codex moved to the reporting side alongside Kiro. Copilot's
   * cell is untouched, still `native`, still unmeasured — a different endpoint, and no account to
   * probe it with.
   *
   * The clause is split rather than softened, and the split is the finding: two upstreams that
   * looked interchangeable on this cell are not. Both halves of each row still matter and neither
   * implies the other — the channel is the declared policy being honoured, and presence in the
   * resolved set is what keeps the field visible to the no-silent-drop set comparison (Requirement
   * 10.8) instead of being invisibly skipped because its outcome is quiet.
   *
   * `strict` is varied on both rows. On Copilot `native` does not escalate, so nothing about the open
   * strict question is decided there. On Codex a `degrade` **does** escalate, and that is asserted
   * through `assertDeclaredOutputLengthOutcome()`, which derives it from the declaration — the same
   * escalation Property 5 owns in general, not a decision taken here.
   *
   * **Validates: Requirement 10.10**
   */
  test("Feature: native-api-mode, Property 40: an output-length limit is silent on Copilot and reported on Codex, accounted for on both", () => {
    fc.assert(
      fc.property(fc.constantFrom(...UPSTREAMS_WITH_A_WIRE_TARGET), outputLengthArb, fc.boolean(), (upstream, maxOutputTokens, strict) => {
        const decisions = upstream.resolve(requestWithSampling({ maxOutputTokens }), { strict })

        // Accounted for on every row, whatever the channel.
        expect(decisions.resolvedFeatures().has(OUTPUT_LENGTH)).toBe(true)

        const observed = assertDeclaredOutputLengthOutcome(upstream, { maxOutputTokens }, strict)

        if (upstream.declaredOutputLength === "native") {
          // Zero notices for the feature, and zero for the whole request — it carries nothing else.
          expect(noticesFor(decisions, OUTPUT_LENGTH)).toEqual([])
          expect(decisions.notices()).toEqual([])
          expect(decisions.firstRejection()).toBeUndefined()
          expect(observed).toBe("silent")
        } else {
          // The measured Codex row: never silent, and the client is told which limit went missing.
          expect(observed).toBe(strict ? "rejection" : "notice")
          if (!strict) {
            expect(noticesFor(decisions, OUTPUT_LENGTH)).toHaveLength(1)
            expect(noticesFor(decisions, OUTPUT_LENGTH)[0]!.detail).toContain(String(maxOutputTokens))
            expect(decisions.firstRejection()).toBeUndefined()
          }
        }
      }),
      { numRuns: 300 },
    )
  })

  /**
   * The negative control across the whole table: a request with no limit resolves `outputLength` on
   * nobody. Without this, "one notice on Codex" and "one notice on Kiro" could both be passing for
   * reasons unrelated to the field — and silence about a field the client never sent is correct, while
   * silence about one they did is the drop this milestone removes.
   *
   * **Validates: Requirements 10.9, 10.10**
   */
  test("Feature: native-api-mode, Property 40: a request carrying no limit resolves outputLength on no upstream", () => {
    const withoutSampling = {
      model: "claude-sonnet-4-5",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      stream: false,
      passthrough: false,
      metadata: {},
    } as Canonical_Request

    for (const upstream of UPSTREAMS) {
      for (const strict of [false, true]) {
        for (const request of [withoutSampling, requestWithSampling({})]) {
          const decisions = upstream.resolve(request, { strict })
          expect(decisions.resolvedFeatures().has(OUTPUT_LENGTH)).toBe(false)
          expect(noticesFor(decisions, OUTPUT_LENGTH)).toEqual([])
        }
      }
    }

    // And the payload built from a request that never asked for a limit is equally free of the field,
    // so the payload clause above is not passing because of something specific to a limit request.
    const keys = kiroPayloadKeys(withoutSampling)
    expect(keys.has("inferenceconfig")).toBe(false)
    expect(keys.has("maxtokens")).toBe(false)
  })

  /**
   * Resolution is a pure function of the request: resolving the same request twice on the same
   * upstream yields the same notices and the same rejection, and resolving on one upstream does not
   * change what another observes. Both would break the per-upstream reading of every clause above.
   *
   * **Validates: Requirements 10.9, 10.10**
   */
  test("Feature: native-api-mode, Property 40: repeated resolution is stable and upstream-independent", () => {
    fc.assert(
      fc.property(outputLengthArb, (maxOutputTokens) => {
        const request = requestWithSampling({ maxOutputTokens })

        const kiroFirst = KIRO.resolve(request, { strict: false })
        for (const upstream of UPSTREAMS_WITH_A_WIRE_TARGET) upstream.resolve(request, { strict: false })
        const kiroSecond = KIRO.resolve(request, { strict: false })

        expect(kiroSecond.notices()).toEqual(kiroFirst.notices())
        expect(kiroSecond.firstRejection()).toEqual(kiroFirst.firstRejection())
        expect([...kiroSecond.resolvedFeatures()]).toEqual([...kiroFirst.resolvedFeatures()])
      }),
      { numRuns: 200 },
    )
  })
})
