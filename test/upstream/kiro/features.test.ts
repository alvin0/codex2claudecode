import { describe, expect, test } from "bun:test"

import type { Canonical_Event, Canonical_FeatureNotice, Canonical_Request, Canonical_Response, Canonical_StreamResponse } from "../../../src/core/canonical"
import type { ProviderFeature } from "../../../src/core/provider-capabilities"
import { KIRO_CAPABILITIES } from "../../../src/upstream/kiro/capabilities"
import { withKiroFeatureNotices } from "../../../src/upstream/kiro/feature-notices"
import { resolveKiroFeatures } from "../../../src/upstream/kiro/features"
import { Kiro_Auth_Manager, Kiro_Client, Kiro_Upstream_Provider } from "../../../src/upstream/kiro"
import { canonicalResponseToClaudeMessage } from "../../../src/inbound/claude/response"
import type { ClaudeMessagesRequest } from "../../../src/inbound/types"

/**
 * Unit coverage for task 10.3: the Kiro matrix application and the two delivery paths.
 *
 * Numbered properties for feature resolution live in `test/core/feature-policy.property.test.ts`
 * and the cross-upstream matrix walk in the no-silent-drop test (tasks 10.5 and 10.6). This file
 * stays at the example level: which request shapes this upstream detects, what each one is told,
 * and where the notices land.
 */

/**
 * The canonical members task 14 adds. Spelled here for the same reason `features.ts` reads them
 * defensively: the resolutions for sampling, stop sequences, and prompt cache must be exercised
 * before the contract carries them, or they would ship untested.
 */
type FutureRequest = Canonical_Request & {
  sampling?: { maxOutputTokens?: number; temperature?: number; topP?: number; stopSequences?: string[] }
  cacheHint?: Array<{ scope?: string; ttl?: string }>
}

function request(overrides: Partial<FutureRequest> = {}): Canonical_Request {
  return {
    model: "claude-sonnet-4-5",
    instructions: "Be helpful",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
    ...overrides,
  } as Canonical_Request
}

function features(overrides: Partial<FutureRequest> = {}, strict = false) {
  return resolveKiroFeatures(request(overrides), { strict })
}

function noticeFeatures(notices: readonly Canonical_FeatureNotice[]) {
  return notices.map((notice) => notice.feature)
}

function auth() {
  return new Kiro_Auth_Manager({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: new Date(Date.now() + 700_000).toISOString(),
    region: "us-east-1",
  }, "/tmp/unused")
}

function provider(onBody?: (body: unknown) => void) {
  const manager = auth()
  const client = new Kiro_Client(manager, {
    fetch: ((_url: string, init?: { body?: string }) => {
      if (init?.body) onBody?.(JSON.parse(init.body))
      return Promise.resolve(new Response('{"content":"ok"}'))
    }) as unknown as typeof fetch,
  })
  return new Kiro_Upstream_Provider({ auth: manager, client })
}

