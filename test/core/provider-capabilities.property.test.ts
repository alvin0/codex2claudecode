// Vocabulary half of Property 1 (task 5.2). Scope is `src/core/provider-capabilities.ts` only —
// the per-upstream matrix half is task 6.4, so nothing here imports an `Upstream_Capability_Module`.
//
// Two proof techniques, chosen per claim rather than uniformly:
//
//   1. Exhaustive enumeration for the closed finite sets. `ProviderFeature` has 12 members and
//      `FeaturePolicy` has 4; both are closed, so the test walks the whole domain in both
//      directions against a frozen expected list written out independently of the module. On a
//      closed set that is strictly stronger than sampling, so no generator is used for it.
//   2. Generated arbitrary feature maps for the totality claim, which quantifies over *any*
//      `Record<ProviderFeature, FeaturePolicy>` — including maps this repository never declares.
//      Asserting the current array contents would not establish that.
//
// The "adding or removing a feature fails" clause is expressed at BOTH levels, because neither
// level alone bites in both directions:
//
//   - Compile time (`tsc -p tsconfig.test.json --noEmit`) covers drift in the `ProviderFeature`
//     and `FeaturePolicy` *unions*. `_PROVIDER_FEATURE_UNION_IS_THE_TWELVE` and its policy twin
//     are bidirectional set-equality aliases: gaining or losing a union member makes them resolve
//     to `false`, and assigning `true` to `false` is a compile error. `COMPLETE_FEATURE_MAP` is a
//     fully written 12-key literal that stops compiling the moment a 13th feature appears, and the
//     two `@ts-expect-error` declarations pin the other direction: a map missing a key and a map
//     carrying a key outside the union must each be rejected. Those two comments are themselves
//     load-bearing — if the guarantee vanished the errors would disappear and TypeScript would
//     then report TS2578 "unused '@ts-expect-error' directive", so the file fails either way.
//   - Runtime covers drift in the `PROVIDER_FEATURES` / `FEATURE_POLICIES` *arrays* and covers maps
//     the compiler never sees (parsed JSON, a value crossing an `unknown` boundary). `keyFailures`
//     derives its domain from the module, so array drift alone would move the goalposts; the frozen
//     `EXPECTED_*` lists are what keep it honest.
//
// Requirement 1.4 deliberately leaves `bun run typecheck` red at two upstream declaration sites
// that do not yet declare `features` (tasks 6.1 and 6.2 close them). This file compiles and passes
// independently of that, which is why it imports no `capabilities.ts`.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import {
  FEATURE_POLICIES,
  PROVIDER_FEATURES,
  type FeaturePolicy,
  type ProviderFeature,
} from "../../src/core/provider-capabilities"

/**
 * The 12 features and 4 policies as stated in the requirements Glossary, written here by hand.
 *
 * These lists are the fixed point of the test: they are NOT derived from the module, so a member
 * added to or removed from `PROVIDER_FEATURES` / `FEATURE_POLICIES` fails an assertion instead of
 * quietly redefining what the test considers correct.
 */
const EXPECTED_FEATURES = [
  "sampling",
  "outputLength",
  "stopSequences",
  "thinkingBudget",
  "systemPrompt",
  "promptCache",
  "strictToolSchema",
  "toolChoiceForced",
  "structuredOutput",
  "webSearch",
  "webFetch",
  "mcpToolset",
] as const

const EXPECTED_POLICIES = ["native", "emulate", "degrade", "reject"] as const

/** Bidirectional assignability, so a set that gains OR loses a member resolves to `false`. */
type SetEquals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * Compile-time half of "adding or removing a feature fails", union direction.
 *
 * A 13th `ProviderFeature` member makes `SetEquals` resolve to `false`; so does deleting one.
 * `true` is not assignable to `false`, so the file stops compiling in either case.
 */
const _PROVIDER_FEATURE_UNION_IS_THE_TWELVE: SetEquals<ProviderFeature, (typeof EXPECTED_FEATURES)[number]> = true
const _FEATURE_POLICY_UNION_IS_THE_FOUR: SetEquals<FeaturePolicy, (typeof EXPECTED_POLICIES)[number]> = true

/**
 * A total feature map written out key by key.
 *
 * Adding a 13th member to `ProviderFeature` makes this literal incomplete and the file stops
 * compiling — the addition direction of the clause, at the declaration shape rather than the union.
 */
const COMPLETE_FEATURE_MAP: Record<ProviderFeature, FeaturePolicy> = {
  sampling: "native",
  outputLength: "emulate",
  stopSequences: "emulate",
  thinkingBudget: "degrade",
  systemPrompt: "reject",
  promptCache: "native",
  strictToolSchema: "emulate",
  toolChoiceForced: "degrade",
  structuredOutput: "reject",
  webSearch: "native",
  webFetch: "emulate",
  mcpToolset: "degrade",
}

