// Feature: native-api-mode, Property 22: Sampling policy divergence is observable per upstream.
//
// For any temperature value, a request to Kiro produces exactly one sampling outcome matching Kiro's
// declared policy and a request to Codex produces zero sampling notices.
//
// **Validates: Requirements 10.5, 10.6**
//
// ## Why the resolvers and not a provider call
//
// Both halves are pure functions of `(request, { strict })`: `resolveKiroFeatures` and
// `resolveCodexFeatures` each read only their own `capabilities.ts` and return a `FeatureDecisions`.
// So the divergence is observable with no client, no auth, and no network — which is what makes it
// generative over a temperature space rather than one fixture. The delivery paths (a notice on a
// collected response, a notice event ahead of stream content, a 400 before the upstream is called)
// are example-covered in `test/upstream/kiro/features.test.ts` and `test/upstream/features.test.ts`,
// and the cross-upstream set comparison of Requirement 10.8 is the matrix walk (task 10.6).
//
// ## How "matching its declared policy" is asserted without restating the policy
//
// Hardcoding `expect(rejection.feature).toBe("sampling")` for Kiro would pass just as well if the
// declaration and the code were changed together in the wrong direction. So the expectation is
// derived: {@link CHANNEL_BY_POLICY} restates the *matrix semantics* — which policy reports, which
// fails, which is silent — and the concrete policy is read from each provider's own declaration. A
// cell flipped in `capabilities.ts` therefore changes the expectation and the observation together,
// and the clauses that pin the divergence itself (Kiro is not silent, Codex is) fail if the flip
// erased the divergence. The recorded value of Kiro's cell is pinned separately, per cell, in
// `test/upstream/capabilities.property.test.ts` (Property 1).
//
// ## Input space
//
// `temperature` is `number` in the canonical contract, so the generated space is numbers — including
// the ones a client can actually send that are not "a probability between 0 and 1": negative, out of
// range, subnormal, and the three non-finite values, all of which are `typeof "number"` and therefore
// all of which are a sampling request. A non-numeric temperature is off-contract and is not generated;
// it never reaches an upstream as a number, so an assertion about it would describe the inbound
// mapper's job, not this one's.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_FeatureNotice, Canonical_Request } from "../../src/core/canonical"
import type { FeatureDecisions } from "../../src/core/feature-decisions"
import type { FeaturePolicy } from "../../src/core/provider-capabilities"
import { FEATURE_POLICIES } from "../../src/core/provider-capabilities"
import { CODEX_CAPABILITIES } from "../../src/upstream/codex/capabilities"
import { resolveCodexFeatures } from "../../src/upstream/codex/features"
import { COPILOT_CAPABILITIES } from "../../src/upstream/copilot/capabilities"
import { resolveCopilotFeatures } from "../../src/upstream/copilot/features"
import { KIRO_CAPABILITIES } from "../../src/upstream/kiro/capabilities"
import { resolveKiroFeatures } from "../../src/upstream/kiro/features"

// ---------------------------------------------------------------------------------------------
// The upstream table
// ---------------------------------------------------------------------------------------------

interface SamplingUpstream {
  /** Directory name, used in failure messages. */
  name: string
  /** The `sampling` cell, read from this provider's own declaration — never restated here. */
  declared: FeaturePolicy
  /**
   * The `outputLength` cell, read the same way.
   *
   * Its own field because task 12b made it its own feature with its own policy: on Kiro the two
   * diverge (`reject` versus `degrade`), so a single `declared` could no longer stand for both
   * without restating one of them here.
   */
  declaredOutputLength: FeaturePolicy
  /** This provider's resolver, a pure function of the request. */
  resolve: (request: Canonical_Request, options?: { strict?: boolean }) => FeatureDecisions
}

/**
 * Every upstream that declares a `sampling` policy.
 *
 * Property 22 names Kiro and Codex; Copilot is the same table row and rides along, which is what
 * makes the divergence a property of the matrix rather than a fact about two providers. A fourth
 * upstream is one more row and no new test body.
 */
const UPSTREAMS: readonly SamplingUpstream[] = [
  { name: "kiro", declared: KIRO_CAPABILITIES.features.sampling, declaredOutputLength: KIRO_CAPABILITIES.features.outputLength, resolve: resolveKiroFeatures },
  { name: "codex", declared: CODEX_CAPABILITIES.features.sampling, declaredOutputLength: CODEX_CAPABILITIES.features.outputLength, resolve: resolveCodexFeatures },
  { name: "copilot", declared: COPILOT_CAPABILITIES.features.sampling, declaredOutputLength: COPILOT_CAPABILITIES.features.outputLength, resolve: resolveCopilotFeatures },
]

