// Feature: native-api-mode, Property 5: Strict mode escalates degrade and nothing else.
//
// For any resolution input, the outcome with `strict` set equals the outcome with `strict` unset in
// every case except `degrade`, where the kind becomes `reject`; for any environment value other than
// the documented enabling values, `strict` resolves to disabled.
//
// **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 16.5**
//
// ## The two halves, and where they join
//
// The property names two claims about two modules, and they only mean something together:
//
//  - **The escalation half** is about `resolveFeature()` (`src/core/feature-policy.ts`), the one
//    function in the repository that interprets `strict` (design decision D3). It receives a plain
//    boolean, so it is testable without an environment at all.
//  - **The environment half** is about `readNativeFlags()` / `isEnablingValue()`
//    (`src/app/native-flags.ts`), the one module that reads `NATIVE_STRICT`.
//
// Either half alone leaves a hole: a resolver that escalated correctly from a boolean that no
// environment value could ever set would satisfy the first, and a reader that resolved `"maybe"` to
// `false` while the resolver escalated on `emulate` would satisfy the second. The
// `describe("strict resolves from the environment and escalates from there")` block below is the
// join — an environment value in, an escalated or unescalated outcome out — so the composition is
// asserted rather than inferred from its two ends.
//
// ## What this adds over the neighbouring files
//
//  - `test/core/feature-policy.property.test.ts` (Property 4) asserts what holds for *both* values
//    of `strict` and deliberately never that one value differs from the other. This file is the
//    difference, and it is the only file that asserts it generatively.
//  - `test/app/native-flags.test.ts` covers the enabling-value set at the example level, over a
//    hand-written 14-value disabling list. This file is the generative version: arbitrary strings,
//    every casing of every enabling value, whitespace padding on all sides, and confusable unicode.
//    The **no-trim** behaviour is asserted as a deliberate clause, not worked around — 11.1 records
//    it as a choice matching `kiroDebugOnErrorEnabled()`, so `" 1"` disabling is the contract.
//  - `test/upstream/kiro/features.test.ts` has one example-level escalation test. `test/app/
//    native-strict-wiring.test.ts` proves bootstrap threads the boolean into a Codex provider. This
//    file adds the closed grid, the multi-feature `FeatureDecisions` relation, and the Kiro unit
//    pair Requirement 11.5 asks for.
//
// This file imports `src/upstream/kiro/` and `src/inbound/claude/` for that unit pair, which task
// 11.3 places here by name. `.kiro/steering/provider-architecture-coding-rules.md` constrains
// dependency direction inside `src/`; `test/architecture.property.test.ts` is what asserts those
// invariants, and nothing here changes them.
//
// ## Requirement 11.5's literal wording is not achievable, and this is not a fudge
//
// 11.5 asks for "one identical Kiro request carrying `temperature`" yielding 400 with the flag set
// and 200-plus-notice with it unset. Kiro declares `sampling: "reject"`
// (`src/upstream/kiro/capabilities.ts`, cited to spike §4: `inferenceConfig` returns 200 and is
// discarded). A Kiro request carrying `temperature` is therefore a **rejection regardless of
// strict** — both branches are 400 — so `temperature` cannot demonstrate escalation on this
// upstream. Raising or lowering that cell to make the sentence literally true would be editing a
// measured declaration to fit a test, which task 11.3 forbids.
//
// Both halves of the intent are covered instead, and the split is explicit:
//
//  1. `describe("the Kiro unit pair, on a genuinely degraded feature")` is the 400-versus-
//     200-plus-notice pair, on `toolChoiceForced` and `strictToolSchema` — the two Kiro cells that
//     genuinely declare `degrade` and are resolved from the request today. This is the escalation
//     Requirement 11.5 exists to pin down.
//  2. `describe("the Kiro request carrying temperature, as Requirement 11.5 words it")` runs the
//     literal request and asserts what it actually does: 400 both ways, byte-identical message.
//     That is the "and nothing else" half of Property 5 on a real upstream — a declared `reject` is
//     not escalated because there is nothing above it to escalate to.
//
// ## Requirement 16.5 at this task's depth
//
// 16.5 says a client effort value outside the model enum returns 400 under strict. The Effort_
// Resolver that produces that substitution lands at task 22 (M15); it does not exist yet, so this
// file cannot call it. What it can assert — and what 16.5 rests on entirely — is the escalation the
// resolver will inherit: the feature that carries effort substitution is `thinkingBudget`, both
// measured upstreams declare it `degrade`, and a `degrade` under strict is a rejection naming that
// feature. That clause is `"a declared thinkingBudget degrade escalates on every upstream that
// declares it"` below. The resolver-level assertion belongs to task 22 and is called out there.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { isEnablingValue, readNativeFlags } from "../../src/app/native-flags"
import type { Canonical_FeatureNotice, Canonical_Request } from "../../src/core/canonical"
import { FeatureDecisions } from "../../src/core/feature-decisions"
import type { FeatureOutcome, FeatureResolutionInput } from "../../src/core/feature-policy"
import { featureOutcomeNotice, isFeatureRejection, resolveFeature } from "../../src/core/feature-policy"
import type { FeaturePolicy, ProviderFeature } from "../../src/core/provider-capabilities"
import { FEATURE_POLICIES, PROVIDER_FEATURES } from "../../src/core/provider-capabilities"
import { canonicalResponseToClaudeMessage } from "../../src/inbound/claude/response"
import type { ClaudeMessagesRequest } from "../../src/inbound/types"
import { CODEX_CAPABILITIES } from "../../src/upstream/codex/capabilities"
import { COPILOT_CAPABILITIES } from "../../src/upstream/copilot/capabilities"
import { Kiro_Auth_Manager, Kiro_Client, Kiro_Upstream_Provider } from "../../src/upstream/kiro"
import { KIRO_CAPABILITIES } from "../../src/upstream/kiro/capabilities"

