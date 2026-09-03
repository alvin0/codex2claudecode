// Feature: native-api-mode, task 15.3 — canonical sampling → Copilot Responses fields.
//
// Requirement 26.9 makes this upstream declaration-only, so these are unit tests and there is no
// live case. What they can check is exactly what `./capabilities.ts` claims: the body this
// repository emits for a given canonical request. Nothing here says what GitHub's endpoint does
// with that body.
//
// The spellings are the point. `Copilot_Client.proxy()` posts to `/responses`, so a chat-completions
// `max_tokens` would be an unknown parameter — the assertions below pin `max_output_tokens` and pin
// the absence of `max_tokens` and `stop` so a future edit cannot quietly reintroduce either.
import { describe, expect, test } from "bun:test"

import type { Canonical_Request } from "../../../src/core/canonical"
import { COPILOT_SAMPLING_DROPPED_FIELDS, COPILOT_SAMPLING_RESPONSES_FIELDS, copilotSamplingFields } from "../../../src/upstream/copilot/sampling"
import { buildCopilotResponsesBody } from "../../../src/upstream/copilot/parse"

function request(sampling?: Canonical_Request["sampling"]): Canonical_Request {
  return {
    model: "gpt-5",
    input: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
    ...(sampling ? { sampling } : {}),
  }
}

describe("copilotSamplingFields", () => {
  test("maps every canonical control to its Responses spelling", () => {
    expect(copilotSamplingFields({ maxOutputTokens: 512, temperature: 0.25, topP: 0.9 })).toEqual({
      max_output_tokens: 512,
      temperature: 0.25,
      top_p: 0.9,
    })
  })

  test("emits nothing for a request that asked for nothing", () => {
    expect(copilotSamplingFields(undefined)).toEqual({})
    expect(copilotSamplingFields({})).toEqual({})
  })

  test("omits an absent control rather than emitting an undefined key", () => {
    const fields = copilotSamplingFields({ temperature: 0 })
    expect(fields).toEqual({ temperature: 0 })
    expect(Object.hasOwn(fields, "max_output_tokens")).toBe(false)
    expect(Object.hasOwn(fields, "top_p")).toBe(false)
  })

  test("drops stopSequences, for which the Responses API has no field", () => {
    const fields = copilotSamplingFields({ stopSequences: ["STOP", "\n\n"], temperature: 1 })
    expect(fields).toEqual({ temperature: 1 })
    expect(Object.hasOwn(fields, "stop")).toBe(false)
    expect(Object.hasOwn(fields, "stop_sequences")).toBe(false)
    expect(COPILOT_SAMPLING_DROPPED_FIELDS).toEqual(["stopSequences"])
  })

  test("forwards a value as sent rather than clamping it", () => {
    expect(copilotSamplingFields({ temperature: -3, topP: 12, maxOutputTokens: 0 })).toEqual({
      temperature: -3,
      top_p: 12,
      max_output_tokens: 0,
    })
  })

  test("records the field names it can emit", () => {
    expect([...COPILOT_SAMPLING_RESPONSES_FIELDS]).toEqual(["max_output_tokens", "temperature", "top_p"])
  })
})

describe("buildCopilotResponsesBody with sampling", () => {
  test("carries the mapped Responses fields and never the chat-completions spelling", () => {
    const body = buildCopilotResponsesBody(request({ maxOutputTokens: 1024, temperature: 0.5, topP: 0.1, stopSequences: ["END"] }))
    expect(body.max_output_tokens).toBe(1024)
    expect(body.temperature).toBe(0.5)
    expect(body.top_p).toBe(0.1)
    expect(Object.hasOwn(body, "max_tokens")).toBe(false)
    expect(Object.hasOwn(body, "stop")).toBe(false)
  })

  test("adds no sampling key when the request carries no sampling member", () => {
    const body = buildCopilotResponsesBody(request())
    for (const field of COPILOT_SAMPLING_RESPONSES_FIELDS) {
      expect(Object.hasOwn(body, field)).toBe(false)
    }
  })

  test("leaves the rest of the body untouched", () => {
    const withSampling = buildCopilotResponsesBody(request({ temperature: 0.7 }))
    const withoutSampling = buildCopilotResponsesBody(request())
    const { temperature, ...rest } = withSampling as Record<string, unknown>
    expect(temperature).toBe(0.7)
    expect(rest).toEqual(withoutSampling as Record<string, unknown>)
  })
})
