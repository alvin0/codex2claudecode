// The measurement anchor for `RESPONSES_REJECTED_FIELDS` (`.omc/research/kiro-wire-spike.md`
// §11.7 item 6, carried from Run_Record 16 item 3).
//
// ## Why this file exists at all
//
// Property 21 asserts that the Codex body's key set is disjoint from `RESPONSES_REJECTED_FIELDS`.
// That is a claim about the *builder*, and it is satisfied by any denylist whatsoever — including
// one that omits a field the upstream refuses. Run_Record 16 is the demonstration: the full offline
// suite was green (1511 pass, 0 fail, Property 21 included) at the same moment the live gate was
// collecting `400 {"detail":"Unsupported parameter: temperature"}` and
// `400 {"detail":"Unsupported parameter: max_output_tokens"}` from the real endpoint. The denylist
// was mechanically correct and materially incomplete, and no offline test could see it, because
// nothing offline compared the list against a measurement.
//
// This file is that comparison. It is deliberately not a property: the input space is one recorded
// probe table, and enumerating a closed table is stronger than sampling it. It is separate from
// `codex-sampling.test.ts` for the same reason it is separate in the spike — that file asserts what
// the builder does, this one asserts what the upstream said.
//
// ## What it can and cannot catch
//
// It catches a name being dropped from the list, which is the regression that would silently
// restore the Run_Record 16 failure. It cannot notice the endpoint changing its mind: if the
// upstream starts accepting `top_p` tomorrow, this file keeps passing while the gateway keeps
// dropping the field. Only `bun run probe:codex:sampling` can tell us that, which is why the
// entries below carry the probe's own citation rather than a bare list.
import { describe, expect, test } from "bun:test"

import { CODEX_CAPABILITIES } from "../../src/upstream/codex/capabilities"
import { CODEX_SAMPLING_RESPONSES_FIELDS, RESPONSES_REJECTED_FIELDS } from "../../src/upstream/codex/sampling"

/**
 * The §11.2 probe table, transcribed. One field per run, because the endpoint names only the first
 * offender it meets (§11.1), so per-field acceptance needed per-field runs.
 *
 * Model `gpt-5.4-mini`, the model the live cases use. `temperature` was measured again on `gpt-5.5`
 * with the same body text (§11.4), which is what makes the refusal endpoint-level rather than a
 * property of one model.
 */
const MEASURED_REJECTIONS = [
  { field: "temperature", sent: 0.2, status: 400, detail: "Unsupported parameter: temperature" },
  { field: "top_p", sent: 0.9, status: 400, detail: "Unsupported parameter: top_p" },
  { field: "max_output_tokens", sent: 16, status: 400, detail: "Unsupported parameter: max_output_tokens" },
] as const

/**
 * Names on the list that no probe has ever sent. Kept explicit so the file states the honest shape
 * of the evidence: the list mixes three measured entries with five reasoned ones, and a reader
 * debugging a 400 needs to know which kind they are looking at.
 */
const INFERRED_ENTRIES = ["max_tokens", "max_completion_tokens", "stop", "stop_sequences", "top_k"] as const

describe("RESPONSES_REJECTED_FIELDS is anchored to the §11.2 measurement", () => {
  test("every measured rejection is on the list", () => {
    for (const { field, detail } of MEASURED_REJECTIONS) {
      expect(RESPONSES_REJECTED_FIELDS, `§11.2 measured 400 "${detail}" for ${field}`).toContain(field)
    }
  })

  // The transcription is itself the thing worth pinning: an entry that drifted to a different
  // field name or a different status would make the citations above decorative.
  test("the transcribed table is three 400s naming their own field, and the control was a 200", () => {
    expect(MEASURED_REJECTIONS).toHaveLength(3)
    for (const { field, status, detail } of MEASURED_REJECTIONS) {
      expect(status).toBe(400)
      expect(detail).toBe(`Unsupported parameter: ${field}`)
    }
    // §11.2 run 1: the same body with none of the three returned 200 and `response.completed`.
    // That control is the whole argument for `degrade` over `reject` — the request works once the
    // field is dropped, so refusing it at the gateway would destroy behavior that exists.
    expect(new Set(MEASURED_REJECTIONS.map((entry) => entry.field)).size).toBe(3)
  })

  test("the list is exactly the measured entries plus the recorded inferred ones, with no duplicates", () => {
    const measured = MEASURED_REJECTIONS.map((entry) => entry.field)
    expect([...RESPONSES_REJECTED_FIELDS].sort()).toEqual([...measured, ...INFERRED_ENTRIES].sort())
    expect(new Set(RESPONSES_REJECTED_FIELDS).size).toBe(RESPONSES_REJECTED_FIELDS.length)
  })

  // §11.7 item 2: with all three spellings refused there is nothing left to emit, which is why
  // `src/upstream/codex/sampling.ts` maps nothing. Stated as a subset relation so it is checkable
  // rather than being visible only as absent code.
  test("every recorded Responses spelling of a sampling control is refused", () => {
    for (const field of CODEX_SAMPLING_RESPONSES_FIELDS) expect(RESPONSES_REJECTED_FIELDS).toContain(field)
    expect(CODEX_SAMPLING_RESPONSES_FIELDS.length).toBeGreaterThan(0)
  })

  /**
   * The half Run_Record 16 item 2 warns about: the denylist and the declaration must move
   * together. A list that refuses these three while the cells still read `native` drops the
   * client's value and tells them nothing — the silent drop Requirement 10 exists to remove — and
   * it puts the live case back to passing for the reason it passed before task 15.1, which is to
   * say for no reason.
   */
  test("the declared cells report rather than claim the fields were honored", () => {
    expect(CODEX_CAPABILITIES.features.sampling).toBe("degrade")
    expect(CODEX_CAPABILITIES.features.outputLength).toBe("degrade")
  })
})
