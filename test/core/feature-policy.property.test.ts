// Feature: native-api-mode, Property 4: Feature resolution is total and produces exactly one
// outcome.
//
// For any `(feature, policy, detail, alternative, strict)` input, `resolveFeature` returns exactly
// one outcome whose kind is one of `native`, `emulate`, `degrade`, `reject`; a notice exists if and
// only if the kind is `degrade` or `emulate`, that notice carries a non-empty detail and a policy in
// `{degrade, emulate}`, and a rejection message names the feature and a non-empty alternative.
//
// **Validates: Requirements 8.1, 8.6, 10.1, 10.2, 10.3, 14.5, 19.3, 29.2**
//
// Requirements 10.5 and 10.6 — the per-upstream half of the same guarantee — are Property 22 in
// `test/upstream/sampling-divergence.property.test.ts`. Requirement 10.8's set comparison is the
// matrix walk (task 10.6). Property 5 (strict escalation) is task 11.3 and is deliberately not
// pre-empted here: this file asserts what holds for *both* values of `strict`, never that one value
// differs from the other.
//
// ## What this adds over `test/core/feature-policy.test.ts`
//
// That file is example-based: one input per policy, hand-written detail and alternative. It cannot
// see the cases that make totality a claim rather than a coincidence — a blank detail, a policy that
// crossed a JSON boundary, adversarial notice text, or the 176-point closed grid of every
// `ProviderFeature` against every `FeaturePolicy` against both values of `strict`. Those are here,
// enumerated exhaustively where the input set is closed and generated where it is not.
//
// ## Why the enforcement scan lives in this file
//
// The last `describe` block below greps `src/upstream/` for comparisons against the policy literals
// `"degrade"` and `"reject"`. It is the enforcement half of the claim this file's property makes:
// resolution happens *here*, once, so every branch an upstream takes comes from `resolveFeature`
// rather than from a policy string compared at the call site (design decision D3). Two alternatives
// were considered and rejected:
//
//  - A row in `FORBIDDEN_TOKEN_SCOPES` (`test/architecture.property.test.ts`). Its consuming clause
//    asserts `expect(scopeFiles.length).toBe(2)`, so that table is not row-extensible without
//    editing the test body — the same finding task 9.5 recorded. It also cannot express "the literal
//    but not the word", which is the whole distinction below.
//  - Its own file under `test/upstream/`. That is where Property 9's marker scan lives, but Property
//    9 is a numbered property with a requirement of its own. This scan is an unnumbered corollary of
//    the choke point that `src/core/feature-policy.ts` owns, so it belongs with the property that
//    describes that choke point, and task 10.5 names exactly two new files.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_FeatureNoticePolicy } from "../../src/core/canonical"
import type { FeatureOutcome, FeatureOutcomeKind, FeatureResolutionInput } from "../../src/core/feature-policy"
import {
  FEATURE_OUTCOME_KINDS,
  featureOutcomeNotice,
  isFeatureRejection,
  isNativeFeatureOutcome,
  resolveFeature,
  resolveHostedToolPolicy,
} from "../../src/core/feature-policy"
import type { FeaturePolicy, HostedToolPolicyMap, ProviderFeature } from "../../src/core/provider-capabilities"
import { FEATURE_POLICIES, PROVIDER_FEATURES } from "../../src/core/provider-capabilities"
import { path, readFile } from "../helpers"

// ---------------------------------------------------------------------------------------------
// The three observable channels
// ---------------------------------------------------------------------------------------------

/**
 * What a caller can *observe* about an outcome, as opposed to what its `kind` says.
 *
 * `silent` forwards and reports nothing, `notice` carries one Feature_Notice, `rejection` carries a
 * 400 message. "Exactly one outcome" is asserted through these rather than through `kind` alone,
 * because `kind` is a single string and can only ever be one value — reading exclusivity off it
 * would be vacuous. Exclusivity of the channels is not: a hypothetical outcome carrying both a
 * notice and a rejection message, or neither while claiming to report, would fail here.
 */
type OutcomeChannel = "silent" | "notice" | "rejection"

/** Every channel this outcome exposes, read only through the module's own public guards. */
function channelsOf(outcome: FeatureOutcome): OutcomeChannel[] {
  const channels: OutcomeChannel[] = []
  if (isNativeFeatureOutcome(outcome)) channels.push("silent")
  if (featureOutcomeNotice(outcome) !== undefined) channels.push("notice")
  if (isFeatureRejection(outcome)) channels.push("rejection")
  return channels
}

/**
 * The kinds that report through a notice.
 *
 * Spelled through {@link Canonical_FeatureNoticePolicy} with a two-way `satisfies` guard, the same
 * idiom `test/core/feature-notice.property.test.ts` uses: widening or narrowing that alias breaks
 * this file at compile time instead of leaving it asserting a stale vocabulary. Requirement 8.6 is
 * exactly this restriction — `native` and `reject` travel their own paths.
 */
