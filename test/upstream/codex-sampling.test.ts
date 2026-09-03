// Unit coverage for the Codex sampling wire boundary (task 15.1, corrected while closing task 15).
//
// Examples only. The generative half — one canonical sampling object diverging across the three
// upstreams — is Property 21 in `test/upstream/sampling.property.test.ts`, and the notice half is
// Property 22 in `test/upstream/sampling-divergence.property.test.ts`.
//
// ## What this file asserts now, and what it used to assert
//
// It used to pin a *mapping*: `maxOutputTokens → max_output_tokens`, `temperature → temperature`,
// `topP → top_p`, with those fields reaching the body. `.omc/research/kiro-wire-spike.md` §11.2
// sent each of the three to the endpoint one per run and measured
// `400 {"detail":"Unsupported parameter: <name>"}` for all three, against a 200 control run that
// carried none of them. So the claim is inverted, not weakened: the three Responses spellings are
// still *recorded* — they are what a Responses body would call these controls — and every one of
// them is on the denylist, so none reaches the wire. The anchor tying that denylist to the
// measurement lives in `test/upstream/codex-denylist.test.ts`.
import { describe, expect, test } from "bun:test"

import type { Canonical_Request } from "../../src/core/canonical"
import { canonicalToCodexBody } from "../../src/upstream/codex/parse"
import { CODEX_SAMPLING_RESPONSES_FIELDS, RESPONSES_REJECTED_FIELDS, omitResponsesRejectedFields } from "../../src/upstream/codex/sampling"

function canonicalRequest(overrides: Partial<Canonical_Request> = {}): Canonical_Request {
  return {
    model: "gpt-5.4",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
    ...overrides,
  }
}

describe("the recorded Responses spellings", () => {
  test("name all three canonical controls and nothing else", () => {
    expect([...CODEX_SAMPLING_RESPONSES_FIELDS]).toEqual(["max_output_tokens", "temperature", "top_p"])
  })

  // The whole design decision of §11.7 item 2 in one assertion: there is no emittable field left,
  // so the mapper emits nothing rather than emitting and then deleting.
  test("are all on the rejected list, so no sampling control has a wire target here", () => {
    for (const field of CODEX_SAMPLING_RESPONSES_FIELDS) {
      expect(RESPONSES_REJECTED_FIELDS).toContain(field)
    }
  })
})

describe("omitResponsesRejectedFields", () => {
  test("removes every recorded rejected field and keeps the rest untouched", () => {
    const rejected = Object.fromEntries(RESPONSES_REJECTED_FIELDS.map((field) => [field, 1]))

    expect(omitResponsesRejectedFields({ model: "gpt-5.4", store: false, ...rejected })).toEqual({ model: "gpt-5.4", store: false })
  })

  // Restated: `temperature` used to be the survivor in this fixture, chosen to show the filter
  // keeps a legitimate parameter. It is now itself a measured rejection (§11.2), so the survivors
  // are fields the endpoint really does take.
  test("leaves nested client payload alone — the denylist is about request parameters", () => {
    const body = { input: [{ role: "user", content: [{ type: "input_text", text: "stop" }] }], tools: [{ type: "function", name: "stop" }] }

    expect(omitResponsesRejectedFields(body)).toEqual(body)
  })

  test("keeps the sampling spellings out even when they arrive nested-adjacent at the top level", () => {
    const body = { model: "gpt-5.4", temperature: 0.4, top_p: 0.8, max_output_tokens: 512, input: [] }

    expect(omitResponsesRejectedFields(body)).toEqual({ model: "gpt-5.4", input: [] })
  })
})

describe("canonicalToCodexBody sampling", () => {
  // Restated from "carries the mapped Responses fields with the values the client sent". Same
  // request, opposite expectation, and the reason is the measurement rather than a preference:
  // sending these three is `400 Unsupported parameter` (§11.2), so the request that reaches the
  // upstream is the one without them. The client hears about it through the `degrade` notice
  // `resolveCodexFeatures()` emits, asserted in `test/upstream/features.test.ts`.
  test("carries none of the sampling spellings, because this endpoint refuses all three", () => {
    const body = canonicalToCodexBody(canonicalRequest({ sampling: { maxOutputTokens: 512, temperature: 0.4, topP: 0.8 } }))

    for (const field of CODEX_SAMPLING_RESPONSES_FIELDS) expect(field in body).toBe(false)
    // Anti-vacuity: the body was really built, it is not empty.
    expect(body.model).toBe("gpt-5.4")
    expect(body.input).toBeDefined()
  })

  test("emits no field the Responses API rejects, for any canonical sampling input", () => {
    const body = canonicalToCodexBody(
      canonicalRequest({ sampling: { maxOutputTokens: 512, temperature: 0.4, topP: 0.8, stopSequences: ["STOP"] } }),
    )

    for (const field of RESPONSES_REJECTED_FIELDS) {
      expect(field in body).toBe(false)
    }
  })

  test("builds the same body whether or not the request carried a sampling member", () => {
    const withSampling = canonicalToCodexBody(canonicalRequest({ sampling: { maxOutputTokens: 256, temperature: 0, topP: 0 } }))
    const without = canonicalToCodexBody(canonicalRequest())

    // Byte-equal, which is the strongest form of "the sampling member reaches this wire in no
    // way at all" — including the zero values a truthiness filter would have dropped anyway.
    expect(withSampling).toEqual(without)
  })

  test("adds no sampling key to a request that carries none", () => {
    const body = canonicalToCodexBody(canonicalRequest())

    expect("max_output_tokens" in body).toBe(false)
    expect("temperature" in body).toBe(false)
    expect("top_p" in body).toBe(false)
  })
})