const KIRO = UPSTREAMS[0]!
const CODEX = UPSTREAMS[1]!

/**
 * What a caller can observe about one feature after resolution: nothing, one notice, or a failed
 * request. Deliberately the same vocabulary as `test/core/feature-policy.property.test.ts`, because
 * this property is that one observed per upstream.
 */
type OutcomeChannel = "silent" | "notice" | "rejection"

/**
 * The matrix semantics, restated independently of `src/core/feature-policy.ts`.
 *
 * This is the expectation side of the property, so it must not be computed by the code under test —
 * deriving it from `resolveFeature()` would make the assertion "the resolver agrees with itself".
 * `satisfies` keeps it total: a fifth `FeaturePolicy` member fails to compile here.
 */
const CHANNEL_BY_POLICY = {
  native: "silent",
  emulate: "notice",
  degrade: "notice",
  reject: "rejection",
} as const satisfies Record<FeaturePolicy, OutcomeChannel>

/** Under strict, the one reporting policy that escalates is `degrade` (Requirement 11.1). */
function expectedChannel(policy: FeaturePolicy, strict: boolean): OutcomeChannel {
  if (strict && policy === "degrade") return "rejection"
  return CHANNEL_BY_POLICY[policy]
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/**
 * The canonical `sampling` member task 14 adds, attached through a cast.
 *
 * The same forward-compatible idiom the resolvers use locally (`FutureCanonicalRequestMembers` in
 * each provider's `features.ts`) and the same one `test/upstream/features.test.ts` and
 * `test/upstream/kiro/features.test.ts` already use: the members are read defensively today, so a
 * test that widened `Canonical_Request` in core to reach them would be testing a different contract
 * than the one shipping. `stopSequences` is deliberately absent from this view — it is a different
 * `ProviderFeature` with its own cell, and including it would put a second outcome in the request.
 *
 * `maxOutputTokens` is also a different `ProviderFeature` since task 12b split `outputLength` out,
 * and it is kept here on purpose rather than removed with `stopSequences`: it is a sub-member of the
 * same canonical `sampling` object, so a client sending it alongside a temperature is the ordinary
 * case, and the file's claim is precisely that one such request yields **one report per feature**
 * rather than one per knob. Every observation below is scoped to the feature it is about, so the
 * second outcome is accounted for by name instead of leaking into the `sampling` clauses.
 */
interface SamplingControls {
  temperature?: number
  topP?: number
  maxOutputTokens?: number
}

function requestWithSampling(sampling: SamplingControls): Canonical_Request {
  return {
    model: "claude-sonnet-4-5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
    sampling,
  } as Canonical_Request
}

/**
 * Temperatures a client can actually send. All are `typeof "number"`, so all are a sampling request.
 *
 * The named constants are the interesting boundaries: both zeroes (`-0` is a distinct value with the
 * same `typeof`), the documented range ends, out-of-range values, the subnormal and maximum
 * magnitudes, and the three non-finite values. `fc.double()` fills in the rest of the space.
 */
const TEMPERATURE_EDGE_CASES: readonly number[] = [
  0,
  -0,
  1,
  2,
  0.7,
  0.000001,
  -1,
  -273.15,
  1e300,
  Number.EPSILON,
  Number.MIN_VALUE,
  Number.MAX_VALUE,
  Number.MAX_SAFE_INTEGER,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
]

const temperatureArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...TEMPERATURE_EDGE_CASES) },
  { weight: 3, arbitrary: fc.double() },
  { weight: 2, arbitrary: fc.integer({ min: -1000, max: 1000 }) },
  { weight: 1, arbitrary: fc.float() },
)

/**
 * A request carrying a temperature, optionally with the other two controls that map to the same
 * `sampling` feature.
 *
 * The companions matter: three requested controls must still produce *one* sampling outcome, not
 * three. That is the "exactly one" half of the property, and it would be untested by a request
 * carrying a temperature alone.
 */
const samplingArb: fc.Arbitrary<SamplingControls> = fc.record(
  {
    temperature: temperatureArb,
    topP: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
    maxOutputTokens: fc.option(fc.integer({ min: 0, max: 200_000 }), { nil: undefined }),
  },
  { requiredKeys: ["temperature"] },
)

// ---------------------------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------------------------

const SAMPLING = "sampling" as const
const OUTPUT_LENGTH = "outputLength" as const

function samplingNotices(decisions: FeatureDecisions): Canonical_FeatureNotice[] {
  return decisions.notices().filter((notice) => notice.feature === SAMPLING)
}

