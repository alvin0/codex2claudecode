// Feature: native-api-mode — tasks 14b.7 and 14b.8, the two gaps that kept a Kiro 400 from being a
// complete account of what the request was refused over.
//
// Both were measured, not reviewed: `no-silent-drop`'s two failing assertions were
// `declared-outcome-stopSequences` and `declared-outcome-thinkingBudget`, identical from
// Run_Record 15 to Run_Record 56 — twelve runs. The live case sends `temperature`, `top_p`,
// `stop_sequences`, a `thinking.budget_tokens`, and a forced `tool_choice`, and read back a 400
// naming `sampling` alone with notices for `outputLength` and `toolChoiceForced`.
//
//  (a) `thinkingBudget` was decided inside `resolveRequestedEffort()`, which runs in `generate()` —
//      after the rejection bail — so it could not reach the notice list on a rejected request
//      however the effort branch was written. Closed by deciding it before the report is built.
//  (b) `stopSequences` was never named, because the body came from `firstRejection()` and
//      `stopSequences` resolves after `sampling`. Closed by reporting every rejection.
//
// The property form of (b) over all three upstreams is `test/upstream/reject-report.property.test.ts`
// (Property 42). This file is the example form, on the values a reader can check by eye, plus the
// two "changes nothing" halves that keep Requirement 10.12 true: a request rejected over one field
// is byte-identical to what it was, and a rejected request that stated no effort intent does not
// even read the model catalog.
//
// _Requirements: 10.3, 10.11, 10.12, 16.7_
import { describe, expect, test } from "bun:test"

import type { Canonical_Request } from "../../../src/core/canonical"
import { KIRO_CAPABILITIES } from "../../../src/upstream/kiro/capabilities"
import { kiroEffortProbe } from "./effort-probe"

const KIRO_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const

/** `temperature` alone: the one field of the live case that produces the rejection it dies on. */
const REJECTS_ON_SAMPLING: Partial<Canonical_Request> = { sampling: { temperature: 0.3 } }

/** The live `no-silent-drop` body in canonical terms, minus the thinking member the probe supplies. */
const NO_SILENT_DROP_FIELDS: Partial<Canonical_Request> = {
  // `maxOutputTokens` is present because `max_tokens` is mandatory in the Claude Messages API, so
  // every live request carries it and the `outputLength` degrade is part of what a 400 must report.
  sampling: { maxOutputTokens: 256, temperature: 0.3, topP: 0.8, stopSequences: ["STOP"] },
  toolChoice: "required",
  tools: [{ type: "function", name: "noop", parameters: { type: "object", properties: {} } }],
}

function errorOf(result: Awaited<ReturnType<ReturnType<typeof kiroEffortProbe>["proxy"]>>) {
  if (result.type !== "canonical_error") throw new Error(`expected a canonical_error, got ${result.type}`)
  return result
}