describe("Kiro feature resolution", () => {
  test("a request carrying none of the six covered features resolves nothing", () => {
    const decisions = features()

    expect(decisions.notices()).toEqual([])
    expect(decisions.firstRejection()).toBeUndefined()
    expect([...decisions.resolvedFeatures()]).toEqual([])
  })

  test("`required` tool choice degrades and says the tool list was left whole", () => {
    const decisions = features({ toolChoice: "required" })

    expect(decisions.firstRejection()).toBeUndefined()
    expect(decisions.notices()).toHaveLength(1)
    const [notice] = decisions.notices()
    expect(notice.feature).toBe("toolChoiceForced")
    expect(notice.policy).toBe("degrade")
    expect(notice.detail).toContain("every tool stayed available")
  })

  test.each([
    ["direct name", { type: "function", name: "save" }],
    ["nested function name", { type: "function", function: { name: "save" } }],
  ])("a named tool choice (%s) degrades and names the tool it narrowed to", (_label, toolChoice) => {
    const [notice, ...rest] = features({ toolChoice }).notices()

    expect(rest).toEqual([])
    expect(notice).toMatchObject({ feature: "toolChoiceForced", policy: "degrade" })
    expect(notice.detail).toContain("'save'")
  })

  test("`none` and `auto` tool choices are honored as sent, so nothing is reported", () => {
    expect(features({ toolChoice: "none" }).notices()).toEqual([])
    expect(features({ toolChoice: "auto" }).notices()).toEqual([])
    expect(features({}).notices()).toEqual([])
  })

  test("structured output emulates with a notice the client never sees rendered", () => {
    const [notice, ...rest] = features({ textFormat: { name: "invoice", schema: { type: "object" } } }).notices()

    expect(rest).toEqual([])
    expect(notice).toMatchObject({ feature: "structuredOutput", policy: "emulate" })
    expect(notice.detail.length).toBeGreaterThan(0)
  })

  test("a tool schema that closes its shape degrades; an open one does not", () => {
    const closed = features({ tools: [{ type: "function", name: "save", parameters: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false } }] })
    expect(noticeFeatures(closed.notices())).toEqual(["strictToolSchema"])

    const nested = features({ tools: [{ type: "function", name: "save", parameters: { type: "object", properties: { a: { type: "object", additionalProperties: false } } } }] })
    expect(noticeFeatures(nested.notices())).toEqual(["strictToolSchema"])

    const flagged = features({ tools: [{ type: "function", name: "save", strict: true, parameters: { type: "object" } }] })
    expect(noticeFeatures(flagged.notices())).toEqual(["strictToolSchema"])

    // `additionalProperties: true` restates the JSON Schema default, so stripping it is a
    // non-event and must not produce a notice.
    const open = features({ tools: [{ type: "function", name: "save", strict: false, parameters: { type: "object", additionalProperties: true } }] })
    expect(open.notices()).toEqual([])
  })

  test("sampling, stop sequences, and prompt cache reject, naming the feature and an alternative", () => {
    const cases: Array<[ProviderFeature, Partial<FutureRequest>]> = [
      ["sampling", { sampling: { temperature: 0.2 } }],
      ["stopSequences", { sampling: { stopSequences: ["STOP"] } }],
      ["promptCache", { cacheHint: [{ scope: "system" }] }],
    ]
    for (const [feature, overrides] of cases) {
      const rejection = features(overrides).firstRejection()
      expect(rejection?.feature).toBe(feature)
      expect(rejection?.message).toContain(feature)
      expect(rejection?.message).toMatch(/Use .+ instead\./)
    }
  })

  test("a rejection names every generation control that was requested", () => {
    const rejection = features({ sampling: { temperature: 0.2, topP: 0.9, maxOutputTokens: 64 } }).firstRejection()

    expect(rejection?.message).toContain("temperature, top-p and output length limit")
  })

  test("resolution continues past a rejection, so the resolved set stays complete", () => {
    const decisions = features({
      sampling: { temperature: 0.2, stopSequences: ["STOP"] },
      cacheHint: [{ scope: "system" }],
      toolChoice: "required",
      textFormat: { name: "invoice" },
    })

    expect([...decisions.resolvedFeatures()]).toEqual(["sampling", "stopSequences", "promptCache", "toolChoiceForced", "structuredOutput"])
    // The first rejection in matrix order wins, so one request yields one stable 400.
    expect(decisions.firstRejection()?.feature).toBe("sampling")
    expect(noticeFeatures(decisions.notices())).toEqual(["toolChoiceForced", "structuredOutput"])
  })

  test("strict escalates the declared degrade to a rejection and leaves emulation alone", () => {
    const strict = features({ toolChoice: "required", textFormat: { name: "invoice" } }, true)

    expect(KIRO_CAPABILITIES.features.toolChoiceForced).not.toBe(KIRO_CAPABILITIES.features.structuredOutput)
    expect(strict.firstRejection()?.feature).toBe("toolChoiceForced")
    expect(noticeFeatures(strict.notices())).toEqual(["structuredOutput"])
  })
})