/** The same projection for the feature task 12b split out, so the two are read apart. */
function outputLengthNotices(decisions: FeatureDecisions): Canonical_FeatureNotice[] {
  return decisions.notices().filter((notice) => notice.feature === OUTPUT_LENGTH)
}

/**
 * The channel this upstream actually used for `sampling`, plus the exclusivity check.
 *
 * Throws rather than returning a list when more than one channel is used: two channels for one
 * feature is the fifth-outcome failure Requirement 29.2 forbids, and it should name the upstream.
 */
function observedChannel(upstream: SamplingUpstream, decisions: FeatureDecisions): OutcomeChannel {
  const notices = samplingNotices(decisions)
  const rejection = decisions.firstRejection()
  const rejected = rejection?.feature === SAMPLING

  const channels: OutcomeChannel[] = []
  if (notices.length > 0) channels.push("notice")
  if (rejected) channels.push("rejection")
  if (channels.length === 0) channels.push("silent")

  if (channels.length !== 1) {
    throw new Error(`${upstream.name} used ${channels.length} channels for sampling (${channels.join(", ")})`)
  }
  if (notices.length > 1) {
    throw new Error(`${upstream.name} emitted ${notices.length} sampling notices for one request; exactly one outcome means exactly one notice`)
  }
  return channels[0]!
}

/**
 * The whole per-upstream clause: the feature was covered, the channel is the one its declaration
 * implies, and the channel's payload is well formed.
 */
function assertDeclaredSamplingOutcome(upstream: SamplingUpstream, sampling: SamplingControls, strict: boolean): OutcomeChannel {
  const decisions = upstream.resolve(requestWithSampling(sampling), { strict })

  // Covered, whatever the outcome. A feature that never reached resolution is the silent drop
  // Requirement 10.1 exists to remove, and "zero notices" alone would not tell the two apart.
  expect(decisions.resolvedFeatures().has(SAMPLING)).toBe(true)

  const expected = expectedChannel(upstream.declared, strict)
  const observed = observedChannel(upstream, decisions)
  if (observed !== expected) {
    throw new Error(
      `${upstream.name} declares sampling=${upstream.declared} (strict=${strict}), which means a ${expected} outcome, ` +
        `but the resolver produced ${observed} for ${JSON.stringify(sampling)}`,
    )
  }

  const notices = samplingNotices(decisions)
  const rejection = decisions.firstRejection()

  if (observed === "notice") {
    expect(notices).toHaveLength(1)
    // The notice reports the declared policy, not some other reporting policy. Widened to `string`
    // for the comparison only: a notice policy is narrower than a `FeaturePolicy` by construction
    // (Requirement 8.6), and the assertion is that the two agree at runtime.
    const noticePolicy: string = notices[0]!.policy
    expect(noticePolicy).toBe(upstream.declared)
    expect(notices[0]!.detail.trim().length).toBeGreaterThan(0)
    expect(rejection).toBeUndefined()
  }

  if (observed === "rejection") {
    expect(notices).toEqual([])
    expect(rejection?.feature).toBe(SAMPLING)
    // Requirements 10.3 and 14.5: the 400 names the feature and states an alternative.
    expect(rejection?.message).toContain(SAMPLING)
    expect(rejection?.message).toMatch(/Use .+ instead\./)
  }

  if (observed === "silent") {
    // Requirement 10.6, on the upstreams that declare the cell native: zero notices, and zero
    // notices *for the whole request*. The whole-request half stays true after task 12b's split
    // because the only other feature this request can carry is `outputLength`, and every upstream
    // that declares `sampling` native declares that one native too — so it is asserted rather than
    // narrowed, and it starts failing if the two cells ever diverge on the same upstream.
    expect(notices).toEqual([])
    expect(decisions.notices()).toEqual([])
    expect(rejection).toBeUndefined()
  }

  return observed
}

// ---------------------------------------------------------------------------------------------
// Property 22
// ---------------------------------------------------------------------------------------------

