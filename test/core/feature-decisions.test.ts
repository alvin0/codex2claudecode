import { describe, expect, test } from "bun:test"

import { FeatureDecisions } from "../../src/core/feature-decisions"
import type { DeclaredFeaturePolicies } from "../../src/core/feature-decisions"
import { isFeatureRejection, isNativeFeatureOutcome } from "../../src/core/feature-policy"
import type { FeaturePolicy, ProviderFeature } from "../../src/core/provider-capabilities"
import { PROVIDER_FEATURES } from "../../src/core/provider-capabilities"

/**
 * Unit coverage for the per-request outcome collector. Resolution itself is
 * covered by `feature-policy.test.ts`; what is asserted here is the bookkeeping
 * the collector adds — emission order, dedup by `(feature, detail)`, first
 * rejection, and the resolved-feature set the no-silent-drop walk compares
 * against.
 */
function declare(overrides: Partial<Record<ProviderFeature, FeaturePolicy>> = {}): DeclaredFeaturePolicies {
  const features = {} as Record<ProviderFeature, FeaturePolicy>
  for (const feature of PROVIDER_FEATURES) features[feature] = "native"
  return { ...features, ...overrides }
}

describe("FeatureDecisions.resolve", () => {
  test("a native declaration produces zero notices and no rejection", () => {
    const decisions = new FeatureDecisions(declare(), false)
    const outcome = decisions.resolve("sampling", "temperature forwarded as sent", "nothing")

    expect(isNativeFeatureOutcome(outcome)).toBe(true)
    expect(decisions.notices()).toEqual([])
    expect(decisions.firstRejection()).toBeUndefined()
    expect([...decisions.resolvedFeatures()]).toEqual(["sampling"])
  })

  test("a feature absent from the declaration rejects instead of forwarding silently", () => {
    // Only reachable if the matrix crossed a JSON boundary; the type system
    // requires every cell. A silent forward here would be the silent drop
    // Requirement 10.1 exists to remove.
    const decisions = new FeatureDecisions({} as DeclaredFeaturePolicies, false)
    const outcome = decisions.resolve("promptCache", "cache hint dropped", "an upstream with prompt caching")

    expect(isFeatureRejection(outcome)).toBe(true)
    expect(decisions.firstRejection()?.feature).toBe("promptCache")
    expect(decisions.resolvedFeatures().has("promptCache")).toBe(true)
  })

  test("an explicitly supplied policy is recorded like a declared one", () => {
    const decisions = new FeatureDecisions(declare(), false)
    const outcome = decisions.resolveWithPolicy("webSearch", "emulate", "run locally", "a native web search")

    expect(decisions.notices()).toEqual([{ feature: "webSearch", policy: "emulate", detail: "run locally" }])
    expect(outcome.kind).toBe("emulate")
  })
})

describe("FeatureDecisions.notices", () => {
  test("returns resolution order, not sorted and not reversed", () => {
    const decisions = new FeatureDecisions(
      declare({ structuredOutput: "emulate", toolChoiceForced: "degrade", sampling: "degrade" }),
      false,
    )
    decisions.resolve("structuredOutput", "emulated locally", "a native schema mode")
    decisions.resolve("toolChoiceForced", "forced choice relaxed to auto", "prompt instructions")
    decisions.resolve("sampling", "temperature not sent upstream", "an upstream that honours it")

    expect(decisions.notices().map((notice) => notice.feature)).toEqual([
      "structuredOutput",
      "toolChoiceForced",
      "sampling",
    ])
  })

  test("the same (feature, detail) pair twice collapses to one notice", () => {
    const decisions = new FeatureDecisions(declare({ toolChoiceForced: "degrade" }), false)
    decisions.resolve("toolChoiceForced", "forced choice relaxed to auto", "prompt instructions")
    decisions.resolve("toolChoiceForced", "forced choice relaxed to auto", "prompt instructions")

    expect(decisions.notices()).toHaveLength(1)
  })

  test("the same feature with different details keeps both, in first-seen order", () => {
    const decisions = new FeatureDecisions(declare({ toolChoiceForced: "degrade" }), false)
    decisions.resolve("toolChoiceForced", 'tool_choice "required" relaxed to auto', "prompt instructions")
    decisions.resolve("toolChoiceForced", "a named tool choice relaxed to auto", "prompt instructions")
    decisions.resolve("toolChoiceForced", 'tool_choice "required" relaxed to auto', "prompt instructions")

    expect(decisions.notices().map((notice) => notice.detail)).toEqual([
      'tool_choice "required" relaxed to auto',
      "a named tool choice relaxed to auto",
    ])
  })

  test("dedup keys cannot be forged by detail text", () => {
    const decisions = new FeatureDecisions(declare({ sampling: "degrade", promptCache: "degrade" }), false)
    decisions.resolve("sampling", "|promptCache", "another upstream")
    decisions.resolve("promptCache", "", "another upstream")

    expect(decisions.notices()).toHaveLength(2)
  })

  test("mutating a returned notice does not corrupt the record", () => {
    const decisions = new FeatureDecisions(declare({ sampling: "degrade" }), false)
    decisions.resolve("sampling", "temperature not sent upstream", "an upstream that honours it")

    const first = decisions.notices()
    first[0]!.detail = "tampered"

    expect(decisions.notices()[0]?.detail).toBe("temperature not sent upstream")
  })

  test("strict escalation moves a degrade out of notices and into the rejection", () => {
    const strict = new FeatureDecisions(declare({ sampling: "degrade" }), true)
    strict.resolve("sampling", "temperature not sent upstream", "an upstream that honours it")

    expect(strict.notices()).toEqual([])
    expect(strict.firstRejection()?.feature).toBe("sampling")
  })

  test("emulate notices survive strict mode", () => {
    const strict = new FeatureDecisions(declare({ structuredOutput: "emulate" }), true)
    strict.resolve("structuredOutput", "emulated locally", "a native schema mode")

    expect(strict.notices()).toHaveLength(1)
    expect(strict.firstRejection()).toBeUndefined()
  })
})