describe("Feature: native-api-mode, a Kiro rejection is a complete account of the request", () => {
  test("the live no-silent-drop request yields one 400 naming the rejected feature and reporting every degrade", async () => {
    // The declarations this case rests on, read rather than assumed. `stopSequences` was the second
    // `reject` cell this request reached until it moved to `degrade`; it is asserted here in its new
    // position because the move is what turned it from part of the 400's body into part of its
    // notice list, and a move back has to come through this line.
    expect(KIRO_CAPABILITIES.features.sampling).toBe("reject")
    expect(KIRO_CAPABILITIES.features.stopSequences).toBe("degrade")
    expect(KIRO_CAPABILITIES.features.thinkingBudget).toBe("degrade")
    expect(KIRO_CAPABILITIES.features.toolChoiceForced).toBe("degrade")

    const probe = kiroEffortProbe({ levels: KIRO_LEVELS, defaultLevel: "medium" })
    const error = errorOf(await probe.proxy(undefined, { mode: "enabled", budgetTokens: 4000 }, NO_SILENT_DROP_FIELDS))

    // One 400, and the feature that causes it is unchanged: `sampling` resolves first, so its
    // message still leads (task 14b.7 changes what the message *continues with*, not its head).
    expect(error.status).toBe(400)
    expect(error.body.startsWith("This upstream does not support sampling:")).toBe(true)
    // One rejection now, so no continuation — the multi-rejection body of gap (b) is exercised by
    // the strict case below rather than dropped.
    expect(error.body).not.toContain("also rejected")
    // Gap (a): the feature decided inside the effort resolver is on the notice list too, so the
    // client learns what happened to its thinking budget from the same response. `stopSequences`
    // joins it in matrix order — the stop strings went nowhere, and the client is told rather than
    // refused.
    expect(error.featureNotices?.map((notice) => notice.feature)).toEqual(["outputLength", "stopSequences", "toolChoiceForced", "thinkingBudget"])
    const budgetNotice = error.featureNotices?.find((notice) => notice.feature === "thinkingBudget")
    expect(budgetNotice?.policy).toBe("degrade")
    // Both sides of the mapping, exactly as on a 200 (Requirement 16.7): 4000 sits between low
    // 4000 and medium 8000, so it lands on `low` and says so.
    expect(budgetNotice?.detail).toContain("4000")
    expect(budgetNotice?.detail).toContain("low")
    // A refused request still spends nothing upstream.
    expect(probe.upstreamCalls()).toBe(0)
  })

  /**
   * Gap (b) in example form, kept alive after `stopSequences` moved to `degrade`.
   *
   * Under `NATIVE_STRICT` every degrade escalates, so the same live body reaches several rejections
   * again — which is what the continuation clause was written for. The unstrict case above no
   * longer produces one, so without this the "every rejected feature is named" behavior would only
   * be covered by the property test.
   */
  test("under strict the same request names every rejected feature, not just the first", async () => {
    const probe = kiroEffortProbe({ levels: KIRO_LEVELS, defaultLevel: "medium", strict: true })
    const error = errorOf(await probe.proxy(undefined, { mode: "enabled", budgetTokens: 4000 }, NO_SILENT_DROP_FIELDS))

    expect(error.status).toBe(400)
    expect(error.body.startsWith("This upstream does not support sampling:")).toBe(true)
    expect(error.body).toContain("stopSequences")
    expect(error.body).toContain("stop-sequence field")
    expect(error.body).toContain("also rejected")
    expect(probe.upstreamCalls()).toBe(0)
  })

  test("a stated effort outside the model enum is reported on a 400 it did not cause", async () => {
    const probe = kiroEffortProbe({ levels: KIRO_LEVELS, defaultLevel: "medium" })
    const error = errorOf(await probe.proxy("ultra", undefined, REJECTS_ON_SAMPLING))

    // The substitution is a decision about a field the client sent, and it is reported even though
    // this request never reaches the wire — the notice says what the *request* decided, which is
    // what makes a 400's report readable as an account rather than as a description of a call.
    expect(error.status).toBe(400)
    expect(error.featureNotices?.map((notice) => notice.feature)).toEqual(["thinkingBudget"])
    expect(error.featureNotices?.[0]?.detail).toContain("ultra")
    expect(error.featureNotices?.[0]?.detail).toContain("max")
    expect(probe.upstreamCalls()).toBe(0)
  })

  test("one rejected feature and no effort intent is the 400 it always was, catalog untouched", async () => {
    const probe = kiroEffortProbe({ levels: KIRO_LEVELS, defaultLevel: "medium" })
    const error = errorOf(await probe.proxy(undefined, undefined, REJECTS_ON_SAMPLING))

    // Requirement 10.12 — one rejection, so the body is that rejection's message, whole, with no
    // continuation and no notice member.
    expect(error.status).toBe(400)
    expect(error.body.startsWith("This upstream does not support sampling:")).toBe(true)
    expect(error.body).not.toContain("also rejected")
    expect("featureNotices" in error).toBe(false)
    expect(Object.keys(error).sort()).toEqual(["body", "headers", "status", "type"])
    // And the deferred decision is guarded: no level, no budget, so there is no `thinkingBudget`
    // outcome to record and the refused request does not pay for a catalog read to discover that.
    expect(probe.metadataFetches()).toBe(0)
    expect(probe.upstreamCalls()).toBe(0)
  })

  test("a thinking budget beside `mode: disabled` is not an intent, so a rejection stays unchanged", async () => {
    const probe = kiroEffortProbe({ levels: KIRO_LEVELS, defaultLevel: "medium" })
    const error = errorOf(await probe.proxy(undefined, { mode: "disabled", budgetTokens: 4000 }, REJECTS_ON_SAMPLING))

    // Requirement 16.9 — a disabled thinking member asks for no reasoning at all, so its budget is
    // not consulted on this path either. Reporting a mapping that never happened would be worse
    // than silence.
    expect(error.status).toBe(400)
    expect("featureNotices" in error).toBe(false)
    expect(probe.metadataFetches()).toBe(0)
  })

  test("under NATIVE_STRICT an escalated degrade is a further rejection, never the cause", async () => {
    const probe = kiroEffortProbe({ levels: KIRO_LEVELS, defaultLevel: "medium", strict: true })
    const error = errorOf(await probe.proxy("ultra", undefined, REJECTS_ON_SAMPLING))

    // The deferred decision runs last, and `firstRejection()` is resolution-ordered, so strict mode
    // can add `thinkingBudget` to the report but cannot make it the head. `sampling` is still what
    // failed the request.
    expect(error.status).toBe(400)
    expect(error.body.startsWith("This upstream does not support sampling:")).toBe(true)
    expect(error.body).toContain("thinkingBudget")
    // Escalated, so it travels the 400 rather than the notice list (Requirement 8.6).
    expect("featureNotices" in error).toBe(false)
  })
})
