// Per-upstream half of Property 1 (task 6.4), plus Property 3. Scope is the three
// `Upstream_Capability_Module` declarations: `src/upstream/{kiro,codex,copilot}/capabilities.ts`.
//
// The vocabulary half lives in `test/core/provider-capabilities.property.test.ts` (task 5.2) and
// imports no `capabilities.ts` at all. That file proves things about `ProviderFeature`,
// `FeaturePolicy`, and *arbitrary* total maps — that the unions are the 12 and the 4, and that a
// generic totality checker detects a missing, foreign, or mistyped key across generated maps. None
// of that says anything about what the three real modules declare, which is what this file is for.
// Nothing here re-proves a vocabulary claim, and no arbitrary map is manufactured to be checked:
// every assertion below is anchored to a declaration this repository actually ships.
//
// ## Closed domain vs. generation
//
// The domain of Property 1 here is closed and finite: 3 upstreams × 12 features = 36 cells, and 12
// entries for Property 3. Enumeration over a closed set is strictly stronger than sampling it, so
// every claim about *what is declared* is enumerated exhaustively — `fc.constantFrom` over 12
// features would only ever rediscover cells a `for` loop already visited, at 100 runs instead of 12
// visits, with the risk of missing one.
//
// Generation is used where the domain is genuinely open, and only there:
//
//   1. **Foreign keys.** "No key outside `PROVIDER_FEATURES`" quantifies over *all* strings, not
//      over the 11. Enumeration cannot express it; `foreignKeyArb` can, and it is the one clause of
//      Property 1 that needs a generator at this level.
//   2. **Mutations of the real declarations.** The exhaustive walk shows the declarations are total
//      today. It does not show the walk would *notice* if they stopped being total — a checker that
//      returns `[]` unconditionally passes it. So each real map is perturbed one way at a time,
//      across generated feature/key/value choices, and the deviation must be reported and named.
//      This is the checker being validated against the shipped matrices rather than against
//      synthetic maps, which is the part `test/core/provider-capabilities.property.test.ts` cannot
//      cover.
//
// ## One test per cell (Requirement 29.1)
//
// Requirement 29.1 asks for the matrix to exist in code "with one test per cell asserting the
// declared policy", so the 36 cells are 36 named `test()` cases generated from
// `DECLARED_POLICY_MATRIX` — a hand-written expectation that is deliberately NOT derived from
// `src/`. Raising a cell is therefore a two-key change: the declaration and this table. That
// duplication is the mechanism, not an accident. A silent edit to a policy — exactly the class of
// change Requirement 2.7 and the spike's §9.4/§10.6 doctrine exist to prevent — fails a cell test
// naming the upstream, the feature, the old value, and the new one.
//
// ## What is deliberately not here
//
// `hostedTools`: the ten Responses type names are **not** listed in this file. Task 29.4 designates
// `test/upstream/hosted-tools.property.test.ts` as "the one test allowed to know the whole
// cross-provider key set", and Property 27 is where per-type outcomes are asserted. Reproducing the
// ten names here would create a second place to update and would put Responses wire vocabulary in a
// test whose subject is the provider-agnostic `features` contract. What this file does assert about
// `hostedTools` is name-free and belongs to Property 1's own words ("a value drawn from the four
// `FeaturePolicy` members"): every declared value is one of the four, and the three modules agree on
// *which* keys they declare. The second half pins the deliberate-duplication decision behind
// Requirement 2.2/19.1 — three files repeating one list stay in sync — without naming the list.
//
// Sampling caveat, rewritten because the caveat it recorded has been discharged by measurement.
// Codex used to declare `sampling: "native"` and `outputLength: "native"` by elimination from
// Requirement 10.6, with no evidence that either value reached the wire. Both are now `degrade` on a
// measurement: `.omc/research/kiro-wire-spike.md` §11.2 sent `temperature`, `top_p`, and
// `max_output_tokens` one per run and got `400 {"detail":"Unsupported parameter: <name>"}` for each,
// against a 200 control carrying none of them. Copilot's two cells stay `native` and stay declared by
// elimination — a different endpoint, no connected account, nothing probed. Nothing in this file
// asserts a value reaches any wire; these are declaration tests, and `test/native/verify-matrix.ts`
// plus Requirement 14.6 own the wire claim.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import {
  FEATURE_POLICIES,
  PROVIDER_FEATURES,
  type FeatureEvidence,
  type FeaturePolicy,
  type ProviderCapabilities,
  type ProviderFeature,
} from "../../src/core/provider-capabilities"
import { CODEX_CAPABILITIES } from "../../src/upstream/codex/capabilities"
import { COPILOT_CAPABILITIES, COPILOT_CAPABILITY_EVIDENCE } from "../../src/upstream/copilot/capabilities"
import { KIRO_CAPABILITIES } from "../../src/upstream/kiro/capabilities"