describe("Sampling policy divergence", () => {
  /**
   * The declarations this property reads are real, differ between Kiro and Codex, and are drawn from
   * the closed policy set. Without this, every clause below could pass against two providers that
   * agree — the divergence would be unobservable and unnoticed.
   *
   * **Validates: Requirements 10.5, 10.6**
   */
  test("Feature: native-api-mode, Property 22: the sampling cell is declared, and Kiro's differs from Codex's", () => {
    for (const upstream of UPSTREAMS) {
      expect(FEATURE_POLICIES).toContain(upstream.declared)
    }

    // The divergence itself, at the declaration level.
    expect(KIRO.declared).not.toBe(CODEX.declared)
    // …and at the level of what a client observes: one reports, the other does not.
    expect(expectedChannel(KIRO.declared, false)).not.toBe("silent")
    expect(expectedChannel(CODEX.declared, false)).toBe("silent")
  })

  /**
   * Kiro: any temperature produces exactly one sampling outcome, and it is the one Kiro's declaration
   * implies (Requirement 10.5 — the value is not discarded without a trace).
   *
   * **Validates: Requirement 10.5**
   */
  test("Feature: native-api-mode, Property 22: any temperature produces exactly one sampling outcome on Kiro", () => {
    fc.assert(
      fc.property(samplingArb, fc.boolean(), (sampling, strict) => {
        const observed = assertDeclaredSamplingOutcome(KIRO, sampling, strict)
        // Whatever the declaration says, on this upstream it must not be silence — that is the
        // divergence this property exists to observe.
        expect(observed).not.toBe("silent")
      }),
      { numRuns: 400 },
    )
  })

  /**
   * Codex: any temperature produces zero sampling notices, strict or not, while still being recorded
   * as covered (Requirement 10.6).
   *
   * **Validates: Requirement 10.6**
   */
  test("Feature: native-api-mode, Property 22: any temperature produces zero sampling notices on Codex", () => {
    fc.assert(
      fc.property(samplingArb, fc.boolean(), (sampling, strict) => {
        const decisions = CODEX.resolve(requestWithSampling(sampling), { strict })

        expect(samplingNotices(decisions)).toEqual([])
        expect(decisions.notices()).toEqual([])
        expect(decisions.firstRejection()).toBeUndefined()
        expect(decisions.resolvedFeatures().has(SAMPLING)).toBe(true)

        expect(assertDeclaredSamplingOutcome(CODEX, sampling, strict)).toBe("silent")
      }),
      { numRuns: 400 },
    )
  })

  /**
   * Both halves of the divergence on one identical request: the same canonical `sampling` member,
   * resolved by each upstream in turn, lands on different channels.
   *
   * This is the property's headline and the reason it is one property rather than two: the request is
   * shared, so the only variable is the declaration.
   *
   * **Validates: Requirements 10.5, 10.6**
   */
  test("Feature: native-api-mode, Property 22: one identical request diverges by upstream", () => {
    fc.assert(
      fc.property(samplingArb, fc.boolean(), (sampling, strict) => {
        const kiro = assertDeclaredSamplingOutcome(KIRO, sampling, strict)
        const codex = assertDeclaredSamplingOutcome(CODEX, sampling, strict)

        expect(kiro).not.toBe(codex)
        expect(codex).toBe("silent")
      }),
      { numRuns: 400 },
    )
  })

  /**
   * Every upstream in the table, driven from its own declaration. Copilot is covered here rather than
   * by a clause of its own, and a fourth upstream needs no new code.
   *
   * **Validates: Requirements 10.5, 10.6**
   */
  test("Feature: native-api-mode, Property 22: every upstream matches its own declared sampling policy", () => {
    fc.assert(
      fc.property(fc.constantFrom(...UPSTREAMS), samplingArb, fc.boolean(), (upstream, sampling, strict) => {
        assertDeclaredSamplingOutcome(upstream, sampling, strict)
      }),
      { numRuns: 400 },
    )
  })

  /**
   * Three requested controls are still **one report per feature** — not one per knob, and not
   * several-deduplicated-to-one by accident of identical wording.
   *
   * The expectation is split the way task 12b split the resolution. `sampling` covers temperature
   * and top-p, so those two knobs share one outcome; the output length limit is `outputLength`, its
   * own feature with its own cell, so it carries an outcome of its own. Both halves are asserted
   * here rather than one of them dropped: a client tuning all three sees two reports at most, each
   * matching the declaration of the feature it belongs to, and each appearing exactly once.
   *
   * The Kiro row is what makes this a real split rather than a restatement — its two cells diverge
   * (`reject` for the controls, `degrade` for the limit), so a resolver that folded the limit back
   * into `sampling` would fail the `outputLength` clauses here.
   *
   * **Validates: Requirements 10.5, 10.6**
   */
  test("Feature: native-api-mode, Property 22: several generation controls still produce one outcome per feature", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...UPSTREAMS),
        temperatureArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 200_000 }),
        fc.boolean(),
        (upstream, temperature, topP, maxOutputTokens, strict) => {
          const decisions = upstream.resolve(requestWithSampling({ temperature, topP, maxOutputTokens }), { strict })

          // The two sampling controls: one outcome between them, on the declared channel.
          expect(samplingNotices(decisions).length).toBeLessThanOrEqual(1)
          expect(observedChannel(upstream, decisions)).toBe(expectedChannel(upstream.declared, strict))
          // One resolution, so one entry in the covered set.
          expect([...decisions.resolvedFeatures()].filter((feature) => feature === SAMPLING)).toEqual([SAMPLING])

          // The limit: its own resolution, its own single report, on its own declared channel.
          expect([...decisions.resolvedFeatures()].filter((feature) => feature === OUTPUT_LENGTH)).toEqual([OUTPUT_LENGTH])
          const limitNotices = outputLengthNotices(decisions)
          expect(limitNotices.length).toBeLessThanOrEqual(1)
          if (expectedChannel(upstream.declaredOutputLength, strict) === "notice") {
            expect(limitNotices).toHaveLength(1)
            const noticePolicy: string = limitNotices[0]!.policy
            expect(noticePolicy).toBe(upstream.declaredOutputLength)
            expect(limitNotices[0]!.detail.trim().length).toBeGreaterThan(0)
          } else {
            // `native` is silent and, under strict, a `degrade` becomes a rejection instead of a
            // notice — either way there is no notice to find, and no second one either.
            expect(limitNotices).toEqual([])
          }
        },
      ),
      { numRuns: 300 },
    )
  })

  /**
   * The negative control: a request with no `sampling` member resolves the feature on nobody, so
   * "zero notices on Codex" is not passing for the trivial reason that nothing was ever detected.
   * Silence about a field the client never sent is correct; silence about one they did is the drop
   * this milestone removes.
   *
   * **Validates: Requirements 10.5, 10.6**
   */
  test("Feature: native-api-mode, Property 22: a request carrying no generation controls resolves sampling on no upstream", () => {
    const bare = {
      model: "claude-sonnet-4-5",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      stream: false,
      passthrough: false,
      metadata: {},
    } as Canonical_Request

    for (const upstream of UPSTREAMS) {
      for (const strict of [false, true]) {
        const decisions = upstream.resolve(bare, { strict })
        expect(decisions.resolvedFeatures().has(SAMPLING)).toBe(false)
        expect(samplingNotices(decisions)).toEqual([])
        // The same control for the feature task 12b split out: absent field, no resolution.
        expect(decisions.resolvedFeatures().has(OUTPUT_LENGTH)).toBe(false)
        expect(outputLengthNotices(decisions)).toEqual([])
        expect(decisions.firstRejection()).toBeUndefined()
      }
    }
  })

  /**
   * An empty `sampling` object is not a request for anything: no control is set, so there is nothing
   * to honor, degrade, or reject. Recorded because it is the one shape where "the member is present"
   * and "the client asked for a control" come apart, and reporting on it would be a notice about a
   * non-event.
   *
   * **Validates: Requirements 10.5, 10.6**
   */
  test("Feature: native-api-mode, Property 22: an empty sampling object resolves sampling on no upstream", () => {
    for (const upstream of UPSTREAMS) {
      const decisions = upstream.resolve(requestWithSampling({}), { strict: false })
      expect(decisions.resolvedFeatures().has(SAMPLING)).toBe(false)
      expect(samplingNotices(decisions)).toEqual([])
      expect(decisions.resolvedFeatures().has(OUTPUT_LENGTH)).toBe(false)
      expect(outputLengthNotices(decisions)).toEqual([])
    }
  })

  /**
   * Resolution is a pure function of the request: resolving the same request twice on the same
   * upstream yields the same notices and the same rejection, and resolving on one upstream does not
   * change what another observes. Both would break the per-upstream reading of the property.
   *
   * **Validates: Requirements 10.5, 10.6**
   */
  test("Feature: native-api-mode, Property 22: repeated resolution is stable and upstream-independent", () => {
    fc.assert(
      fc.property(samplingArb, (sampling) => {
        const request = requestWithSampling(sampling)

        const kiroFirst = KIRO.resolve(request, { strict: false })
        const codexOnly = CODEX.resolve(request, { strict: false })
        const kiroSecond = KIRO.resolve(request, { strict: false })

        expect(kiroSecond.notices()).toEqual(kiroFirst.notices())
        expect(kiroSecond.firstRejection()).toEqual(kiroFirst.firstRejection())
        expect([...kiroSecond.resolvedFeatures()]).toEqual([...kiroFirst.resolvedFeatures()])
        expect(samplingNotices(codexOnly)).toEqual([])
      }),
      { numRuns: 200 },
    )
  })
})