// ---------------------------------------------------------------------------------------------
// Half A — generators over the resolution input, with `strict` deliberately excluded
// ---------------------------------------------------------------------------------------------

/**
 * A resolution input minus the one dimension under test.
 *
 * `strict` is excluded from every generator in this half on purpose: the property is a statement
 * about a *pair* of resolutions of the same input, so generating `strict` alongside the rest would
 * produce one resolution and leave nothing to compare it against.
 */
type StrictAgnosticInput = Omit<FeatureResolutionInput, "strict">

const PROSE_CHARS = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_,;:()="]

function proseArb(maxLength: number) {
  return fc.array(fc.constantFrom(...PROSE_CHARS), { minLength: 1, maxLength }).map((chars) => chars.join(""))
}

/** Text that trims to nothing, so both fallback paths in the resolver are exercised on every arm. */
const BLANK_TEXTS = ["", " ", "   ", "\t", "\n", " \t \n ", "\u00a0"] as const

/**
 * Text a client could actually get into a provider's prose. Included because escalation must be
 * text-independent: the strict rejection is built from the same `detail` and `alternative` as the
 * unstrict notice, so a quote, a newline, or the message template's own wording must not make the
 * two paths diverge in some way other than the kind.
 */
const adversarialTextArb = fc.oneof(
  fc.string({ maxLength: 120 }),
  fc.constantFrom(
    '"',
    "`",
    "${injected}",
    "Use nothing instead.",
    "does not support sampling: ",
    "line one\nline two",
    "температура",
    "🙂",
    "a".repeat(600),
    ...BLANK_TEXTS,
  ),
)

const featureArb = fc.constantFrom(...PROVIDER_FEATURES)
const policyArb = fc.constantFrom(...FEATURE_POLICIES)

function strictAgnosticInputArb(text: fc.Arbitrary<string>): fc.Arbitrary<StrictAgnosticInput> {
  return fc.record({ feature: featureArb, policy: policyArb, detail: text, alternative: text })
}

const proseInputArb = strictAgnosticInputArb(fc.oneof(proseArb(70), fc.constantFrom(...BLANK_TEXTS)))
const adversarialInputArb = strictAgnosticInputArb(adversarialTextArb)

/**
 * A policy value the type system says cannot exist — a re-cased member, a misspelling, a blank, or a
 * value that crossed a JSON boundary. Strict must not change what happens to one: it already
 * rejects, and there is no fifth outcome above a rejection to escalate into.
 */
const offContractPolicyArb = fc.oneof(
  fc.constantFrom("Degrade", "DEGRADE", " degrade", "degrade ", "REJECT", "Native", "sideways", "", "degrade|reject"),
  fc.constantFrom(undefined, null, 0, 1, true, false, [], {}, { policy: "degrade" }),
) as fc.Arbitrary<FeaturePolicy>

/** The four text shapes the closed grid pairs with every `(feature, policy)`: two real, two blank. */
const GRID_TEXTS: ReadonlyArray<{ detail: string; alternative: string }> = [
  {
    detail: "temperature was not sent upstream because the endpoint has no field for it",
    alternative: "an upstream that honours generation controls, or omit them",
  },
  { detail: "d", alternative: "a" },
  { detail: "   ", alternative: "" },
  { detail: "", alternative: " \t " },
]

/** Every `(feature, policy, text)` triple: 12 × 4 × 4 = 192 points, each resolved twice. */
const CLOSED_GRID: readonly StrictAgnosticInput[] = PROVIDER_FEATURES.flatMap((feature) =>
  FEATURE_POLICIES.flatMap((policy) => GRID_TEXTS.map(({ detail, alternative }) => ({ feature, policy, detail, alternative }))),
)

function describeInput(input: StrictAgnosticInput): string {
  return `feature=${input.feature} policy=${JSON.stringify(input.policy)} detail=${JSON.stringify(input.detail)} alternative=${JSON.stringify(input.alternative)}`
}

/** The same input resolved both ways. The unit of this whole half. */
function resolveBothWays(input: StrictAgnosticInput): { unstrict: FeatureOutcome; strict: FeatureOutcome } {
  return {
    unstrict: resolveFeature({ ...input, strict: false }),
    strict: resolveFeature({ ...input, strict: true }),
  }
}

/**
 * The property, as one reusable check.
 *
 * Two clauses, and the second is the stronger reading of the property text. "The outcome with
 * `strict` set equals the outcome with `strict` unset" is asserted as **deep equality of the whole
 * outcome**, not equality of its `kind`: a resolver that kept the kind but rewrote the notice detail
 * under strict would pass a kind-only check and would still be escalating something the property
 * says it must not touch.
 *
 * For `degrade`, escalation is asserted to land exactly on the outcome a **declared** `reject`
 * produces for the same input. That is what makes "the kind becomes `reject`" a complete statement:
 * strict does not invent a second rejection shape, a different message template, or an extra field —
 * it routes through the one rejection path the module already has.
 */