/**
 * Every declared `Upstream_Capability_Module`, one line each.
 *
 * A fourth upstream is a single row here. `as const satisfies` keeps the names as literals, so the
 * row also widens `UpstreamName` — which makes `DECLARED_POLICY_MATRIX` below incomplete and stops
 * the file compiling until the new upstream's 12 cells are written out. Adding an upstream cannot
 * silently skip the per-cell tests.
 */
const UPSTREAM_CAPABILITY_MODULES = [
  { upstream: "kiro", capabilities: KIRO_CAPABILITIES },
  { upstream: "codex", capabilities: CODEX_CAPABILITIES },
  { upstream: "copilot", capabilities: COPILOT_CAPABILITIES },
] as const satisfies readonly { upstream: string; capabilities: ProviderCapabilities }[]

type UpstreamName = (typeof UPSTREAM_CAPABILITY_MODULES)[number]["upstream"]

/**
 * The 36 declared cells, written by hand (Requirement 29.1).
 *
 * Not derived from `src/` — this is the fixed point that makes a changed policy fail a test instead
 * of quietly redefining what the test considers correct. The `Record<UpstreamName, Record<...>>`
 * annotation is the compile-time half: a 13th `ProviderFeature` makes all three blocks incomplete,
 * and a fourth table row above makes the outer record incomplete.
 *
 * Cells worth knowing about while reading, because they are the ones under active pressure:
 *   - `kiro.sampling` — Requirement 2.3, resting on a measurement in
 *     `.omc/research/kiro-wire-spike.md` (§4).
 *   - `kiro.stopSequences` — `degrade` on the same §4 measurement read the way `outputLength` and
 *     `promptCache` read theirs: a dropped stop sequence changes where the reply ends, not whether
 *     the request can be served. It rejected until a client that routinely sends `stop_sequences`
 *     (Claude Code, on 19 of 100 consecutive requests in one recorded session) turned that cell
 *     into a refusal of that whole share. All three upstreams now agree on `degrade` here.
 *   - `kiro.outputLength` — `degrade` rather than `reject`, on the same §4 measurement read the
 *     other way: the limit is accepted with a 200 and then disregarded, so the semantics changed
 *     rather than the field having nowhere to go. Task 12b split it out of `sampling` for exactly
 *     that reason, so the two cells diverging here is the point rather than an inconsistency.
 *   - `kiro.promptCache` — `degrade` on the §7 measurement read the same way as `outputLength`:
 *     a dropped cache hint changes what a request costs, not what it answers, so it reports
 *     instead of refusing. It rejected until a client that always sends `cache_control`
 *     (Claude Code) turned that cell into a refusal of every request. All three upstreams now
 *     agree on `degrade` here, which is the point rather than a Kiro-specific concession.
 *   - `codex.sampling` / `codex.outputLength` — **`degrade`, measured** (spike §11.2, §11.5). Both
 *     read `native` until that probe: `sampling` by elimination from Requirement 10.6, and
 *     `outputLength` on wire-format grounds because the Responses API documents
 *     `max_output_tokens`. The endpoint refuses all three spellings, so both readings fell.
 *   - `copilot.outputLength` — still `native` on the same wire-format grounds, and still
 *     unmeasured. It diverging from `codex.outputLength` is now the point: the §11.2 measurement is
 *     about one endpoint, and Copilot's is a different one with no account to probe.
 *   - `codex.mcpToolset` — Requirement 2.4, the "preserve current behavior" guarantee.
 *   - `copilot.sampling` — declared by requirement elimination (10.6), not yet observable on the
 *     wire. Asserted as declared; see the file header.
 *   - `codex.thinkingBudget` — may rise to `native` only after task 19b plus a new Run_Record.
 *   - every `copilot` cell — unmeasured, per `COPILOT_CAPABILITY_EVIDENCE` and Property 3 below.
 */