describe("Kiro feature notice delivery", () => {
  const notice: Canonical_FeatureNotice = { feature: "toolChoiceForced", policy: "degrade", detail: "narrowed" }

  const response: Canonical_Response = {
    type: "canonical_response",
    id: "resp_1",
    model: "claude-sonnet-4-5",
    stopReason: "end_turn",
    content: [{ type: "text", text: "Here is the answer." }],
    usage: { inputTokens: 1, outputTokens: 1 },
  }

  function stream(events: Canonical_Event[]): Canonical_StreamResponse {
    return {
      type: "canonical_stream",
      status: 200,
      id: "resp_1",
      model: "claude-sonnet-4-5",
      events: { async *[Symbol.asyncIterator]() { yield* events } },
    }
  }

  test("an empty notice list leaves the result untouched, field absence included", () => {
    const result = withKiroFeatureNotices(response, [])

    expect(result).toBe(response)
    expect("featureNotices" in result).toBe(false)
  })

  test("non-streaming notices land on featureNotices, ahead of anything the parser collected", () => {
    const collected: Canonical_FeatureNotice = { feature: "webSearch", policy: "emulate", detail: "gateway executed the search" }
    const result = withKiroFeatureNotices({ ...response, featureNotices: [collected] }, [notice])

    expect(result.type).toBe("canonical_response")
    if (result.type !== "canonical_response") return
    expect(result.featureNotices).toEqual([notice, collected])
  })

  test("streaming notices are yielded before the upstream content", async () => {
    const result = withKiroFeatureNotices(stream([{ type: "text_delta", delta: "hi" }]), [notice])

    expect(result.type).toBe("canonical_stream")
    if (result.type !== "canonical_stream") return
    const events: Canonical_Event[] = []
    for await (const event of result.events) events.push(event)
    expect(events).toEqual([
      { type: "feature_notice", feature: "toolChoiceForced", policy: "degrade", detail: "narrowed" },
      { type: "text_delta", delta: "hi" },
    ])
  })

  test("errors and passthrough results are returned unchanged", () => {
    const error = { type: "canonical_error", status: 400, headers: new Headers(), body: "no" } as const
    expect(withKiroFeatureNotices(error, [notice])).toBe(error)
  })
})

describe("Kiro structured output emulation is unchanged by its notice", () => {
  const textFormat = { name: "invoice", schema: { type: "object", properties: { total: { type: "number" } } } }

  test("the schema still reaches the model as prompt text, and the reply carries no visible warning", async () => {
    let payload: any
    const result = await provider((body) => { payload = body }).proxy(request({ textFormat, tools: [] }))

    expect(result.type).toBe("canonical_response")
    if (result.type !== "canonical_response") return

    // The emulation itself: the instruction text and the serialized schema, exactly as before.
    const serialized = JSON.stringify(payload)
    expect(serialized).toContain("Structured output requested (invoice)")
    expect(serialized).toContain("Kiro does not support native structured output, so emulate it exactly")
    expect(serialized).toContain(JSON.stringify(textFormat.schema).replaceAll('"', '\\"'))

    // The notice exists for telemetry only (Requirement 10.7): the emulate policy renders as
    // nothing, so the client-visible content is identical to the un-noticed rendering.
    expect(result.featureNotices).toEqual([{ feature: "structuredOutput", policy: "emulate", detail: expect.any(String) }])
    const claudeRequest = { model: "claude-sonnet-4-5", messages: [] } as unknown as ClaudeMessagesRequest
    const withNotice = await canonicalResponseToClaudeMessage(result, claudeRequest)
    const withoutNotice = await canonicalResponseToClaudeMessage({ ...result, featureNotices: undefined }, claudeRequest)
    expect(withNotice.content).toEqual(withoutNotice.content)
  })
})