describe("FeatureDecisions.firstRejection", () => {
  test("keeps the first rejection and keeps recording afterwards", () => {
    const decisions = new FeatureDecisions(
      declare({ webFetch: "reject", mcpToolset: "reject", sampling: "degrade" }),
      false,
    )
    decisions.resolve("webFetch", "web_fetch is not available", "a client-side fetch tool")
    decisions.resolve("mcpToolset", "mcp servers are not available", "client-side tools")
    decisions.resolve("sampling", "temperature not sent upstream", "an upstream that honours it")

    expect(decisions.firstRejection()?.feature).toBe("webFetch")
    // Recording continued past the rejection: later features are still covered,
    // and a later notice is still collected.
    expect([...decisions.resolvedFeatures()]).toEqual(["webFetch", "mcpToolset", "sampling"])
    expect(decisions.notices().map((notice) => notice.feature)).toEqual(["sampling"])
  })

  test("the rejection message names the feature and an alternative", () => {
    const decisions = new FeatureDecisions(declare({ webFetch: "reject" }), false)
    decisions.resolve("webFetch", "web_fetch is not available", "a client-side fetch tool")

    const rejection = decisions.firstRejection()
    expect(rejection?.message).toContain("webFetch")
    expect(rejection?.message).toContain("a client-side fetch tool")
  })

  test("mutating a returned rejection does not corrupt the record", () => {
    const decisions = new FeatureDecisions(declare({ webFetch: "reject" }), false)
    decisions.resolve("webFetch", "web_fetch is not available", "a client-side fetch tool")

    const rejection = decisions.firstRejection()!
    rejection.message = "tampered"

    expect(decisions.firstRejection()?.message).not.toBe("tampered")
  })
})

describe("FeatureDecisions.resolvedFeatures", () => {
  test("every outcome kind counts as resolved", () => {
    const decisions = new FeatureDecisions(
      declare({
        sampling: "native",
        structuredOutput: "emulate",
        toolChoiceForced: "degrade",
        webFetch: "reject",
      }),
      false,
    )
    for (const feature of ["sampling", "structuredOutput", "toolChoiceForced", "webFetch"] as const) {
      decisions.resolve(feature, `${feature} handled`, "another upstream")
    }

    expect(decisions.resolvedFeatures()).toEqual(
      new Set<ProviderFeature>(["sampling", "structuredOutput", "toolChoiceForced", "webFetch"]),
    )
  })

  test("the set comparison names exactly the unresolved features", () => {
    const present = new Set<ProviderFeature>(["sampling", "stopSequences", "promptCache"])
    const decisions = new FeatureDecisions(declare({ sampling: "degrade" }), false)
    decisions.resolve("sampling", "temperature not sent upstream", "an upstream that honours it")

    const resolved = decisions.resolvedFeatures()
    const silentlyDropped = [...present].filter((feature) => !resolved.has(feature))
    expect(silentlyDropped).toEqual(["stopSequences", "promptCache"])
  })

  test("a returned set is a snapshot, unaffected by later resolution", () => {
    const decisions = new FeatureDecisions(declare(), false)
    decisions.resolve("sampling", "forwarded", "nothing")
    const snapshot = decisions.resolvedFeatures()
    decisions.resolve("promptCache", "forwarded", "nothing")

    expect(snapshot.has("promptCache")).toBe(false)
    expect(decisions.resolvedFeatures().has("promptCache")).toBe(true)
  })

  test("resolving the same feature twice is one member", () => {
    const decisions = new FeatureDecisions(declare({ sampling: "degrade" }), false)
    decisions.resolve("sampling", "first detail", "another upstream")
    decisions.resolve("sampling", "second detail", "another upstream")

    expect([...decisions.resolvedFeatures()]).toEqual(["sampling"])
    expect(decisions.notices()).toHaveLength(2)
  })

  test("a fresh collector has nothing recorded", () => {
    const decisions = new FeatureDecisions(declare(), false)
    expect(decisions.notices()).toEqual([])
    expect(decisions.firstRejection()).toBeUndefined()
    expect(decisions.resolvedFeatures().size).toBe(0)
  })
})