const DECLARED_POLICY_MATRIX: Record<UpstreamName, Record<ProviderFeature, FeaturePolicy>> = {
  kiro: {
    sampling: "reject",
    outputLength: "degrade",
    stopSequences: "degrade",
    thinkingBudget: "degrade",
    systemPrompt: "emulate",
    promptCache: "degrade",
    strictToolSchema: "degrade",
    toolChoiceForced: "degrade",
    structuredOutput: "emulate",
    webSearch: "emulate",
    webFetch: "emulate",
    mcpToolset: "emulate",
  },
  codex: {
    // Both restated from `native` — measured, spike §11.2 / §11.5. See the cell notes above.
    sampling: "degrade",
    outputLength: "degrade",
    stopSequences: "degrade",
    thinkingBudget: "degrade",
    systemPrompt: "native",
    promptCache: "degrade",
    strictToolSchema: "native",
    toolChoiceForced: "native",
    structuredOutput: "native",
    webSearch: "native",
    webFetch: "degrade",
    mcpToolset: "native",
  },
  copilot: {
    sampling: "native",
    outputLength: "native",
    stopSequences: "degrade",
    thinkingBudget: "native",
    systemPrompt: "native",
    promptCache: "degrade",
    strictToolSchema: "native",
    toolChoiceForced: "native",
    structuredOutput: "native",
    webSearch: "native",
    webFetch: "degrade",
    mcpToolset: "native",
  },
}

/** The two evidence labels, written out so a third label added to the union fails a test. */
const EXPECTED_EVIDENCE_LABELS = ["measured", "unmeasured"] as const

type SetEquals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * Compile-time pin for the evidence vocabulary Property 3 quantifies over. A third
 * `FeatureEvidence` member — or the removal of one — makes this resolve to `false`, and `true` is
 * not assignable to `false`.
 */
const _FEATURE_EVIDENCE_UNION_IS_THE_TWO: SetEquals<FeatureEvidence, (typeof EXPECTED_EVIDENCE_LABELS)[number]> = true

type Deviation =
  | { kind: "missing"; key: string }
  | { kind: "extra"; key: string }
  | { kind: "value"; key: string; value: unknown }

/**
 * Every way a declared map deviates from "total over `PROVIDER_FEATURES`, values inside `allowed`".
 *
 * Collects rather than short-circuits, so a failure names which of the three ways the declaration
 * is wrong, and a map wrong three ways yields three deviations instead of hiding two.
 */
function deviations(map: Readonly<Record<string, unknown>>, allowed: readonly string[]): Deviation[] {
  const found: Deviation[] = []

  for (const feature of PROVIDER_FEATURES) {
    if (!Object.hasOwn(map, feature)) {
      found.push({ kind: "missing", key: feature })
      continue
    }
    const value = map[feature]
    if (typeof value !== "string" || !allowed.includes(value)) {
      found.push({ kind: "value", key: feature, value })
    }
  }

  const known: readonly string[] = PROVIDER_FEATURES
  for (const key of Object.keys(map)) {
    if (!known.includes(key)) found.push({ kind: "extra", key })
  }

  return found
}

const upstreamArb = fc.constantFrom(...UPSTREAM_CAPABILITY_MODULES)
const featureArb = fc.constantFrom(...PROVIDER_FEATURES)
const policyArb = fc.constantFrom(...FEATURE_POLICIES)

/** The open half of Property 1: any string that is not one of the 12 feature names. */
const foreignKeyArb = fc
  .string({ minLength: 1, maxLength: 32 })
  .filter((key) => !(PROVIDER_FEATURES as readonly string[]).includes(key))