/**
 * Removal direction: a `Record<ProviderFeature, FeaturePolicy>` missing `mcpToolset` is rejected
 * (TS2741). If `mcpToolset` were dropped from the union this literal would become complete, the
 * error would vanish, and TypeScript would report the directive as unused — so this line fails
 * whether the guarantee weakens or the feature disappears.
 */
// @ts-expect-error - a total feature map cannot omit `mcpToolset`
const _MAP_MISSING_A_FEATURE: Record<ProviderFeature, FeaturePolicy> = {
  sampling: "native",
  outputLength: "native",
  stopSequences: "native",
  thinkingBudget: "native",
  systemPrompt: "native",
  promptCache: "native",
  strictToolSchema: "native",
  toolChoiceForced: "native",
  structuredOutput: "native",
  webSearch: "native",
  webFetch: "native",
}

/**
 * Foreign-key direction: excess property checking rejects a key outside `ProviderFeature`, so a
 * feature name that is not in the vocabulary cannot enter a capability declaration by accident.
 */
const _MAP_WITH_A_FOREIGN_FEATURE: Record<ProviderFeature, FeaturePolicy> = {
  ...COMPLETE_FEATURE_MAP,
  // @ts-expect-error - `promptCaching` is not a `ProviderFeature`
  promptCaching: "native",
}

/** A policy value that is not one of the four, rejected at the value position. */
// @ts-expect-error - "passthrough" is not a `FeaturePolicy`
const _POLICY_OUTSIDE_THE_FOUR: FeaturePolicy = "passthrough"

type TotalityFailure =
  | { kind: "missing"; key: string }
  | { kind: "extra"; key: string }
  | { kind: "policy"; key: string; value: unknown }

/**
 * Runtime half of the clause: totality checked against the module's own vocabulary, for a map the
 * compiler may never have seen. Every deviation is reported rather than short-circuited, so a
 * failure names which of the three ways the map is not total.
 */
function totalityFailures(map: Readonly<Record<string, unknown>>): TotalityFailure[] {
  const failures: TotalityFailure[] = []
  const policies: readonly string[] = FEATURE_POLICIES

  for (const feature of PROVIDER_FEATURES) {
    if (!Object.hasOwn(map, feature)) {
      failures.push({ kind: "missing", key: feature })
      continue
    }
    const value = map[feature]
    if (typeof value !== "string" || !policies.includes(value)) {
      failures.push({ kind: "policy", key: feature, value })
    }
  }

  const known: readonly string[] = PROVIDER_FEATURES
  for (const key of Object.keys(map)) {
    if (!known.includes(key)) failures.push({ kind: "extra", key })
  }

  return failures
}

const policyArb = fc.constantFrom(...FEATURE_POLICIES)

/** Any total feature map, not just the ones this repository happens to declare. */
const completeMapArb: fc.Arbitrary<Record<ProviderFeature, FeaturePolicy>> = fc
  .array(policyArb, { minLength: PROVIDER_FEATURES.length, maxLength: PROVIDER_FEATURES.length })
  .map(
    (policies) =>
      Object.fromEntries(PROVIDER_FEATURES.map((feature, index) => [feature, policies[index]!])) as Record<
        ProviderFeature,
        FeaturePolicy
      >,
  )

const featureArb = fc.constantFrom(...PROVIDER_FEATURES)

const foreignKeyArb = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((key) => !(PROVIDER_FEATURES as readonly string[]).includes(key))

const nonPolicyArb = fc
  .string({ maxLength: 24 })
  .filter((value) => !(FEATURE_POLICIES as readonly string[]).includes(value))

