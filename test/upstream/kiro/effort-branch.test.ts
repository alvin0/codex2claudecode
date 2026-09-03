// Feature: native-api-mode — task 22.3, the three branches of `resolveRequestedEffort()`.
//
// `effort.property.test.ts` asserts the invariants: whatever is sent is in the model's enum, and
// strict escalates the substitution and nothing else. This file asserts the three *named* cases
// task 22 changed, one test each, at the example level — the values a reader can check by eye:
//
//  1. `"ultra"` against `[low, medium, high, max]` sends `max` and reports both values
//     (Requirement 16.4).
//  2. A model publishing no effort enum, plus a client-stated effort, is a **notice, not a 400**
//     (Requirement 16.6's feature-gap half). This is the assertion that would have failed before
//     task 22.1, where the same input was a hard rejection.
//  3. Unloaded model metadata is still a 503 (Requirement 16.6's infrastructure half) — the one
//     outcome task 22 deliberately did not turn into a notice, because nothing is known about the
//     model's enum and so no substitution can be justified.
//
// The provider harness is `./effort-probe.ts`; only the transport is faked.
//
// _Requirements: 16.4, 16.6_

import { describe, expect, test } from "bun:test"

import { kiroEffortProbe } from "./effort-probe"

const KIRO_LEVELS = ["low", "medium", "high", "max"] as const

/** The notices a canonical result carried, whatever kind of result it is. */
function notices(result: Awaited<ReturnType<ReturnType<typeof kiroEffortProbe>["proxy"]>>) {
  return result.type === "canonical_response" || result.type === "canonical_error" ? result.featureNotices ?? [] : []
}

describe("Feature: native-api-mode, the effort handling branch degrades instead of refusing", () => {
  test("effort 'ultra' on a model with enum [low..max] sends 'max' and names both values", async () => {
    const probe = kiroEffortProbe({ levels: KIRO_LEVELS, defaultLevel: "medium" })

    const result = await probe.proxy("ultra")

    // Requirement 16.4 — answered, not refused, and the substituted level is the model's own
    // strongest: `"ultra"` carries no rank on the known ladder, so it rounds toward more
    // reasoning rather than less.
    expect(result.type).toBe("canonical_response")
    expect(probe.sentEffort()).toBe("max")
    expect(probe.upstreamCalls()).toBe(1)

    const [notice, ...rest] = notices(result)
    expect(rest).toEqual([])
    expect(notice).toMatchObject({ feature: "thinkingBudget", policy: "degrade" })
    // Both values, because either alone leaves the client guessing what its request became.
    expect(notice!.detail).toContain("ultra")
    expect(notice!.detail).toContain("max")
    expect(notice!.detail).toContain("low, medium, high, max")
  })

  test("a model that does not support effort, plus a client-stated effort, yields a notice rather than a 400", async () => {
    const probe = kiroEffortProbe({ levels: undefined })

    const result = await probe.proxy("high")

    // Requirement 16.6 — the request completes. Before task 22.1 this exact input was
    // `400 "does not support configurable effort"`, which refused a request the gateway could
    // serve simply by leaving the field off.
    expect(result.type).toBe("canonical_response")
    expect(probe.upstreamCalls()).toBe(1)
    // Nothing was substituted, because there is no enum to substitute from — so the payload
    // carries no effort at all, and the notice is what tells the client so.
    expect(probe.sentEffort()).toBeUndefined()

    const [notice, ...rest] = notices(result)
    expect(rest).toEqual([])
    expect(notice).toMatchObject({ feature: "thinkingBudget", policy: "degrade" })
    expect(notice!.detail).toContain("does not support configurable effort")
    expect(notice!.detail).toContain("high")
  })

  test("unloaded model metadata still yields 503, with no upstream call", async () => {
    const probe = kiroEffortProbe({ levels: KIRO_LEVELS, metadataUnavailable: true })

    const result = await probe.proxy("high")

    // Requirement 16.6 — infrastructure, not a feature gap: the enum is unknown, so no claim about
    // `"high"` is possible and there is nothing honest to substitute. The existing message stands.
    expect(result).toMatchObject({ type: "canonical_error", status: 503 })
    expect(result.type === "canonical_error" ? result.body : "").toContain("Unable to load Kiro model metadata")
    expect(probe.upstreamCalls()).toBe(0)
    expect(notices(result)).toEqual([])
  })

  test("a client that states nothing gets the model's published default, silently", async () => {
    const probe = kiroEffortProbe({ levels: KIRO_LEVELS, defaultLevel: "medium" })

    const result = await probe.proxy()

    // Requirement 16.1, and the rung that used to be unreachable on this upstream:
    // `resolveRequestedEffort()` returned before the descriptor was read whenever the client stated
    // neither a level nor a budget, so `selectEffortLevel()`'s model-default rung was never called
    // here. Measured on a live run: with one descriptor and one model, a stated level and a sent
    // budget both put a level on the payload while a stated-nothing request put none.
    expect(result.type).toBe("canonical_response")
    expect(probe.sentEffort()).toBe("medium")
    // Silent: the model's own default is not a substitution of anything the client asked for, so
    // there is nothing to report (unlike the budget rung, which changes a semantic).
    expect(notices(result)).toEqual([])
  })

  test("a model that publishes an enum but no default sends nothing when the client states nothing", async () => {
    const probe = kiroEffortProbe({ levels: KIRO_LEVELS })

    const result = await probe.proxy()

    // Requirement 16.2 — no default is nothing to say, not a level to invent.
    expect(result.type).toBe("canonical_response")
    expect(probe.sentEffort()).toBeUndefined()
    expect(notices(result)).toEqual([])
  })

  test("a model with no effort descriptor is sent no field, even now the default rung is reachable", async () => {
    // `levels: undefined` makes `additionalModelRequestFieldsSchema` **null** on the fake catalog
    // response — the measured live shape of a model that denies additional request fields, which the
    // registry reads as an answer and refuses to paper over with the bundled catalog. The two changes
    // have to be correct together: reaching the default rung must not start sending
    // `additionalModelRequestFields` to a model that answers 400 for that field.
    const probe = kiroEffortProbe({ levels: undefined })

    const result = await probe.proxy()

    expect(result.type).toBe("canonical_response")
    expect(probe.sentEffort()).toBeUndefined()
    expect(notices(result)).toEqual([])
  })

  test("thinking disabled outranks the model default and sends nothing", async () => {
    const probe = kiroEffortProbe({ levels: KIRO_LEVELS, defaultLevel: "medium" })

    const result = await probe.proxy(undefined, { mode: "disabled" })

    // Requirement 16.9 — `disabled` is a request for no reasoning, so it beats every source of a
    // level including the model's own default.
    expect(result.type).toBe("canonical_response")
    expect(probe.sentEffort()).toBeUndefined()
    expect(notices(result)).toEqual([])
  })

  test("an in-enum effort is sent as stated, silently", async () => {
    const probe = kiroEffortProbe({ levels: KIRO_LEVELS, schemaPath: "reasoning", defaultLevel: "medium" })

    const result = await probe.proxy("high")

    // The control for the three cases above: nothing was substituted, so nothing is reported
    // (Requirement 16.8's "zero notices" half), and the level rides the schema path the model
    // published rather than a fixed one.
    expect(result.type).toBe("canonical_response")
    expect(probe.sentEffort()).toBe("high")
    expect(notices(result)).toEqual([])
  })
})