const nonPolicyArb = fc
  .string({ maxLength: 24 })
  .filter((value) => !(FEATURE_POLICIES as readonly string[]).includes(value))

const nonEvidenceArb = fc
  .string({ maxLength: 24 })
  .filter((value) => !(EXPECTED_EVIDENCE_LABELS as readonly string[]).includes(value))

describe("per-upstream capability matrix properties", () => {
  /**
   * Feature: native-api-mode, Property 1: Capability matrix totality — per upstream, every
   * `ProviderFeature` key is present, every value is one of the four `FeaturePolicy` members, and
   * no declared key falls outside `PROVIDER_FEATURES`.
   *
   * The closed 3 × 12 domain is enumerated; the foreign-key clause is generated, because it
   * quantifies over all strings rather than over the 12.
   *
   * **Validates: Requirements 2.1, 2.5, 29.1**
   */
  test("Feature: native-api-mode, Property 1: Capability matrix totality (per upstream)", () => {
    // Every declared upstream is walked. If the table were ever emptied by a bad refactor the
    // assertions below would all vacuously pass, so the walk is bounded from beneath first.
    expect(UPSTREAM_CAPABILITY_MODULES.length).toBeGreaterThanOrEqual(3)
    expect(new Set(UPSTREAM_CAPABILITY_MODULES.map((entry) => entry.upstream)).size).toBe(
      UPSTREAM_CAPABILITY_MODULES.length,
    )

    for (const { upstream, capabilities } of UPSTREAM_CAPABILITY_MODULES) {
      const features: Readonly<Record<string, unknown>> = capabilities.features

      // Exhaustive over the closed feature set: present, and one of four.
      expect(deviations(features, FEATURE_POLICIES), `${upstream} features`).toEqual([])
      expect(Object.keys(features).sort(), `${upstream} key set`).toEqual([...PROVIDER_FEATURES].sort())
      expect(Object.keys(features), `${upstream} key count`).toHaveLength(PROVIDER_FEATURES.length)

      for (const feature of PROVIDER_FEATURES) {
        expect(Object.hasOwn(features, feature), `${upstream}.${feature} present`).toBe(true)
        // Read through the `unknown`-valued alias on purpose: this is the check that would still
        // bite on a value that reached the map from outside the compiler's view.
        expect(FEATURE_POLICIES as readonly unknown[], `${upstream}.${feature} policy`).toContain(features[feature])
      }
    }

    // The open clause: no key outside `PROVIDER_FEATURES` is declared, for any string at all.
    fc.assert(
      fc.property(upstreamArb, foreignKeyArb, ({ upstream, capabilities }, foreign) => {
        const features: Readonly<Record<string, unknown>> = capabilities.features
        expect(Object.hasOwn(features, foreign), `${upstream} declares foreign key ${foreign}`).toBe(false)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * Feature: native-api-mode, Property 1: Capability matrix totality — the checker is shown to bite
   * on the shipped declarations, not only on synthetic maps.
   *
   * Each real matrix is perturbed one way at a time across generated choices. Without this, an
   * exhaustive walk that always returned no deviations would still pass the case above.
   *
   * **Validates: Requirements 2.1, 2.5**
   */
  test("Feature: native-api-mode, Property 1: a perturbed upstream matrix is detected and named", () => {
    // Dropping any one feature from any real matrix is reported as exactly that key missing.
    fc.assert(
      fc.property(upstreamArb, featureArb, ({ capabilities }, dropped) => {
        const partial: Record<string, unknown> = { ...capabilities.features }
        delete partial[dropped]

        const found = deviations(partial, FEATURE_POLICIES)
        expect(found).toEqual([{ kind: "missing", key: dropped }])
      }),
      { numRuns: 100 },
    )

    // A key outside the vocabulary is reported, whatever policy it carries.
    fc.assert(
      fc.property(upstreamArb, foreignKeyArb, policyArb, ({ capabilities }, foreign, policy) => {
        const found = deviations({ ...capabilities.features, [foreign]: policy }, FEATURE_POLICIES)
        expect(found).toEqual([{ kind: "extra", key: foreign }])
      }),
      { numRuns: 100 },
    )

    // A fifth policy value is reported at the feature it sits on. There is no fifth path.
    fc.assert(
      fc.property(upstreamArb, featureArb, nonPolicyArb, ({ capabilities }, feature, value) => {
        const found = deviations({ ...capabilities.features, [feature]: value }, FEATURE_POLICIES)
        expect(found).toEqual([{ kind: "value", key: feature, value }])
      }),
      { numRuns: 100 },
    )
  })

  /**
   * Feature: native-api-mode, Property 3: Copilot evidence labelling is total — for any
   * `ProviderFeature`, the evidence map holds an entry equal to `measured` or `unmeasured`, so no
   * unmeasured cell can be read as measured through a missing entry.
   *
   * Totality and value-validity only. All 12 entries are `unmeasured` today, and that is
   * deliberately NOT asserted: Requirement 2.7 asks that an unmeasured cell be marked, and raising
   * one to `measured` alongside a Run_Record is the expected outcome, not a regression. A test
   * pinning uniformity would fail on the first honest measurement.
   *
   * **Validates: Requirements 2.7, 29.1**
   */
  test("Feature: native-api-mode, Property 3: Copilot evidence labelling is total", () => {
    const evidence: Readonly<Record<string, unknown>> = COPILOT_CAPABILITY_EVIDENCE

    // Closed 12-member domain, enumerated in both directions.
    expect(deviations(evidence, EXPECTED_EVIDENCE_LABELS)).toEqual([])
    expect(Object.keys(evidence).sort()).toEqual([...PROVIDER_FEATURES].sort())
    expect(Object.keys(evidence)).toHaveLength(PROVIDER_FEATURES.length)

    for (const feature of PROVIDER_FEATURES) {
      expect(Object.hasOwn(evidence, feature), `evidence for ${feature} present`).toBe(true)
      expect(EXPECTED_EVIDENCE_LABELS as readonly unknown[], `evidence for ${feature} label`).toContain(
        evidence[feature],
      )
    }

    // Every feature the matrix declares has an evidence entry — the two maps cover the same domain,
    // which is what makes "unmeasured" readable per cell rather than per file.
    expect(Object.keys(evidence).sort()).toEqual(Object.keys(COPILOT_CAPABILITIES.features).sort())

    // Open clause: no entry outside the vocabulary.
    fc.assert(
      fc.property(foreignKeyArb, (foreign) => {
        expect(Object.hasOwn(evidence, foreign)).toBe(false)
      }),
      { numRuns: 200 },
    )

    // The checker bites on this map too: a dropped entry or a third label is reported and named, so
    // the enumeration above is not passing on a checker that never fails.
    fc.assert(
      fc.property(featureArb, (dropped) => {
        const partial: Record<string, unknown> = { ...COPILOT_CAPABILITY_EVIDENCE }
        delete partial[dropped]
        expect(deviations(partial, EXPECTED_EVIDENCE_LABELS)).toEqual([{ kind: "missing", key: dropped }])
      }),
      { numRuns: 100 },
    )

    fc.assert(
      fc.property(featureArb, nonEvidenceArb, (feature, value) => {
        const mutated = { ...COPILOT_CAPABILITY_EVIDENCE, [feature]: value }
        expect(deviations(mutated, EXPECTED_EVIDENCE_LABELS)).toEqual([{ kind: "value", key: feature, value }])
      }),
      { numRuns: 100 },
    )

    // Keeps the compile-time evidence-vocabulary pin referenced and visible in the report.
    expect(_FEATURE_EVIDENCE_UNION_IS_THE_TWO).toBe(true)
  })

  /**
   * One test per cell (Requirement 29.1): 3 upstreams × 12 features = 36 named cases, each
   * asserting the declared policy against the hand-written expectation in
   * `DECLARED_POLICY_MATRIX`.
   *
   * **Validates: Requirements 2.1, 2.3, 2.4, 3.3, 29.1**
   */
  describe("declared policy per cell", () => {
    for (const { upstream, capabilities } of UPSTREAM_CAPABILITY_MODULES) {
      for (const feature of PROVIDER_FEATURES) {
        const expected = DECLARED_POLICY_MATRIX[upstream][feature]
        test(`${upstream} declares ${feature} as ${expected}`, () => {
          expect(capabilities.features[feature]).toBe(expected)
        })
      }
    }
  })

  /**
   * The two cells named in task 6.4, asserted on their own because each carries a specific
   * guarantee that a table row does not make legible.
   *
   * **Validates: Requirements 2.3, 2.4, 3.3**
   */
  describe("the two load-bearing cells", () => {
    /**
     * The cell the whole feature exists to fix. spike §4 measured
     * `inferenceConfig: {maxTokens: 4}` answered 200 and still streamed a 296-frame essay — the
     * field is accepted and discarded, and there is no wire field at all for temperature or topP,
     * which are what this cell covers since task 12b moved the output length limit to
     * `outputLength`. `reject` is the only value that does not misrepresent that: `native` would
     * claim the value is forwarded, `emulate` would claim the gateway reproduces it, and `degrade`
     * would claim changed-but-present semantics — which is true of the limit, and is why that one
     * is declared separately, but is not true of a control with nowhere to go. Requirements 2.3
     * and 3.3 fix it.
     */
    test("KIRO_CAPABILITIES.features.sampling is reject", () => {
      expect(KIRO_CAPABILITIES.features.sampling).toBe("reject")
    })

    /**
     * Requirement 2.4's preserve-current-behavior guarantee. `canonicalToCodexBody()` forwards a
     * client `mcp` toolset inside `request.tools` untouched and the upstream connects to the MCP
     * server itself, so Requirement 22.8 keeps Codex on zero emulation paths. Anything other than
     * `native` here would route existing working traffic through gateway emulation or a 400.
     */
    test("CODEX_CAPABILITIES.features.mcpToolset is native", () => {
      expect(CODEX_CAPABILITIES.features.mcpToolset).toBe("native")
    })
  })

  /**
   * `hostedTools`, name-free. The ten Responses type names and their per-type outcomes belong to
   * task 29.4 / Property 27 (`test/upstream/hosted-tools.property.test.ts`, the one test allowed to
   * know the cross-provider key set) — see the file header.
   *
   * Two claims are in scope here. Every declared value is one of the four `FeaturePolicy` members,
   * which is Property 1's own wording applied to the optional map. And the three modules declare
   * the same key set, which pins the decision behind Requirements 2.2 and 19.1: the list is
   * duplicated across three files on purpose so no Responses type name enters `src/core/`, and
   * duplication that drifts is worse than the coupling it avoided.
   *
   * **Validates: Requirements 2.1, 2.2**
   */
  test("declared hosted tool policies are valid and agree across upstreams", () => {
    const keySets: { upstream: string; keys: string[] }[] = []

    for (const { upstream, capabilities } of UPSTREAM_CAPABILITY_MODULES) {
      const hostedTools = capabilities.hostedTools
      // `hostedTools` is optional in `ProviderCapabilities` — an absent map resolves to a degrade
      // notice rather than a throw — so absence is legal and simply contributes no key set.
      if (hostedTools === undefined) continue

      const keys = Object.keys(hostedTools)
      expect(keys.length, `${upstream} hostedTools is non-empty`).toBeGreaterThan(0)
      for (const key of keys) {
        expect(key.length, `${upstream} hostedTools key is non-empty`).toBeGreaterThan(0)
        expect(FEATURE_POLICIES, `${upstream}.hostedTools.${key}`).toContain(hostedTools[key])
      }
      keySets.push({ upstream, keys: keys.sort() })
    }

    expect(keySets.length, "at least one upstream declares hostedTools").toBeGreaterThan(0)
    const reference = keySets[0]!
    for (const entry of keySets.slice(1)) {
      expect(entry.keys, `${entry.upstream} hostedTools key set matches ${reference.upstream}`).toEqual(reference.keys)
    }
  })
})