describe("capability vocabulary properties", () => {
  /**
   * Feature: native-api-mode, Property 1: Capability matrix totality — the `ProviderFeature`
   * member set equals the 12-member set, every `FeaturePolicy` value is one of four, and adding
   * or removing a feature fails.
   *
   * **Validates: Requirements 1.2, 1.3, 1.6**
   */
  test("Feature: native-api-mode, Property 1: Capability matrix totality (vocabulary)", () => {
    // Closed finite sets, so both directions are enumerated rather than sampled.
    expect([...PROVIDER_FEATURES].sort()).toEqual([...EXPECTED_FEATURES].sort())
    expect(PROVIDER_FEATURES).toHaveLength(EXPECTED_FEATURES.length)
    expect(new Set(PROVIDER_FEATURES).size).toBe(EXPECTED_FEATURES.length)
    for (const feature of EXPECTED_FEATURES) expect(PROVIDER_FEATURES).toContain(feature)
    for (const feature of PROVIDER_FEATURES) expect(EXPECTED_FEATURES as readonly string[]).toContain(feature)

    expect([...FEATURE_POLICIES].sort()).toEqual([...EXPECTED_POLICIES].sort())
    expect(new Set(FEATURE_POLICIES).size).toBe(EXPECTED_POLICIES.length)
    for (const policy of EXPECTED_POLICIES) expect(FEATURE_POLICIES).toContain(policy)
    for (const policy of FEATURE_POLICIES) expect(EXPECTED_POLICIES as readonly string[]).toContain(policy)

    // Totality over arbitrary maps: every generated map is total and every value is one of four.
    fc.assert(
      fc.property(completeMapArb, (map) => {
        expect(totalityFailures(map)).toEqual([])
        expect(Object.keys(map).sort()).toEqual([...EXPECTED_FEATURES].sort())
        for (const feature of PROVIDER_FEATURES) {
          expect(FEATURE_POLICIES).toContain(map[feature])
        }
      }),
      { numRuns: 100 },
    )
  })

  /**
   * Feature: native-api-mode, Property 1: Capability matrix totality — the "adding or removing a
   * feature fails" clause, checked at runtime for maps the compiler cannot inspect.
   *
   * **Validates: Requirements 1.2, 1.3, 1.6**
   */
  test("Feature: native-api-mode, Property 1: removing, adding, or mistyping a feature is detected", () => {
    // Removing any one feature from any total map is detected, and named.
    fc.assert(
      fc.property(completeMapArb, featureArb, (map, dropped) => {
        const partial: Record<string, unknown> = { ...map }
        delete partial[dropped]

        const failures = totalityFailures(partial)
        expect(failures).toContainEqual({ kind: "missing", key: dropped })
        expect(failures.filter((failure) => failure.kind === "missing")).toHaveLength(1)
      }),
      { numRuns: 100 },
    )

    // Adding a key outside `PROVIDER_FEATURES` is detected, and named.
    fc.assert(
      fc.property(completeMapArb, foreignKeyArb, policyArb, (map, foreign, policy) => {
        const failures = totalityFailures({ ...map, [foreign]: policy })
        expect(failures).toEqual([{ kind: "extra", key: foreign }])
      }),
      { numRuns: 100 },
    )

    // A value outside the four policies is detected, and named, at the feature it sits on.
    fc.assert(
      fc.property(completeMapArb, featureArb, nonPolicyArb, (map, feature, value) => {
        const failures = totalityFailures({ ...map, [feature]: value })
        expect(failures).toEqual([{ kind: "policy", key: feature, value }])
      }),
      { numRuns: 100 },
    )

    // Every deviation is reported, so a map that is wrong three ways yields three failures.
    fc.assert(
      fc.property(completeMapArb, featureArb, featureArb, foreignKeyArb, nonPolicyArb, (map, dropped, mistyped, foreign, value) => {
        fc.pre(dropped !== mistyped)
        const broken: Record<string, unknown> = { ...map, [mistyped]: value, [foreign]: "native" }
        delete broken[dropped]

        const failures = totalityFailures(broken)
        expect(failures).toContainEqual({ kind: "missing", key: dropped })
        expect(failures).toContainEqual({ kind: "policy", key: mistyped, value })
        expect(failures).toContainEqual({ kind: "extra", key: foreign })
        expect(failures).toHaveLength(3)
      }),
      { numRuns: 100 },
    )
  })

  /**
   * The compile-time witnesses above are the real assertion for union drift; `tsc -p
   * tsconfig.test.json --noEmit` is what evaluates them. This case keeps them visible in the test
   * report and keeps the declarations referenced, so no tool prunes them as dead code.
   *
   * **Validates: Requirements 1.2, 1.3**
   */
  test("the vocabulary unions are pinned to the expected sets at compile time", () => {
    expect(_PROVIDER_FEATURE_UNION_IS_THE_TWELVE).toBe(true)
    expect(_FEATURE_POLICY_UNION_IS_THE_FOUR).toBe(true)
    expect(totalityFailures(COMPLETE_FEATURE_MAP)).toEqual([])
    expect(Object.keys(_MAP_MISSING_A_FEATURE)).toHaveLength(EXPECTED_FEATURES.length - 1)
    expect(Object.keys(_MAP_WITH_A_FOREIGN_FEATURE)).toHaveLength(EXPECTED_FEATURES.length + 1)
    expect(EXPECTED_POLICIES as readonly string[]).not.toContain(_POLICY_OUTSIDE_THE_FOUR)
  })
})