const REPORTING_KINDS = ["degrade", "emulate"] as const satisfies readonly Canonical_FeatureNoticePolicy[]
type AssertNever<T extends never> = T
type _EveryReportingKindIsListed = AssertNever<Exclude<Canonical_FeatureNoticePolicy, (typeof REPORTING_KINDS)[number]>>

function isReportingKind(kind: FeatureOutcomeKind): boolean {
  return (REPORTING_KINDS as readonly string[]).includes(kind)
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

/**
 * Prose characters for the well-behaved arm: no `.` and no quote, so the rejection message parses
 * unambiguously against the `Use … instead.` pattern. The adversarial arm below drops that
 * restriction and asserts only the shape-independent invariants.
 */
const PROSE_CHARS = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_,;:()="]

function proseArb(maxLength: number) {
  return fc.array(fc.constantFrom(...PROSE_CHARS), { minLength: 1, maxLength }).map((chars) => chars.join(""))
}

/**
 * Text that trims to nothing. Every one of these must still produce a non-empty notice detail and a
 * non-empty alternative — the fallback exists so a notice cannot be a silent drop wearing a notice's
 * clothes (Requirement 8.1), and enumerating the blank shapes is what proves the trim, rather than a
 * bare `length > 0` check, is what the module applies.
 */
const BLANK_TEXTS = ["", " ", "   ", "\t", "\n", " \t \n ", "\u00a0"] as const

/** Realistic details, so the generated space is not purely synthetic. */
const REALISTIC_DETAILS = [
  "temperature was not sent upstream because the endpoint has no field for it",
  "the requested schema is embedded in the prompt rather than enforced",
  "tool schemas are sanitized, so strict validation is not passed on",
] as const

const REALISTIC_ALTERNATIVES = [
  "an upstream that honors generation controls, or omit them",
  "an upstream with native structured output, or validate the reply on the client",
  "a different upstream, or omit the field",
] as const

const proseDetailArb = fc.oneof(
  { weight: 3, arbitrary: proseArb(70) },
  { weight: 2, arbitrary: fc.constantFrom(...REALISTIC_DETAILS) },
  { weight: 2, arbitrary: fc.constantFrom(...BLANK_TEXTS) },
)

const proseAlternativeArb = fc.oneof(
  { weight: 3, arbitrary: proseArb(50) },
  { weight: 2, arbitrary: fc.constantFrom(...REALISTIC_ALTERNATIVES) },
  { weight: 2, arbitrary: fc.constantFrom(...BLANK_TEXTS) },
)

/**
 * Text a client could actually get into a provider's prose: quotes, braces, newlines, the wording of
 * the message template itself, and non-Latin script. Used where the assertion does not depend on
 * being able to re-parse the rendered message.
 */
const adversarialTextArb = fc.oneof(
  fc.string({ maxLength: 120 }),
  fc.constantFrom(
    '"',
    "'",
    "`",
    "${injected}",
    "Use nothing instead.",
    "does not support sampling: ",
    "line one\nline two",
    "температура",
    "温度は送信されませんでした",
    "🙂",
    "a".repeat(600),
  ),
)

const featureArb = fc.constantFrom(...PROVIDER_FEATURES)
const policyArb = fc.constantFrom(...FEATURE_POLICIES)

function inputArb(detail: fc.Arbitrary<string>, alternative: fc.Arbitrary<string>): fc.Arbitrary<FeatureResolutionInput> {
  return fc.record({
    feature: featureArb,
    policy: policyArb,
    detail,
    alternative,
    strict: fc.boolean(),
  })
}

const proseInputArb = inputArb(proseDetailArb, proseAlternativeArb)
const adversarialInputArb = inputArb(adversarialTextArb, adversarialTextArb)

/**
 * A policy value the type system says cannot exist: a misspelling, a re-cased member, a blank, or a
 * non-string that crossed a JSON boundary.
 *
 * The alphabet is restricted to letters and spaces so the resulting message stays parseable by the
 * `Use … instead.` clause; the point of this generator is the *absence* of the value from
 * {@link FEATURE_POLICIES}, not its punctuation.
 */
const offContractPolicyArb = fc.oneof(
  fc
    .array(fc.constantFrom(...[..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ "]), { minLength: 0, maxLength: 20 })
    .map((chars) => chars.join(""))
    .filter((value) => !(FEATURE_POLICIES as readonly string[]).includes(value)),
  fc.constantFrom("Degrade", "REJECT", "Native", " emulate", "emulate ", "sideways", "", "degrade|reject"),
) as fc.Arbitrary<FeaturePolicy>

/** Non-string policies, the shape a hand-edited or JSON-round-tripped matrix cell can take. */
const malformedPolicyValues = [undefined, null, 0, 1, true, false, [], {}, { policy: "degrade" }] as const

// ---------------------------------------------------------------------------------------------
// The closed grid
// ---------------------------------------------------------------------------------------------

/**
 * The text shapes the grid pairs with every `(feature, policy, strict)` triple. Two well-formed and
 * two blank, so every grid point exercises both the provided text and the fallback path.
 */
const GRID_TEXTS: ReadonlyArray<{ detail: string; alternative: string }> = [
  { detail: REALISTIC_DETAILS[0], alternative: REALISTIC_ALTERNATIVES[0] },
  { detail: "d", alternative: "a" },
  { detail: "   ", alternative: "" },
  { detail: "", alternative: " \t " },
]

/**
 * Every `(feature, policy, strict, text)` combination: 11 × 4 × 2 × 4 = 352 points.
 *
 * The typed input space is closed in four of its five dimensions, so enumerating it is strictly
 * stronger than sampling it. The generated clauses below cover the fifth — the free text.
 */
const CLOSED_GRID: readonly FeatureResolutionInput[] = PROVIDER_FEATURES.flatMap((feature) =>
  FEATURE_POLICIES.flatMap((policy) =>
    [false, true].flatMap((strict) => GRID_TEXTS.map(({ detail, alternative }) => ({ feature, policy, detail, alternative, strict }))),
  ),
)

/**
 * Check `check` against every member of a closed finite set.
 *
 * Same idiom as `test/architecture.property.test.ts`: the exhaustive loop is the assertion, and the
 * fast-check pass over the same set follows the repo's 100-iteration convention and shrinks to a
 * minimal counterexample.
 */
function assertForEvery<T>(items: readonly T[], check: (item: T) => void): void {
  for (const item of items) check(item)
  if (items.length === 0) return
  fc.assert(
    fc.property(fc.constantFrom(...items), (item) => {
      check(item)
    }),
    { numRuns: 100 },
  )
}

function describeInput(input: FeatureResolutionInput): string {
  return `feature=${input.feature} policy=${JSON.stringify(input.policy)} strict=${input.strict} detail=${JSON.stringify(input.detail)} alternative=${JSON.stringify(input.alternative)}`
}

// ---------------------------------------------------------------------------------------------
// The three clauses, as reusable checks
// ---------------------------------------------------------------------------------------------

/**
 * Clause 1 — one outcome, one kind from the closed four, one observable channel, and the public
 * guards agreeing with the kind they classify.
 */
function assertExactlyOneOutcome(input: FeatureResolutionInput): FeatureOutcome {
  const outcome = resolveFeature(input)

  // Total: a value, always, never `undefined` and never a throw (the throw is caught by the test
  // runner, so reaching this line at all is half the clause).
  expect(outcome).toBeDefined()
  expect(typeof outcome.kind).toBe("string")

  // Exactly one member of the closed union, and no fifth kind (Requirement 29.2).
  const matchingKinds = FEATURE_OUTCOME_KINDS.filter((kind) => kind === outcome.kind)
  if (matchingKinds.length !== 1) {
    throw new Error(`Outcome kind ${JSON.stringify(outcome.kind)} matches ${matchingKinds.length} declared kinds for ${describeInput(input)}`)
  }

  // Exactly one observable channel.
  const channels = channelsOf(outcome)
  if (channels.length !== 1) {
    throw new Error(`Outcome exposes ${channels.length} channels (${channels.join(", ")}) for ${describeInput(input)}`)
  }

  // The guards classify the kind they claim to.
  expect(isNativeFeatureOutcome(outcome)).toBe(channels[0] === "silent")
  expect(featureOutcomeNotice(outcome) !== undefined).toBe(channels[0] === "notice")
  expect(isFeatureRejection(outcome)).toBe(channels[0] === "rejection")

  return outcome
}

/**
 * Clause 2 — a notice exists if and only if the kind reports, and when it does it names the feature,
 * carries a non-empty detail, and carries a policy drawn from `{degrade, emulate}`.
 */
function assertNoticeIffReporting(input: FeatureResolutionInput, outcome: FeatureOutcome): void {
  const notice = featureOutcomeNotice(outcome)

  // The "if and only if", both directions at once.
  expect(notice !== undefined).toBe(isReportingKind(outcome.kind))

  if (!notice) return
  expect(notice.feature).toBe(input.feature)
  // Requirement 8.1: non-empty detail. Trimmed, so whitespace does not pass as text.
  expect(notice.detail.trim().length).toBeGreaterThan(0)
  // Requirement 8.6: the policy is one of the two reporting members, and it is the outcome's own
  // kind rather than an unrelated third value.
  expect(REPORTING_KINDS).toContain(notice.policy)
  // Widened to `string` for the comparison only: `Canonical_FeatureNoticePolicy` is narrower than
  // `FeatureOutcomeKind`, which is the point — the assertion is that the two agree at runtime.
  const noticePolicy: string = notice.policy
  expect(noticePolicy).toBe(outcome.kind)
  // The notice carries no channel of its own beyond the contract's three members.
  expect(Object.keys(notice).sort()).toEqual(["detail", "feature", "policy"])
}

/**
 * Clause 3 — a rejection names the feature and states a non-empty alternative.
 *
 * `parseAlternative` is only meaningful for the prose arm, where the generated text cannot contain
 * the sentinel; the adversarial arm passes `false` and asserts the shape-independent half.
 */
function assertRejectionNamesFeatureAndAlternative(
  input: FeatureResolutionInput,
  outcome: FeatureOutcome,
  parseAlternative: boolean,
): void {
  if (!isFeatureRejection(outcome)) return

  expect(outcome.feature).toBe(input.feature)
  // Requirements 10.3 and 14.5: the message names the rejected feature.
  expect(outcome.message).toContain(input.feature)
  expect(outcome.message.trim().length).toBeGreaterThan(0)

  const provided = input.alternative.trim()
  if (provided.length > 0) {
    // A stated alternative reaches the client verbatim.
    expect(outcome.message).toContain(provided)
  }

  if (!parseAlternative) return
  // The message states *some* non-empty alternative, whether the caller provided one or not.
  const stated = /Use (.+) instead\./.exec(outcome.message)
  if (!stated) {
    throw new Error(`Rejection message states no alternative for ${describeInput(input)}: ${outcome.message}`)
  }
  expect(stated[1]!.trim().length).toBeGreaterThan(0)
}

// ---------------------------------------------------------------------------------------------
// Property 4
// ---------------------------------------------------------------------------------------------

describe("Feature resolution totality", () => {
  /**
   * The whole property over the closed grid: every `ProviderFeature` against every `FeaturePolicy`
   * against both values of `strict` against four text shapes.
   *
   * **Validates: Requirements 8.1, 8.6, 10.1, 10.2, 10.3, 14.5, 29.2**
   */
  test("Feature: native-api-mode, Property 4: every point of the closed input grid produces exactly one outcome", () => {
    // Anti-vacuity: a grid that collapsed to nothing would pass every clause below.
    expect(CLOSED_GRID.length).toBe(PROVIDER_FEATURES.length * FEATURE_POLICIES.length * 2 * GRID_TEXTS.length)
    expect(CLOSED_GRID.length).toBeGreaterThan(300)

    assertForEvery(CLOSED_GRID, (input) => {
      const outcome = assertExactlyOneOutcome(input)
      assertNoticeIffReporting(input, outcome)
      assertRejectionNamesFeatureAndAlternative(input, outcome, true)
    })
  })

  /**
   * The same property over generated prose, including blank detail and blank alternative.
   *
   * **Validates: Requirements 8.1, 8.6, 10.1, 10.2, 10.3, 14.5, 29.2**
   */
  test("Feature: native-api-mode, Property 4: generated prose inputs produce exactly one outcome", () => {
    fc.assert(
      fc.property(proseInputArb, (input) => {
        const outcome = assertExactlyOneOutcome(input)
        assertNoticeIffReporting(input, outcome)
        assertRejectionNamesFeatureAndAlternative(input, outcome, true)
      }),
      { numRuns: 400 },
    )
  })

  /**
   * The shape-independent half over adversarial text: quotes, newlines, template-literal syntax,
   * non-Latin script, the message template's own wording, and a 600-character detail.
   *
   * The `Use … instead.` re-parse is skipped here on purpose — text containing that sentinel makes
   * the parse ambiguous, and asserting on an ambiguous parse would test the test. Totality, channel
   * exclusivity, the notice iff, non-empty detail, and "the message names the feature" all still
   * hold and are all asserted.
   *
   * **Validates: Requirements 8.1, 10.1, 10.2, 10.3, 29.2**
   */
  test("Feature: native-api-mode, Property 4: adversarial detail and alternative text stays total", () => {
    fc.assert(
      fc.property(adversarialInputArb, (input) => {
        const outcome = assertExactlyOneOutcome(input)
        assertNoticeIffReporting(input, outcome)
        assertRejectionNamesFeatureAndAlternative(input, outcome, false)
      }),
      { numRuns: 400 },
    )
  })

  /**
   * Anti-vacuity for the union: across the grid, all four kinds actually occur, and nothing outside
   * the four ever does. Without this, a resolver that returned `{ kind: "native" }` for everything
   * would satisfy every clause above.
   *
   * **Validates: Requirements 10.1, 29.2**
   */
  test("Feature: native-api-mode, Property 4: the grid reaches all four kinds and no fifth", () => {
    const kinds = new Set(CLOSED_GRID.map((input) => resolveFeature(input).kind))

    expect([...kinds].sort()).toEqual([...FEATURE_OUTCOME_KINDS].sort())
    expect(kinds.size).toBe(FEATURE_OUTCOME_KINDS.length)

    // Each channel is reached too, so channel exclusivity is not asserted over an empty case.
    const channels = new Set(CLOSED_GRID.flatMap((input) => channelsOf(resolveFeature(input))))
    expect([...channels].sort()).toEqual(["notice", "rejection", "silent"])
  })

  /**
   * Resolution is a pure function of its input: the same input resolves to the same outcome, and the
   * input object is not modified on the way through. A resolver that cached across calls or edited
   * the caller's record would make "exactly one outcome" depend on call order.
   *
   * **Validates: Requirement 10.1**
   */
  test("Feature: native-api-mode, Property 4: resolution is deterministic and leaves its input untouched", () => {
    fc.assert(
      fc.property(proseInputArb, (input) => {
        const before = structuredClone(input)
        const first = resolveFeature(input)
        const second = resolveFeature(input)

        expect(second).toEqual(first)
        expect(input).toEqual(before)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * Totality at runtime, not only at the type level: a policy that the type system says cannot exist
   * still resolves to one of the four kinds rather than throwing, returning `undefined`, or — worst
   * of the three — forwarding silently. It resolves to the loudest outcome, which is the only choice
   * that cannot hide a dropped field (Requirement 10.1).
   *
   * **Validates: Requirements 10.1, 10.3, 29.2**
   */
  test("Feature: native-api-mode, Property 4: an off-contract policy string resolves to a rejection rather than a throw", () => {
    fc.assert(
      fc.property(featureArb, offContractPolicyArb, proseDetailArb, proseAlternativeArb, fc.boolean(), (feature, policy, detail, alternative, strict) => {
        const input: FeatureResolutionInput = { feature, policy, detail, alternative, strict }
        const outcome = assertExactlyOneOutcome(input)

        expect(isFeatureRejection(outcome)).toBe(true)
        assertNoticeIffReporting(input, outcome)
        assertRejectionNamesFeatureAndAlternative(input, outcome, true)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * The same, for a matrix cell holding a non-string. Enumerated rather than generated because the
   * interesting values are few and each one is a distinct JavaScript coercion hazard: `undefined`
   * and `null` (an absent cell), `0`/`false` (falsy), `[]` (falsy-ish under `==`), and an object.
   *
   * **Validates: Requirements 10.1, 29.2**
   */
  test("Feature: native-api-mode, Property 4: a malformed policy value resolves to a rejection rather than a throw", () => {
    assertForEvery(malformedPolicyValues, (value) => {
      const input: FeatureResolutionInput = {
        feature: "sampling",
        policy: value as unknown as FeaturePolicy,
        detail: REALISTIC_DETAILS[0],
        alternative: REALISTIC_ALTERNATIVES[0],
        strict: false,
      }
      const outcome = assertExactlyOneOutcome(input)

      expect(isFeatureRejection(outcome)).toBe(true)
      expect(featureOutcomeNotice(outcome)).toBeUndefined()
      if (isFeatureRejection(outcome)) expect(outcome.message).toContain("sampling")
    })
  })

  /**
   * Hosted tool lookup feeds the same choke point (Requirement 19.3).
   *
   * `resolveHostedToolPolicy` returns a declared policy or `undefined`, never a fifth thing — and
   * `undefined` is a lookup miss, not an outcome. Whichever it returns, routing the result through
   * `resolveFeature` (the caller's documented fallback for an unlisted type is a notice, so the
   * fallback used here is a reporting policy read from the closed set) still lands on exactly one
   * outcome, and a `reject` cell still produces a rejection naming an alternative.
   *
   * **Validates: Requirements 19.3, 10.1, 10.3**
   */
  test("Feature: native-api-mode, Property 4: a hosted tool policy lookup lands on exactly one outcome", () => {
    const toolTypeArb = fc.oneof(
      fc.constantFrom("web_search", "web_search_preview", "file_search", "code_interpreter", "computer", "mcp", "local_shell", "tool_search", "image_generation"),
      // Keys that are not policies at all, plus prototype keys that must read as absent.
      fc.constantFrom("unlisted_tool", "toString", "constructor", "__proto__", "hasOwnProperty", ""),
      proseArb(12),
    )
    const mapArb = fc.oneof(
      fc.constant(undefined),
      fc.dictionary(toolTypeArb, fc.oneof(policyArb, fc.constantFrom("sideways", "", "Native") as unknown as fc.Arbitrary<FeaturePolicy>), { maxKeys: 6 }),
    ) as fc.Arbitrary<HostedToolPolicyMap | undefined>

    fc.assert(
      fc.property(mapArb, toolTypeArb, fc.boolean(), (map, type, strict) => {
        const looked = resolveHostedToolPolicy(map, type)

        // Either a declared policy or a miss. No third possibility.
        if (looked !== undefined) expect(FEATURE_POLICIES).toContain(looked)

        // A miss is the caller's decision to make, and the documented one is a notice. Either way it
        // goes back through the same resolver, so the four-outcome guarantee is unaffected.
        const policy: FeaturePolicy = looked ?? "degrade"
        const feature: ProviderFeature = "webSearch"
        const input: FeatureResolutionInput = {
          feature,
          policy,
          detail: `the hosted tool type '${type}' is not forwarded as sent`,
          alternative: "a client-side tool, or an upstream that hosts it",
          strict,
        }
        const outcome = assertExactlyOneOutcome(input)
        assertNoticeIffReporting(input, outcome)
        assertRejectionNamesFeatureAndAlternative(input, outcome, true)
      }),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Enforcement: no policy-literal comparison under src/upstream/
// ---------------------------------------------------------------------------------------------

/**
 * The two literals an upstream would compare against if it branched on policy itself.
 *
 * Derived from {@link FeaturePolicy} through `satisfies`, so a renamed policy member breaks this file
 * at compile time rather than leaving the scan looking for a string nothing spells. `native` and
 * `emulate` are out of scope: task 10.5 names these two, and they are the two that carry a branch —
 * "does this fail the request" and "does this report".
 */
const POLICY_BRANCH_LITERALS = ["degrade", "reject"] as const satisfies readonly FeaturePolicy[]

/**
 * A policy literal *as a string literal*: the word delimited immediately by a quote, an apostrophe,
 * or a backtick.
 *
 * Built from {@link POLICY_BRANCH_LITERALS} rather than written out. The delimiter requirement is
 * what makes this a check on comparisons rather than on vocabulary: `case "degrade":` and
 * `policy === "reject"` match, while prose such as "whether `degrade` escalates to `reject`" inside a
 * comment does not — the comment is removed before the pattern runs, and even in code a longer
 * string like `"the degrade path"` is not a comparison against the literal.
 */
const POLICY_LITERAL_PATTERN = new RegExp(`(["'\`])(${POLICY_BRANCH_LITERALS.join("|")})\\1`, "g")

/** Files scanned. Every module under `src/upstream/`… */
const UPSTREAM_GLOB = "src/upstream/**/*.{ts,tsx}"
/** …except the declarations themselves, which are where a policy literal belongs. */
const DECLARATION_BASENAME = "capabilities.ts"

interface PolicyLiteralOccurrence {
  file: string
  literal: string
  /** 1-based line number, so a failure points at the offending line. */
  line: number
  /** The offending line as written, trimmed and clipped. */
  text: string
}

/**
 * Blank out every comment span, preserving byte positions and line breaks.
 *
 * Necessary because Requirement 10.5's enforcement is about *code*: three upstream modules legally
 * discuss `degrade` and `reject` in prose today (`kiro/features.ts`, `kiro/index.ts`,
 * `kiro/feature-notices.ts`), and a naive grep would either fail on them or have to be loosened
 * until it stopped catching real comparisons. Blanking rather than deleting keeps line numbers
 * honest.
 *
 * String state is tracked only so that `//` or `/*` *inside* a string does not read as a comment
 * opener. Strings themselves are left intact — they are what the scan is looking for.
 *
 * Known limitation: regular-expression literals are not tracked, so a `//` inside one would blank
 * the rest of that line. That can only ever hide a violation, never invent one, and the per-file
 * synthesis clause below closes it by proving the detector still fires on every real upstream file.
 */
export function blankComments(content: string): string {
  const out = content.split("")
  const blank = (index: number) => {
    if (out[index] !== "\n") out[index] = " "
  }

  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code"
  let i = 0
  while (i < content.length) {
    const ch = content[i]!
    const next = content[i + 1]

    if (mode === "code") {
      if (ch === "/" && next === "/") {
        mode = "line"
        blank(i)
        blank(i + 1)
        i += 2
        continue
      }
      if (ch === "/" && next === "*") {
        mode = "block"
        blank(i)
        blank(i + 1)
        i += 2
        continue
      }
      if (ch === '"') mode = "double"
      else if (ch === "'") mode = "single"
      else if (ch === "`") mode = "template"
      i += 1
      continue
    }

    if (mode === "line") {
      if (ch === "\n") mode = "code"
      else blank(i)
      i += 1
      continue
    }

    if (mode === "block") {
      if (ch === "*" && next === "/") {
        blank(i)
        blank(i + 1)
        mode = "code"
        i += 2
        continue
      }
      blank(i)
      i += 1
      continue
    }

    // Inside a string or template literal: left as written.
    if (ch === "\\") {
      i += 2
      continue
    }
    if ((mode === "double" && ch === '"') || (mode === "single" && ch === "'") || (mode === "template" && ch === "`")) {
      mode = "code"
      i += 1
      continue
    }
    // An unterminated single-quoted or double-quoted string cannot span a line.
    if (mode !== "template" && ch === "\n") mode = "code"
    i += 1
  }

  return out.join("")
}

/** Every policy-literal occurrence in one file's code, comments excluded. */
export function findPolicyLiteralOccurrences(file: string, content: string): PolicyLiteralOccurrence[] {
  const codeLines = blankComments(content).split("\n")
  const rawLines = content.split("\n")
  const occurrences: PolicyLiteralOccurrence[] = []

  for (const [index, line] of codeLines.entries()) {
    for (const match of line.matchAll(POLICY_LITERAL_PATTERN)) {
      occurrences.push({ file, literal: match[2]!, line: index + 1, text: (rawLines[index] ?? "").trim().slice(0, 160) })
    }
  }
  return occurrences
}

async function scanUpstreamFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for await (const file of new Bun.Glob(UPSTREAM_GLOB).scan({ cwd: root, onlyFiles: true })) {
    const normalized = file.replace(/\\/g, "/")
    if (!normalized.endsWith(`/${DECLARATION_BASENAME}`)) files.push(normalized)
  }
  return files.sort()
}

function describeOccurrence(occurrence: PolicyLiteralOccurrence): string {
  return `${occurrence.file}:${occurrence.line} compares against ${JSON.stringify(occurrence.literal)} — ${occurrence.text}`
}

describe("Upstream policy-literal boundary", () => {
  /**
   * No module under `src/upstream/`, outside its own `capabilities.ts`, spells the policy literals
   * `"degrade"` or `"reject"` in code — so every branch an upstream takes on a non-native outcome
   * came from `resolveFeature` rather than from a comparison written at the call site.
   *
   * **Validates: Requirements 10.1, 10.2, 10.3**
   */
  test("Feature: native-api-mode, Property 4: no upstream module outside capabilities.ts compares against a policy literal", async () => {
    const files = await scanUpstreamFiles(process.cwd())

    // Anti-vacuity: a broken glob must fail loudly rather than pass by scanning nothing.
    expect(files.length).toBeGreaterThan(20)
    expect(files).toContain("src/upstream/kiro/features.ts")
    expect(files).toContain("src/upstream/kiro/index.ts")
    expect(files).toContain("src/upstream/codex/features.ts")
    expect(files).toContain("src/upstream/copilot/features.ts")
    // The declarations are the one place the literals belong, and they are out of scope.
    expect(files.filter((file) => file.endsWith(`/${DECLARATION_BASENAME}`))).toEqual([])

    const occurrences: PolicyLiteralOccurrence[] = []
    for (const file of files) {
      occurrences.push(...findPolicyLiteralOccurrences(file, await readFile(path.join(process.cwd(), file), "utf8")))
    }

    if (occurrences.length > 0) {
      throw new Error(
        `An upstream module branches on a policy literal instead of on a resolved outcome:\n` +
          occurrences.map((occurrence) => `  ${describeOccurrence(occurrence)}`).join("\n") +
          `\n  Resolve the feature through resolveFeature()/FeatureDecisions and branch on the outcome` +
          ` (isFeatureRejection, featureOutcomeNotice, firstRejection). The policy value belongs in` +
          ` that provider's ${DECLARATION_BASENAME} and nowhere else.`,
      )
    }
    expect(occurrences).toEqual([])
  })

  /**
   * The declarations really are the only place the literals live, so the exclusion above is an
   * exclusion of something rather than a hole. Without this, `capabilities.ts` could stop declaring
   * policies altogether and the clause above would still pass.
   *
   * **Validates: Requirement 10.1**
   */
  test("Feature: native-api-mode, Property 4: each upstream declaration does spell its policies", async () => {
    const declarations: string[] = []
    for await (const file of new Bun.Glob(UPSTREAM_GLOB).scan({ cwd: process.cwd(), onlyFiles: true })) {
      const normalized = file.replace(/\\/g, "/")
      if (normalized.endsWith(`/${DECLARATION_BASENAME}`)) declarations.push(normalized)
    }
    expect(declarations.sort()).toEqual([
      "src/upstream/codex/capabilities.ts",
      "src/upstream/copilot/capabilities.ts",
      "src/upstream/kiro/capabilities.ts",
    ])

    for (const declaration of declarations) {
      const content = await readFile(path.join(process.cwd(), declaration), "utf8")
      const found = findPolicyLiteralOccurrences(declaration, content)
      // A declaration that spelled no policy at all would mean the matrix moved somewhere else.
      expect(found.length).toBeGreaterThan(0)
    }
  })

  /**
   * Detector correctness, per file — appending one synthesized comparison to each real upstream
   * file's content makes the detector fire on that file, and the unmodified content does not.
   *
   * This is what turns a passing grep into evidence. It also closes the regex-literal caveat noted
   * on {@link blankComments}: if any real file's syntax confused the comment scanner badly enough to
   * blank live code, the synthesized comparison in that file would go unreported and this clause
   * would fail naming it. Nothing is written to disk — the content is modified in memory.
   *
   * **Validates: Requirements 10.1, 10.2, 10.3**
   */
  test("Feature: native-api-mode, Property 4: the detector fires on a synthesized comparison in every upstream file", async () => {
    const files = await scanUpstreamFiles(process.cwd())
    const contents = new Map<string, string>()
    for (const file of files) contents.set(file, await readFile(path.join(process.cwd(), file), "utf8"))

    const violationArb = fc.constantFrom(
      (literal: string) => `if (policy === "${literal}") return null`,
      (literal: string) => `switch (policy) { case '${literal}': break }`,
      (literal: string) => `const escalate = outcome.kind === \`${literal}\``,
      (literal: string) => `const set = new Set(["native", "${literal}"])`,
    )

    fc.assert(
      fc.property(fc.constantFrom(...files), fc.constantFrom(...POLICY_BRANCH_LITERALS), violationArb, (file, literal, build) => {
        const original = contents.get(file)!
        expect(findPolicyLiteralOccurrences(file, original)).toEqual([])

        const line = build(literal)
        const dirty = `${original}\n${line}\n`
        const found = findPolicyLiteralOccurrences(file, dirty)

        expect(found.length).toBeGreaterThan(0)
        expect(found.every((occurrence) => occurrence.literal === literal)).toBe(true)
        // The report points at the appended line, not at the file as a whole.
        expect(found[0]!.line).toBe(original.split("\n").length + 1)
        expect(found[0]!.text).toBe(line)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * The comment control, in both directions.
   *
   * Three upstream modules discuss `degrade` and `reject` in prose today. The clause above passes
   * *because* comments are excluded, not because the word is absent — asserted here so nobody later
   * "fixes" the scan by deleting the doc comments, and so the exclusion cannot silently widen into
   * ignoring code: the same word, moved out of the comment, is reported.
   *
   * **Validates: Requirement 10.1**
   */
  test("Feature: native-api-mode, Property 4: policy prose in a comment is exempt and the same literal in code is not", async () => {
    const prose = ["src/upstream/kiro/features.ts", "src/upstream/kiro/index.ts", "src/upstream/kiro/feature-notices.ts"]

    for (const file of prose) {
      const content = await readFile(path.join(process.cwd(), file), "utf8")
      // The word is present…
      expect(POLICY_BRANCH_LITERALS.some((literal) => content.includes(literal))).toBe(true)
      // …and reported nowhere, because every occurrence is prose.
      expect(findPolicyLiteralOccurrences(file, content)).toEqual([])
    }

    fc.assert(
      fc.property(fc.constantFrom(...POLICY_BRANCH_LITERALS), fc.constantFrom("//", "///", " //"), (literal, opener) => {
        const commented = `const x = 1\n${opener} whether \`${literal}\` escalates, and "${literal}" spelled in prose\n`
        expect(findPolicyLiteralOccurrences("scratch.ts", commented)).toEqual([])

        const block = `/**\n * A ${literal} outcome: "${literal}".\n */\nconst y = 2\n`
        expect(findPolicyLiteralOccurrences("scratch.ts", block)).toEqual([])

        // The same literal in code, on the line right after the comment, is reported.
        const mixed = `${commented}const z = policy === "${literal}"\n`
        const found = findPolicyLiteralOccurrences("scratch.ts", mixed)
        expect(found.map((occurrence) => occurrence.line)).toEqual([3])

        // A `//` inside a string does not open a comment, so a literal after it is still reported.
        const inString = `const url = "https://example.test/a"; const w = policy === '${literal}'\n`
        expect(findPolicyLiteralOccurrences("scratch.ts", inString).length).toBe(1)

        // The word inside a longer string is vocabulary, not a comparison, and is not reported.
        expect(findPolicyLiteralOccurrences("scratch.ts", `const m = "the ${literal} path was taken"\n`)).toEqual([])
      }),
      { numRuns: 200 },
    )
  })
})
