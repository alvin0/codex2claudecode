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
 * defensively: the resolutions for sampling, output length, stop sequences, and prompt cache must
 * be exercised before the contract carries them, or they would ship untested.
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
  test("a request carrying none of the seven covered features resolves nothing", () => {
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

  test("sampling rejects, naming the feature and an alternative", () => {
    const cases: Array<[ProviderFeature, Partial<FutureRequest>]> = [
      ["sampling", { sampling: { temperature: 0.2 } }],
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

    // `maxOutputTokens` is deliberately not in this list. It is its own feature since task 12b, so
    // the `sampling` rejection accounts for the two controls that have nowhere to go on this
    // endpoint and nothing else — a message naming the limit here would describe a field that no
    // longer routes through this cell.
    expect(rejection?.message).toContain("temperature and top-p")
  })

  /**
   * The counterpart to the assertion above, and the reason task 12b split the feature: an output
   * length limit on its own is **reported**, not refused.
   *
   * Load-bearing rather than decorative — `max_tokens` is mandatory in the Claude Messages API, so
   * once task 14 maps it into canonical, this is the shape of every ordinary Claude→Kiro request.
   * If it rejected, the product would refuse all of them.
   */
  test("an output length limit alone reports through outputLength and rejects nothing", () => {
    const decisions = features({ sampling: { maxOutputTokens: 256 } })

    expect(decisions.firstRejection()).toBeUndefined()
    expect([...decisions.resolvedFeatures()]).toEqual(["outputLength"])
    expect(noticeFeatures(decisions.notices())).toEqual(["outputLength"])
    const [notice] = decisions.notices()
    // Read from the declaration rather than restated, so a future Run_Record that moves the cell
    // fails here too. Widened to `string` for the comparison only: a notice policy is narrower than
    // a `FeaturePolicy` by construction, and the assertion is that the two agree at runtime.
    const noticePolicy: string = notice.policy
    expect(noticePolicy).toBe(KIRO_CAPABILITIES.features.outputLength)
    expect(notice.detail.trim().length).toBeGreaterThan(0)
  })

  /**
   * The same shape as the `outputLength` test above, and load-bearing for the same reason: a
   * client that always sends `cache_control` — Claude Code does — puts a cache hint on every
   * request, so a rejecting cell here would refuse all of them.
   */
  test("a cache hint alone reports through promptCache and rejects nothing", () => {
    const decisions = features({ cacheHint: [{ scope: "system" }] })

    expect(decisions.firstRejection()).toBeUndefined()
    expect([...decisions.resolvedFeatures()]).toEqual(["promptCache"])
    expect(noticeFeatures(decisions.notices())).toEqual(["promptCache"])
    const [notice] = decisions.notices()
    const noticePolicy: string = notice.policy
    expect(noticePolicy).toBe(KIRO_CAPABILITIES.features.promptCache)
    expect(notice.detail.trim().length).toBeGreaterThan(0)
  })

  /**
   * The same shape as the two tests above, and load-bearing for the same reason: Claude Code puts
   * `stop_sequences` on a sizeable share of its requests — 19 of 100 in one recorded session — so a
   * rejecting cell here refuses that whole share rather than answering them without the stop.
   */
  test("stop sequences alone report through stopSequences and reject nothing", () => {
    const decisions = features({ sampling: { stopSequences: ["STOP"] } })

    expect(decisions.firstRejection()).toBeUndefined()
    expect([...decisions.resolvedFeatures()]).toEqual(["stopSequences"])
    expect(noticeFeatures(decisions.notices())).toEqual(["stopSequences"])
    const [notice] = decisions.notices()
    const noticePolicy: string = notice.policy
    expect(noticePolicy).toBe(KIRO_CAPABILITIES.features.stopSequences)
    expect(notice.detail.trim().length).toBeGreaterThan(0)
  })

  /**
   * The two cells side by side on one request: the limit still reports while the controls still
   * reject, and the 400 a client sees is the `sampling` one because it comes first in matrix order.
   */
  test("a limit sent alongside temperature reports and rejects independently", () => {
    const decisions = features({ sampling: { temperature: 0.2, maxOutputTokens: 256 } })

    expect([...decisions.resolvedFeatures()]).toEqual(["sampling", "outputLength"])
    expect(decisions.firstRejection()?.feature).toBe("sampling")
    expect(noticeFeatures(decisions.notices())).toEqual(["outputLength"])
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
    expect(noticeFeatures(decisions.notices())).toEqual(["stopSequences", "promptCache", "toolChoiceForced", "structuredOutput"])
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

  test("passthrough results are returned unchanged", () => {
    const passthrough = { type: "canonical_passthrough", status: 200, statusText: "OK", headers: new Headers(), body: new ReadableStream<Uint8Array>() } as const
    expect(withKiroFeatureNotices(passthrough, [notice])).toBe(passthrough)
  })

  test("errors carry the notices as structured data, leaving status, headers, and body untouched", () => {
    const headers = new Headers()
    const error = { type: "canonical_error", status: 400, headers, body: "no" } as const
    const result = withKiroFeatureNotices(error, [notice])

    expect(result).not.toBe(error)
    expect(result.type).toBe("canonical_error")
    if (result.type !== "canonical_error") return
    expect(result.status).toBe(400)
    expect(result.headers).toBe(headers)
    expect(result.body).toBe("no")
    expect(result.featureNotices).toEqual([notice])
  })

  test("an error with no decided notice is the same object it was before", () => {
    const error = { type: "canonical_error", status: 400, headers: new Headers(), body: "no" } as const
    expect(withKiroFeatureNotices(error, [])).toBe(error)
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