function assertEscalatesDegradeAndNothingElse(input: StrictAgnosticInput): void {
  const { unstrict, strict } = resolveBothWays(input)

  if (input.policy !== "degrade") {
    // Requirement 11.3 for `emulate`, and the same guarantee for `native` and `reject`.
    if (JSON.stringify(strict) !== JSON.stringify(unstrict)) {
      throw new Error(`strict changed a non-degrade outcome for ${describeInput(input)}: ${JSON.stringify(unstrict)} → ${JSON.stringify(strict)}`)
    }
    expect(strict).toEqual(unstrict)
    return
  }

  // Requirement 11.2: unset means the degrade notice, and a 200 carries it.
  expect(unstrict.kind).toBe("degrade")
  // Requirement 11.1: set means a rejection instead.
  expect(strict.kind).toBe("reject")
  expect(isFeatureRejection(strict)).toBe(true)
  expect(isFeatureRejection(unstrict)).toBe(false)
  // The escalation is the module's own rejection, not a parallel one.
  expect(strict).toEqual(resolveFeature({ ...input, policy: "reject", strict: false }))
  if (isFeatureRejection(strict)) expect(strict.message).toContain(input.feature)
}

// ---------------------------------------------------------------------------------------------
// Half A — the escalation property
// ---------------------------------------------------------------------------------------------

