import { describe, expect, test } from "bun:test"

import {
  FEATURE_OUTCOME_KINDS,
  featureOutcomeNotice,
  isFeatureRejection,
  isNativeFeatureOutcome,
  resolveFeature,
  resolveHostedToolPolicy,
} from "../../src/core/feature-policy"
import type { FeatureResolutionInput } from "../../src/core/feature-policy"
import type { FeaturePolicy } from "../../src/core/provider-capabilities"

/**
 * Unit coverage for the resolution choke point. The exhaustive totality
 * property (Property 4) and the strict-escalation property (Property 5) live in
 * `test/core/feature-policy.property.test.ts` and `test/core/strict.property.test.ts`.
 */
function input(policy: FeaturePolicy, strict = false): FeatureResolutionInput {
  return {
    feature: "sampling",
    policy,
    detail: "temperature was dropped because the endpoint has no field for it",
    alternative: "an upstream that honours sampling parameters",
    strict,
  }
}

describe("resolveFeature", () => {
  test("native forwards and reports nothing", () => {
    const outcome = resolveFeature(input("native"))
    expect(outcome.kind).toBe("native")
    expect(isNativeFeatureOutcome(outcome)).toBe(true)
    expect(featureOutcomeNotice(outcome)).toBeUndefined()
  })

  test("emulate carries one notice whose policy is emulate", () => {
    const outcome = resolveFeature(input("emulate"))
    expect(outcome.kind).toBe("emulate")
    expect(featureOutcomeNotice(outcome)).toEqual({
      feature: "sampling",
      policy: "emulate",
      detail: "temperature was dropped because the endpoint has no field for it",
    })
  })

  test("emulate is never escalated by strict", () => {
    expect(resolveFeature(input("emulate", true))).toEqual(resolveFeature(input("emulate", false)))
  })

  test("degrade carries a notice without strict and rejects with it", () => {
    const lenient = resolveFeature(input("degrade", false))
    expect(lenient.kind).toBe("degrade")
    expect(featureOutcomeNotice(lenient)?.policy).toBe("degrade")

    const strict = resolveFeature(input("degrade", true))
    expect(strict.kind).toBe("reject")
    expect(featureOutcomeNotice(strict)).toBeUndefined()
  })

  test("reject names the feature and the alternative, strict or not", () => {
    for (const strict of [false, true]) {
      const outcome = resolveFeature(input("reject", strict))
      if (!isFeatureRejection(outcome)) throw new Error("expected a rejection")
      expect(outcome.feature).toBe("sampling")
      expect(outcome.message).toContain("sampling")
      expect(outcome.message).toContain("an upstream that honours sampling parameters")
    }
  })

  test("a blank detail or alternative still produces non-empty text", () => {
    const notice = featureOutcomeNotice(resolveFeature({ ...input("degrade"), detail: "   " }))
    expect(notice?.detail.trim().length).toBeGreaterThan(0)

    const outcome = resolveFeature({ ...input("reject"), alternative: "" })
    if (!isFeatureRejection(outcome)) throw new Error("expected a rejection")
    expect(outcome.message).toContain("Use ")
    expect(outcome.message.trim().length).toBeGreaterThan(0)
  })

  test("an unrecognised policy resolves to a rejection rather than a throw", () => {
    const outcome = resolveFeature({ ...input("native"), policy: "sideways" as FeaturePolicy })
    expect(outcome.kind).toBe("reject")
    expect(FEATURE_OUTCOME_KINDS).toContain(outcome.kind)
  })
})

describe("resolveHostedToolPolicy", () => {
  test("returns the declared policy for a listed type", () => {
    expect(resolveHostedToolPolicy({ web_search: "emulate", file_search: "reject" }, "web_search")).toBe("emulate")
  })

  test("returns undefined for an absent type, an absent map, or an inherited key", () => {
    expect(resolveHostedToolPolicy({ web_search: "emulate" }, "code_interpreter")).toBeUndefined()
    expect(resolveHostedToolPolicy(undefined, "web_search")).toBeUndefined()
    expect(resolveHostedToolPolicy({}, "toString")).toBeUndefined()
    expect(resolveHostedToolPolicy({}, "constructor")).toBeUndefined()
  })

  test("a malformed cell reads as absent rather than as a policy", () => {
    const map = { web_search: "sideways" } as unknown as Record<string, FeaturePolicy>
    expect(resolveHostedToolPolicy(map, "web_search")).toBeUndefined()
  })
})