describe("Strict mode escalates degrade and nothing else", () => {
  /**
   * The closed grid: every `ProviderFeature` against every `FeaturePolicy` against four text shapes,
   * each point resolved with `strict` both ways. Four of the input's five dimensions are closed, so
   * enumerating them is strictly stronger than sampling them.
   *
   * **Validates: Requirements 11.1, 11.2, 11.3**
   */
  test("Feature: native-api-mode, Property 5: every point of the closed grid escalates only when it degrades", () => {
    // Anti-vacuity: a grid that collapsed to nothing would pass every clause below.
    expect(CLOSED_GRID.length).toBe(PROVIDER_FEATURES.length * FEATURE_POLICIES.length * GRID_TEXTS.length)
    expect(CLOSED_GRID.length).toBe(192)

    for (const input of CLOSED_GRID) assertEscalatesDegradeAndNothingElse(input)

    fc.assert(
      fc.property(fc.constantFrom(...CLOSED_GRID), (input) => {
        assertEscalatesDegradeAndNothingElse(input)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * The set of points where strict makes a difference is exactly the `degrade` column — counted, not
   * spot-checked. Without this, a resolver that ignored `strict` entirely would satisfy the equality
   * clause above for all 192 points and fail nothing.
   *
   * **Validates: Requirements 11.1, 11.3**
   */
  test("Feature: native-api-mode, Property 5: strict changes exactly the degrade column of the grid", () => {
    const differing = CLOSED_GRID.filter((input) => {
      const { unstrict, strict } = resolveBothWays(input)
      return JSON.stringify(unstrict) !== JSON.stringify(strict)
    })

    expect(new Set(differing.map((input) => input.policy))).toEqual(new Set(["degrade"]))
    // One point per (feature, text) shape, and no more: 12 × 4.
    expect(differing.length).toBe(PROVIDER_FEATURES.length * GRID_TEXTS.length)
    // Every feature reaches escalation, so the count is not concentrated in one cell.
    expect(new Set(differing.map((input) => input.feature))).toEqual(new Set(PROVIDER_FEATURES))
  })

  /**
   * The same property over generated prose, including blank detail and blank alternative.
   *
   * **Validates: Requirements 11.1, 11.2, 11.3**
   */
  test("Feature: native-api-mode, Property 5: generated prose inputs escalate only when they degrade", () => {
    fc.assert(
      fc.property(proseInputArb, (input) => {
        assertEscalatesDegradeAndNothingElse(input)
      }),
      { numRuns: 400 },
    )
  })

  /**
   * The same over adversarial text: quotes, newlines, template-literal syntax, non-Latin script, the
   * message template's own wording, and a 600-character detail. Escalation is a function of the
   * policy alone, so no text may move the boundary.
   *
   * **Validates: Requirements 11.1, 11.2, 11.3**
   */
  test("Feature: native-api-mode, Property 5: adversarial notice text does not move the escalation boundary", () => {
    fc.assert(
      fc.property(adversarialInputArb, (input) => {
        assertEscalatesDegradeAndNothingElse(input)
      }),
      { numRuns: 400 },
    )
  })

  /**
   * `emulate` is never escalated, stated on its own rather than left implicit in the equality clause.
   * Requirement 11.3 is the one acceptance criterion in this requirement that names a policy other
   * than `degrade`, and emulation preserving client semantics is the reason it exists: there is
   * nothing to fail loudly about.
   *
   * **Validates: Requirement 11.3**
   */
  test("Feature: native-api-mode, Property 5: an emulate outcome keeps its notice under strict", () => {
    fc.assert(
      fc.property(featureArb, fc.oneof(proseArb(60), fc.constantFrom(...BLANK_TEXTS)), (feature, text) => {
        const input: StrictAgnosticInput = { feature, policy: "emulate", detail: text, alternative: text }
        const { unstrict, strict } = resolveBothWays(input)

        expect(strict.kind).toBe("emulate")
        expect(strict).toEqual(unstrict)
        expect(isFeatureRejection(strict)).toBe(false)
        // The notice a 200 carries is unchanged, detail included.
        expect(featureOutcomeNotice(strict)).toBeDefined()
        expect(featureOutcomeNotice(strict)).toEqual(featureOutcomeNotice(unstrict)!)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * A `native` forward stays silent under strict — no notice appears, no rejection is invented.
   *
   * **Validates: Requirements 11.1, 11.3**
   */
  test("Feature: native-api-mode, Property 5: a native outcome stays silent under strict", () => {
    fc.assert(
      fc.property(featureArb, adversarialTextArb, (feature, text) => {
        const { unstrict, strict } = resolveBothWays({ feature, policy: "native", detail: text, alternative: text })

        expect(strict).toEqual({ kind: "native" })
        expect(strict).toEqual(unstrict)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * A policy the type system says cannot exist already rejects, and strict leaves it exactly as it
   * was — same kind, same message. Escalation has one source, the `degrade` case, so a value that
   * reaches the resolver's runtime guard cannot pick up a second one.
   *
   * **Validates: Requirements 11.1, 11.3**
   */
  test("Feature: native-api-mode, Property 5: an off-contract policy is unaffected by strict", () => {
    fc.assert(
      fc.property(featureArb, offContractPolicyArb, proseArb(40), proseArb(30), (feature, policy, detail, alternative) => {
        const { unstrict, strict } = resolveBothWays({ feature, policy, detail, alternative })

        expect(isFeatureRejection(unstrict)).toBe(true)
        expect(strict).toEqual(unstrict)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * Escalation is idempotent and order-free: resolving the same input under strict twice, or
   * interleaved with unstrict resolutions, gives the same answer every time. A resolver that cached
   * the first `strict` it saw would make the property depend on call order.
   *
   * **Validates: Requirement 11.1**
   */
  test("Feature: native-api-mode, Property 5: interleaving strict and unstrict resolutions changes neither", () => {
    fc.assert(
      fc.property(proseInputArb, fc.array(fc.boolean(), { minLength: 2, maxLength: 8 }), (input, order) => {
        const expected = resolveBothWays(input)
        for (const strict of order) {
          expect(resolveFeature({ ...input, strict })).toEqual(strict ? expected.strict : expected.unstrict)
        }
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Half A, at the per-request level
// ---------------------------------------------------------------------------------------------

/**
 * One request's worth of resolutions, one entry per feature.
 *
 * Features are unique on purpose. `FeatureDecisions` dedupes notices by `(feature, detail)`, so two
 * entries sharing that pair with different policies would make the strict and unstrict notice lists
 * differ for a reason that has nothing to do with escalation — the first entry's notice would be
 * absent under strict, letting a later duplicate through the dedup gate that the unstrict run
 * closed. One resolve per feature is also how every upstream actually calls this
 * (`resolveKiroFeatures()` resolves each of its seven at most once), so the restricted space is the
 * real one rather than a convenience.
 */
interface PlannedResolution {
  feature: ProviderFeature
  policy: FeaturePolicy
  detail: string
  alternative: string
}

const plannedResolutionsArb: fc.Arbitrary<PlannedResolution[]> = fc
  .uniqueArray(featureArb, { minLength: 1, maxLength: PROVIDER_FEATURES.length })
  .chain((features) =>
    fc.tuple(...features.map(() => fc.tuple(policyArb, proseArb(40), proseArb(30)))).map((rows) =>
      rows.map(([policy, detail, alternative], index) => ({ feature: features[index]!, policy, detail, alternative })),
    ),
  )

function decide(plan: readonly PlannedResolution[], strict: boolean): FeatureDecisions {
  // `resolveWithPolicy` rather than `resolve`, so the policy under test comes from the plan instead
  // of from one upstream's declaration. Both paths reach `resolveFeature` identically.
  const decisions = new FeatureDecisions(KIRO_CAPABILITIES.features, strict)
  for (const row of plan) decisions.resolveWithPolicy(row.feature, row.policy, row.detail, row.alternative)
  return decisions
}

function noticeFeatures(notices: readonly Canonical_FeatureNotice[]): ProviderFeature[] {
  return notices.map((notice) => notice.feature)
}

describe("Strict escalation seen through one request's decisions", () => {
  /**
   * The per-request projection of the property: over any plan of resolutions, strict removes exactly
   * the `degrade` notices, leaves the `emulate` ones untouched and in order, and reports a rejection
   * whenever the plan holds a `degrade` or a `reject`.
   *
   * This is where the property becomes observable to a caller: an upstream reads `firstRejection()`
   * and `notices()`, never a `kind` string, so those two are what have to move together.
   *
   * **Validates: Requirements 11.1, 11.2, 11.3**
   */
  test("Feature: native-api-mode, Property 5: strict removes exactly the degrade notices and adds exactly their rejection", () => {
    fc.assert(
      fc.property(plannedResolutionsArb, (plan) => {
        const unstrict = decide(plan, false)
        const strict = decide(plan, true)

        // Emulate notices survive verbatim, in order; degrade notices become rejections.
        expect(strict.notices()).toEqual(unstrict.notices().filter((notice) => notice.policy !== "degrade"))
        expect(noticeFeatures(strict.notices())).toEqual(plan.filter((row) => row.policy === "emulate").map((row) => row.feature))

        // Every feature is still resolved, so the no-silent-drop account (Requirement 10.8) is
        // unchanged by escalation — a 400 does not shrink the record of what was covered.
        expect([...strict.resolvedFeatures()]).toEqual([...unstrict.resolvedFeatures()])

        // The rejection a client sees is the first failing entry in resolution order, where strict
        // widens "failing" from `reject` to `reject | degrade` and nothing further.
        const expectedStrict = plan.find((row) => row.policy === "degrade" || row.policy === "reject")
        const expectedUnstrict = plan.find((row) => row.policy === "reject")
        expect(strict.firstRejection()?.feature).toBe(expectedStrict?.feature)
        expect(unstrict.firstRejection()?.feature).toBe(expectedUnstrict?.feature)

        // Escalation only ever adds a rejection: it never clears one the unstrict run reported.
        if (unstrict.firstRejection()) expect(strict.firstRejection()).toBeDefined()
      }),
      { numRuns: 400 },
    )
  })

  /**
   * Anti-vacuity for the clause above: the generated plans really do reach all four policies, both
   * rejection states, and a non-empty notice list, so none of those branches was asserted over an
   * empty case.
   */
  test("Feature: native-api-mode, Property 5: the generated plans reach every branch the relation describes", () => {
    const seen = { policies: new Set<FeaturePolicy>(), strictRejected: new Set<boolean>(), unstrictRejected: new Set<boolean>(), notices: new Set<boolean>() }

    fc.assert(
      fc.property(plannedResolutionsArb, (plan) => {
        for (const row of plan) seen.policies.add(row.policy)
        seen.strictRejected.add(decide(plan, true).firstRejection() !== undefined)
        seen.unstrictRejected.add(decide(plan, false).firstRejection() !== undefined)
        seen.notices.add(decide(plan, true).notices().length > 0)
      }),
      { numRuns: 200 },
    )

    expect(seen.policies).toEqual(new Set(FEATURE_POLICIES))
    expect(seen.strictRejected).toEqual(new Set([true, false]))
    expect(seen.unstrictRejected).toEqual(new Set([true, false]))
    expect(seen.notices).toEqual(new Set([true, false]))
  })

  /**
   * Requirement 16.5's escalation half, at the depth this task reaches.
   *
   * The effort resolver (task 22) is what substitutes an out-of-enum effort level and reports it; the
   * feature it reports under is `thinkingBudget`. 16.5 says that report becomes a 400 under strict,
   * which is true exactly when `thinkingBudget`'s declared cell escalates — so that is what is
   * asserted here, on every upstream that declares the cell `degrade`, read from the declarations
   * rather than restated. Copilot is included in the walk and contributes nothing, because its cell
   * is `native` and unmeasured; the loop asserts it is not escalated rather than skipping it.
   *
   * **Validates: Requirement 16.5**
   */
  test("Feature: native-api-mode, Property 5: a declared thinkingBudget degrade escalates on every upstream that declares it", () => {
    const matrices = [
      ["kiro", KIRO_CAPABILITIES.features] as const,
      ["codex", CODEX_CAPABILITIES.features] as const,
      ["copilot", COPILOT_CAPABILITIES.features] as const,
    ]
    const detail = "the requested token budget has no wire field, so the nearest declared effort level was sent instead"
    const alternative = "an upstream that accepts a token budget, or state an effort level inside the model enum"
    let escalated = 0

    for (const [name, features] of matrices) {
      const policy = features.thinkingBudget
      const input: StrictAgnosticInput = { feature: "thinkingBudget", policy, detail, alternative }
      const { unstrict, strict } = resolveBothWays(input)

      if (policy === "degrade") {
        escalated += 1
        expect(unstrict.kind).toBe("degrade")
        expect(isFeatureRejection(strict)).toBe(true)
        if (isFeatureRejection(strict)) {
          expect(strict.feature).toBe("thinkingBudget")
          expect(strict.message).toContain("thinkingBudget")
          expect(strict.message).toMatch(/Use .+ instead\./)
        }
      } else {
        expect(strict).toEqual(unstrict)
      }
      // Named so a future declaration change points at the upstream that moved.
      expect(FEATURE_POLICIES, `unknown thinkingBudget policy declared by ${name}`).toContain(policy)
    }

    // Anti-vacuity: at least one measured upstream declares the cell `degrade` today, so the
    // escalation branch above actually ran.
    expect(escalated).toBeGreaterThan(0)
    expect(KIRO_CAPABILITIES.features.thinkingBudget).toBe("degrade")
  })
})

// ---------------------------------------------------------------------------------------------
// Half B — generators over the environment value
// ---------------------------------------------------------------------------------------------

/** The documented enabling values, spelled independently of the module under test. */
const ENABLING_VALUES = ["1", "true", "yes", "on"] as const

/** Every casing of one value: `"true"`, `"TRUE"`, `"tRuE"`, and so on. */
function casingsArb(value: string): fc.Arbitrary<string> {
  return fc
    .array(fc.boolean(), { minLength: value.length, maxLength: value.length })
    .map((upper) => [...value].map((char, index) => (upper[index] ? char.toUpperCase() : char.toLowerCase())).join(""))
}

const enablingValueArb = fc.constantFrom(...ENABLING_VALUES).chain(casingsArb)

/** Whitespace the shell or a `.env` file can leave attached to a value. */
const WHITESPACE = [" ", "\t", "\n", "\r", "\u000b", "\u000c", "\u00a0"] as const
const whitespaceArb = fc.array(fc.constantFrom(...WHITESPACE), { maxLength: 3 }).map((chars) => chars.join(""))

/**
 * An enabling value with whitespace attached to at least one end.
 *
 * These are **disabled**, and that is the deliberate no-trim choice recorded in task 11.1 to match
 * `kiroDebugOnErrorEnabled()`. Generated as their own arm so the choice is asserted rather than
 * merely surviving inside a broader string generator.
 */
const paddedEnablingArb = fc
  .tuple(whitespaceArb, enablingValueArb, whitespaceArb)
  .filter(([left, , right]) => left.length + right.length > 0)
  .map(([left, value, right]) => `${left}${value}${right}`)

/**
 * Values that look like they should enable and must not: negations, near-misses, off-by-one-character
 * spellings, confusable unicode (Cyrillic `о`, Greek `ο`, fullwidth forms), and a numeral that is
 * not `1`.
 */
const CONFUSABLE_DISABLING = [
  "",
  "0",
  "-1",
  "2",
  "1.0",
  "01",
  "on1",
  "1on",
  "onon",
  "ony",
  "y",
  "n",
  "no",
  "off",
  "false",
  "FALSE",
  "disabled",
  "enabled",
  "null",
  "undefined",
  "NaN",
  "truthy",
  "true;",
  "true,",
  '"true"',
  "'1'",
  "tru",
  "rue",
  "yess",
  "ye",
  "оn", // Cyrillic о
  "οn", // Greek omicron
  "ｏｎ", // fullwidth
  "１", // fullwidth digit one
  "ＴＲＵＥ",
  "yes\u200b", // zero-width space
  "true\u0000",
  "🙂",
] as const

const nonEnablingValueArb: fc.Arbitrary<string | undefined> = fc
  .oneof(
    { weight: 3, arbitrary: fc.string({ maxLength: 12 }) as fc.Arbitrary<string | undefined> },
    { weight: 3, arbitrary: fc.constantFrom<string | undefined>(...CONFUSABLE_DISABLING) },
    { weight: 3, arbitrary: paddedEnablingArb as fc.Arbitrary<string | undefined> },
    { weight: 1, arbitrary: fc.constant<string | undefined>(undefined) },
  )
  .filter((value) => !(ENABLING_VALUES as readonly string[]).includes((value ?? "").toLowerCase()))

/** Any environment value at all — enabling or not. Used by the join clause. */
const anyEnvValueArb: fc.Arbitrary<string | undefined> = fc.oneof(enablingValueArb as fc.Arbitrary<string | undefined>, nonEnablingValueArb)

// ---------------------------------------------------------------------------------------------
// Half B — the environment property
// ---------------------------------------------------------------------------------------------

describe("Any NATIVE_STRICT value outside the documented set resolves to disabled", () => {
  /**
   * The property's environment half. Arbitrary strings, the confusable list, whitespace-padded
   * enabling values, and an absent variable all resolve to `false`.
   *
   * **Validates: Requirement 11.4**
   */
  test("Feature: native-api-mode, Property 5: any value outside the documented set disables strict", () => {
    fc.assert(
      fc.property(nonEnablingValueArb, (value) => {
        expect(isEnablingValue(value)).toBe(false)
        expect(readNativeFlags({ NATIVE_STRICT: value }).strict).toBe(false)
      }),
      { numRuns: 500 },
    )
  })

  /**
   * The other direction, so the clause above is not satisfied by a reader that disables everything:
   * every casing of every documented value enables.
   *
   * **Validates: Requirement 11.4**
   */
  test("Feature: native-api-mode, Property 5: every casing of every documented value enables strict", () => {
    fc.assert(
      fc.property(enablingValueArb, (value) => {
        expect(isEnablingValue(value)).toBe(true)
        expect(readNativeFlags({ NATIVE_STRICT: value }).strict).toBe(true)
      }),
      { numRuns: 300 },
    )

    // The closed set, enumerated in both extreme casings, so the generated clause is anchored.
    for (const value of ENABLING_VALUES) {
      expect(readNativeFlags({ NATIVE_STRICT: value.toUpperCase() }).strict).toBe(true)
      expect(readNativeFlags({ NATIVE_STRICT: value.toLowerCase() }).strict).toBe(true)
    }
  })

  /**
   * No trimming, stated on its own.
   *
   * This is the one clause a future change is most likely to "fix" in the wrong direction, so it is
   * asserted as intent rather than left as a consequence of the generator above: padding an otherwise
   * enabling value disables it, matching `kiroDebugOnErrorEnabled()` exactly (task 11.1).
   *
   * **Validates: Requirement 11.4**
   */
  test("Feature: native-api-mode, Property 5: whitespace-padded enabling values stay disabled", () => {
    fc.assert(
      fc.property(paddedEnablingArb, (value) => {
        expect(value.trim().length).toBeGreaterThan(0)
        // Trimming *would* enable it — which is exactly why the un-trimmed answer has to be false.
        expect(isEnablingValue(value.trim())).toBe(true)
        expect(isEnablingValue(value)).toBe(false)
        expect(readNativeFlags({ NATIVE_STRICT: value }).strict).toBe(false)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * `strict` reads `NATIVE_STRICT` and nothing else: the other three flags, in any state, leave it
   * alone, and a near-miss variable name does not enable it. Without this, a reader that OR-ed the
   * four variables together would pass every clause above.
   *
   * **Validates: Requirement 11.4**
   */
  test("Feature: native-api-mode, Property 5: strict is a function of NATIVE_STRICT alone", () => {
    fc.assert(
      fc.property(anyEnvValueArb, anyEnvValueArb, anyEnvValueArb, anyEnvValueArb, (strictValue, passthrough, mcp, heuristics) => {
        const flags = readNativeFlags({
          NATIVE_STRICT: strictValue,
          NATIVE_PASSTHROUGH: passthrough,
          NATIVE_MCP_EMULATION: mcp,
          KIRO_WEB_SEARCH_HEURISTICS: heuristics,
        })
        expect(flags.strict).toBe(isEnablingValue(strictValue))
      }),
      { numRuns: 300 },
    )

    for (const key of ["native_strict", "Native_Strict", "NATIVESTRICT", "NATIVE_STRICT_MODE", " NATIVE_STRICT", "STRICT"]) {
      expect(readNativeFlags({ [key]: "1" }).strict).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// The join — environment value in, escalated or unescalated outcome out
// ---------------------------------------------------------------------------------------------

describe("strict resolves from the environment and escalates from there", () => {
  /**
   * The two halves composed, which is the only form in which the property is operationally true: an
   * environment value reaches `readNativeFlags()`, its boolean reaches `resolveFeature()`, and a
   * `degrade` becomes a 400 **if and only if** the value was one of the documented four.
   *
   * **Validates: Requirements 11.1, 11.2, 11.4**
   */
  test("Feature: native-api-mode, Property 5: a degrade escalates exactly when the environment value is a documented one", () => {
    fc.assert(
      fc.property(anyEnvValueArb, featureArb, proseArb(40), proseArb(30), (value, feature, detail, alternative) => {
        const strict = readNativeFlags({ NATIVE_STRICT: value }).strict
        const outcome = resolveFeature({ feature, policy: "degrade", detail, alternative, strict })

        expect(isFeatureRejection(outcome)).toBe(isEnablingValue(value))
        expect(outcome.kind).toBe(isEnablingValue(value) ? "reject" : "degrade")
      }),
      { numRuns: 400 },
    )
  })

  /**
   * The same composition on the three policies strict must not touch: whatever the environment says,
   * the outcome is the one an unset variable produces.
   *
   * **Validates: Requirements 11.3, 11.4**
   */
  test("Feature: native-api-mode, Property 5: no environment value changes a native, emulate, or reject outcome", () => {
    fc.assert(
      fc.property(anyEnvValueArb, featureArb, fc.constantFrom<FeaturePolicy>("native", "emulate", "reject"), proseArb(40), proseArb(30), (value, feature, policy, detail, alternative) => {
        const strict = readNativeFlags({ NATIVE_STRICT: value }).strict
        const input: StrictAgnosticInput = { feature, policy, detail, alternative }

        expect(resolveFeature({ ...input, strict })).toEqual(resolveFeature({ ...input, strict: false }))
      }),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Requirement 11.5 — the Kiro unit pair
// ---------------------------------------------------------------------------------------------

/**
 * A Kiro provider whose upstream call is a counted stub.
 *
 * The counter is the point: escalation happens before any upstream work, so the strict branch must
 * spend zero requests. Same construction as `test/upstream/kiro/features.test.ts`, with `strict`
 * added — this is a provider-level pair rather than a `resolveKiroFeatures()` pair because
 * Requirement 11.5 is written in HTTP terms (400 versus 200), and `proxy()` is the boundary where a
 * rejection becomes a status.
 */
function kiroProvider(strict: boolean) {
  const calls: unknown[] = []
  const auth = new Kiro_Auth_Manager(
    { accessToken: "access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 700_000).toISOString(), region: "us-east-1" },
    "/tmp/unused",
  )
  const client = new Kiro_Client(auth, {
    fetch: ((_url: string, init?: { body?: string }) => {
      calls.push(init?.body ? JSON.parse(init.body) : null)
      return Promise.resolve(new Response('{"content":"ok"}'))
    }) as unknown as typeof fetch,
  })
  return { provider: new Kiro_Upstream_Provider({ auth, client, strict }), calls }
}

/**
 * A canonical request built **directly**, not mapped from a Claude or OpenAI wire body.
 *
 * This is load-bearing, and it is the finding Run_Record 11 recorded. `Canonical_Request` has no
 * `sampling` member until task 13, and no inbound mapper populates one until task 14, so a request
 * routed through `claudeToCanonicalRequest()` arrives with `temperature` already gone: both branches
 * would return 200 and the pair would pass for the wrong reason. Constructing the canonical request
 * and casting locally is the same forward-compatible view `src/upstream/kiro/features.ts` reads, and
 * it is what makes the field observable at all at this point in the plan.
 */
type FutureRequest = Canonical_Request & {
  sampling?: { maxOutputTokens?: number; temperature?: number; topP?: number; stopSequences?: string[] }
}

function kiroRequest(overrides: Partial<FutureRequest> = {}): Canonical_Request {
  return {
    model: "claude-sonnet-4-5",
    instructions: "Be helpful",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
    ...overrides,
  } as Canonical_Request
}

const claudeRequest = { model: "claude-sonnet-4-5", messages: [] } as unknown as ClaudeMessagesRequest

/** The two Kiro cells that genuinely declare `degrade` and are resolved from the request today. */
const KIRO_DEGRADE_CASES: ReadonlyArray<[ProviderFeature, Partial<FutureRequest>]> = [
  ["toolChoiceForced", { toolChoice: "required", tools: [{ type: "function", name: "save", parameters: { type: "object" } }] }],
  ["strictToolSchema", { tools: [{ type: "function", name: "save", parameters: { type: "object", additionalProperties: false } }] }],
]

describe("the Kiro unit pair, on a genuinely degraded feature", () => {
  /**
   * Requirement 11.5's intent: one identical Kiro request, 400 with the flag set and
   * 200-plus-notice with it unset.
   *
   * `toolChoiceForced` and `strictToolSchema` stand in for `temperature` because they are the Kiro
   * cells that are actually `degrade` — see the file header for why `temperature` cannot serve, and
   * the `describe` below for what it does instead. The declaration is read here rather than assumed,
   * so this pair starts failing loudly if a future Run_Record moves the cell.
   *
   * **Validates: Requirements 11.1, 11.2, 11.5**
   */
  test.each(KIRO_DEGRADE_CASES)("%s: 400 with the flag set, 200 carrying its notice with it unset", async (feature, overrides) => {
    expect(KIRO_CAPABILITIES.features[feature]).toBe("degrade")

    const strict = kiroProvider(true)
    const rejected = await strict.provider.proxy(kiroRequest(overrides))

    expect(rejected.type).toBe("canonical_error")
    if (rejected.type !== "canonical_error") return
    expect(rejected.status).toBe(400)
    expect(rejected.body).toContain(feature)
    // Resolved before any upstream work, so the 400 costs nothing.
    expect(strict.calls).toEqual([])

    const lenient = kiroProvider(false)
    const accepted = await lenient.provider.proxy(kiroRequest(overrides))

    expect(accepted.type).toBe("canonical_response")
    if (accepted.type !== "canonical_response") return
    expect(noticeFeatures(accepted.featureNotices ?? [])).toContain(feature)
    expect(accepted.featureNotices?.find((notice) => notice.feature === feature)?.policy).toBe("degrade")
    expect(lenient.calls.length).toBeGreaterThan(0)

    // "200 carrying a Feature_Notice" as the client sees it: the degrade renders as a warning ahead
    // of the model text, naming the feature (Requirement 9.1's channel, already in place).
    const message = await canonicalResponseToClaudeMessage(accepted, claudeRequest)
    const rendered = message.content.map((block) => ("text" in block ? block.text : "")).join("\n")
    expect(rendered).toContain(feature)
  })

  /**
   * The pair is a difference made by the flag alone, not by the two requests differing. Asserted by
   * deep-comparing the request objects the two branches were handed.
   *
   * **Validates: Requirement 11.5**
   */
  test("the strict and unstrict branches are handed identical requests", () => {
    for (const [, overrides] of KIRO_DEGRADE_CASES) {
      expect(kiroRequest(overrides)).toEqual(kiroRequest(overrides))
    }
  })
})

describe("the Kiro request carrying temperature, as Requirement 11.5 words it", () => {
  /**
   * The literal request from Requirement 11.5, and what it actually does.
   *
   * Kiro declares `sampling: "reject"` on measured evidence (spike §4: `inferenceConfig` returns 200
   * and is discarded), so a request carrying `temperature` is a rejection **with or without** the
   * flag. The 400-with-the-flag-set half of 11.5 therefore holds; the 200-plus-notice half cannot,
   * because the cell is not `degrade`. That is Property 5's "and nothing else" clause showing up on a
   * real upstream rather than a defect, and the byte-identical message is the evidence: strict added
   * nothing, because there was nothing above a rejection to add.
   *
   * **Validates: Requirements 11.1, 11.3, 11.5**
   */
  test("temperature rejects identically with and without the flag, because the declared cell is reject", async () => {
    expect(KIRO_CAPABILITIES.features.sampling).toBe("reject")
    const overrides: Partial<FutureRequest> = { sampling: { temperature: 0.2 } }

    const strict = kiroProvider(true)
    const withFlag = await strict.provider.proxy(kiroRequest(overrides))
    const lenient = kiroProvider(false)
    const withoutFlag = await lenient.provider.proxy(kiroRequest(overrides))

    expect(withFlag.type).toBe("canonical_error")
    expect(withoutFlag.type).toBe("canonical_error")
    if (withFlag.type !== "canonical_error" || withoutFlag.type !== "canonical_error") return

    // Requirement 11.5's first half holds literally.
    expect(withFlag.status).toBe(400)
    expect(withFlag.body).toContain("sampling")
    // Its second half cannot, and this is the exact reason: same status, same bytes.
    expect(withoutFlag.status).toBe(400)
    expect(withoutFlag.body).toBe(withFlag.body)
    // Neither branch spent an upstream request.
    expect(strict.calls).toEqual([])
    expect(lenient.calls).toEqual([])
  })

  /**
   * The same request with the degrade case folded in, showing the two policies side by side on one
   * request: the `reject` decides the 400 either way because it comes first in matrix order, and the
   * `degrade` is what the flag actually moves.
   *
   * **Validates: Requirements 11.1, 11.2, 11.3**
   */
  test("a request carrying both a rejected and a degraded feature reports the rejection either way", async () => {
    const overrides: Partial<FutureRequest> = { sampling: { temperature: 0.2 }, toolChoice: "required", tools: [{ type: "function", name: "save", parameters: { type: "object" } }] }

    for (const strict of [true, false]) {
      const { provider, calls } = kiroProvider(strict)
      const result = await provider.proxy(kiroRequest(overrides))

      expect(result.type).toBe("canonical_error")
      if (result.type !== "canonical_error") continue
      expect(result.status).toBe(400)
      // Matrix order puts `sampling` first, so the 400 a client sees is stable across the flag.
      expect(result.body).toContain("sampling")
      expect(calls).toEqual([])
    }
  })
})
