// Task 10.4 — the Codex and Copilot upstreams resolve their own declared matrix.
//
// The load-bearing assertion used to be negative: a request carrying generation controls produced
// **zero** notices for `sampling` on both of these upstreams, because both declared that cell
// native. It stays negative for **Copilot**, whose cell is still `native` and still unmeasured. It
// is now **positive for Codex**, restated against Requirement 10.6 as revised:
// `.omc/research/kiro-wire-spike.md` §11.2 sent `temperature`, `top_p`, and `max_output_tokens` to
// the Codex Responses endpoint one per run and measured `400 {"detail":"Unsupported parameter:
// <name>"}` for each, against a 200 control run carrying none of them. So those two Codex cells are
// `degrade`, the fields are dropped before the wire, and exactly one notice per feature says so.
//
// The three-layer structure is kept, because it was never about the sign of the assertion: the
// Codex outcome is checked on the decisions object, on a collected response, and on a stream, so a
// regression cannot hide behind whichever layer a later change happens to touch. The Copilot
// silence keeps its complementary positive assertion — a reporting cell of the same upstream
// produces exactly one notice — because "zero notices" would otherwise also be satisfied by a
// provider that resolves nothing at all.
import { describe, expect, test } from "bun:test"

import type { Canonical_Event, Canonical_FeatureNotice, Canonical_Request } from "../../src/core/canonical"
import type { ProviderFeature } from "../../src/core/provider-capabilities"
import { CODEX_CAPABILITIES } from "../../src/upstream/codex/capabilities"
import { resolveCodexFeatures } from "../../src/upstream/codex/features"
import { withCodexFeatureNotices } from "../../src/upstream/codex/feature-notices"
import { Codex_Upstream_Provider } from "../../src/upstream/codex"
import { COPILOT_CAPABILITIES } from "../../src/upstream/copilot/capabilities"
import { resolveCopilotFeatures } from "../../src/upstream/copilot/features"
import { withCopilotFeatureNotices } from "../../src/upstream/copilot/feature-notices"
import { Copilot_Upstream_Provider } from "../../src/upstream/copilot"
import type { Copilot_Auth_Manager } from "../../src/upstream/copilot/auth"
import type { Copilot_Client } from "../../src/upstream/copilot/client"
import { sse } from "../helpers"

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

/**
 * The canonical members the contract task has not landed yet, attached the way the feature
 * modules read them.
 *
 * Written through a cast rather than by widening `Canonical_Request` in core, so this test
 * exercises the same forward-compatible view the providers declare locally and needs no edit
 * when the real members arrive.
 */
function withFutureMembers(
  request: Canonical_Request,
  members: { sampling?: { temperature?: number; topP?: number; maxOutputTokens?: number; stopSequences?: string[] }; cacheHint?: Array<{ scope?: string }> },
): Canonical_Request {
  return { ...request, ...members } as Canonical_Request
}

function noticesFor(decisions: { notices(): Array<{ feature: string }> }, feature: string) {
  return decisions.notices().filter((notice) => notice.feature === feature)
}

describe("Codex feature resolution", () => {
  test("resolves the request-shaped features the client actually sent", () => {
    const decisions = resolveCodexFeatures(
      canonicalRequest({
        instructions: "Be helpful",
        tools: [{ type: "function", name: "save", strict: true }],
        toolChoice: { type: "function", name: "save" },
        textFormat: { type: "json_schema", name: "result" },
      }),
    )

    expect([...decisions.resolvedFeatures()].sort()).toEqual(["strictToolSchema", "structuredOutput", "systemPrompt", "toolChoiceForced"])
    expect(decisions.notices()).toEqual([])
    expect(decisions.firstRejection()).toBeUndefined()
  })

  test("a plain request resolves nothing and reports nothing", () => {
    const decisions = resolveCodexFeatures(canonicalRequest())

    expect([...decisions.resolvedFeatures()]).toEqual([])
    expect(decisions.notices()).toEqual([])
    expect(decisions.firstRejection()).toBeUndefined()
  })

  // Requirement 10.6 as revised, and Requirement 10.10 for the limit. The declaration is asserted
  // alongside the outcome for the same reason as before — an edit that flips a cell must fail here
  // as well as on the live case — only the recorded value has changed, on the §11.2 measurement.
  //
  // Restated from "generation controls produce zero sampling notices and no rejection". Same three
  // shapes, same per-shape resolved-set counts (task 12b's split is untouched), opposite notice
  // expectation. The per-shape structure earns its keep in the new form too: shape three carries a
  // limit as well, so it must produce **two** notices — one per feature — and a resolver that
  // reported the limit under `sampling` would satisfy a bare total count while telling the client
  // the wrong thing.
  test("generation controls are dropped with exactly one notice per feature and no rejection", () => {
    expect(CODEX_CAPABILITIES.features.sampling).toBe("degrade")
    expect(CODEX_CAPABILITIES.features.outputLength).toBe("degrade")

    const shapes: ReadonlyArray<{ sampling: Record<string, number>; resolves: readonly ProviderFeature[]; mentions: readonly string[] }> = [
      { sampling: { temperature: 0.2 }, resolves: ["sampling"], mentions: ["temperature"] },
      { sampling: { topP: 0.9 }, resolves: ["sampling"], mentions: ["top-p"] },
      { sampling: { temperature: 0, topP: 1, maxOutputTokens: 256 }, resolves: ["sampling", "outputLength"], mentions: ["temperature", "top-p", "256"] },
    ]

    for (const { sampling, resolves, mentions } of shapes) {
      const decisions = resolveCodexFeatures(withFutureMembers(canonicalRequest(), { sampling }))

      expect(decisions.resolvedFeatures().has("sampling")).toBe(true)
      expect([...decisions.resolvedFeatures()]).toEqual([...resolves])
      expect(noticesFor(decisions, "sampling")).toHaveLength(1)
      expect(noticesFor(decisions, "outputLength")).toHaveLength(resolves.includes("outputLength") ? 1 : 0)
      expect(decisions.notices()).toHaveLength(resolves.length)
      for (const notice of decisions.notices()) expect(notice.policy).toBe("degrade")
      // The detail is the only channel a client has for learning what happened to its value, so
      // it must name the control and, for the limit, the number. Prose is not asserted; the facts
      // inside it are (Requirement 10.6, 10.10).
      const details = decisions.notices().map((notice) => notice.detail).join(" | ")
      for (const needle of mentions) expect(details).toContain(needle)
      // Dropped, not refused: the request still runs, which is the whole difference between the
      // `degrade` the control run justifies and a `reject`.
      expect(decisions.firstRejection()).toBeUndefined()
    }
  })

  // Restated from "strict mode leaves a native cell silent", which is no longer a fact about this
  // cell. `degrade` escalates under strict — that is the documented behavior of the flag, not a
  // decision made here — so what is asserted is the escalation and the disappearance of the notice.
  test("strict mode turns the dropped controls into a rejection naming sampling", () => {
    const decisions = resolveCodexFeatures(withFutureMembers(canonicalRequest(), { sampling: { temperature: 0.2 } }), { strict: true })

    expect(noticesFor(decisions, "sampling")).toEqual([])
    expect(decisions.firstRejection()?.feature).toBe("sampling")
  })

  test("a reporting cell produces exactly one notice naming the feature", () => {
    const decisions = resolveCodexFeatures(withFutureMembers(canonicalRequest(), { sampling: { stopSequences: ["STOP"] } }))
    const notices = noticesFor(decisions, "stopSequences")

    expect(notices).toHaveLength(1)
    expect(notices[0]!.feature).toBe("stopSequences")
    expect(decisions.notices()).toHaveLength(1)
  })

  test("strict mode turns that same request into a rejection naming the feature and an alternative", () => {
    const decisions = resolveCodexFeatures(withFutureMembers(canonicalRequest(), { sampling: { stopSequences: ["STOP"] } }), { strict: true })
    const rejection = decisions.firstRejection()

    expect(rejection?.feature).toBe("stopSequences")
    expect(rejection?.message).toContain("stopSequences")
    expect(rejection?.message).toContain("instead")
    expect(decisions.notices()).toEqual([])
  })
})

describe("Copilot feature resolution", () => {
  test("resolves the request-shaped features the client actually sent", () => {
    const decisions = resolveCopilotFeatures(
      canonicalRequest({
        instructions: "Be helpful",
        reasoningEffort: "high",
        tools: [{ type: "function", name: "save", parameters: { type: "object", additionalProperties: false } }],
        toolChoice: "required",
        textFormat: { type: "json_schema", name: "result" },
      }),
    )

    expect([...decisions.resolvedFeatures()].sort()).toEqual([
      "strictToolSchema",
      "structuredOutput",
      "systemPrompt",
      "thinkingBudget",
      "toolChoiceForced",
    ])
    expect(decisions.notices()).toEqual([])
    expect(decisions.firstRejection()).toBeUndefined()
  })

  test("generation controls produce zero sampling notices and no rejection", () => {
    expect(COPILOT_CAPABILITIES.features.sampling).toBe("native")

    const decisions = resolveCopilotFeatures(withFutureMembers(canonicalRequest(), { sampling: { temperature: 0.2, topP: 0.9 } }))

    expect(decisions.resolvedFeatures().has("sampling")).toBe(true)
    expect(noticesFor(decisions, "sampling")).toEqual([])
    expect(decisions.notices()).toEqual([])
    expect(decisions.firstRejection()).toBeUndefined()
  })

  test("a reporting cell produces exactly one notice", () => {
    const decisions = resolveCopilotFeatures(withFutureMembers(canonicalRequest(), { cacheHint: [{ scope: "system" }] }))
    const notices = noticesFor(decisions, "promptCache")

    expect(notices).toHaveLength(1)
    expect(decisions.notices()).toHaveLength(1)
  })
})

describe("Codex provider carries decisions into the result", () => {
  function provider(body: string, options: { strict?: boolean } = {}) {
    return new Codex_Upstream_Provider({
      accessToken: "access",
      refreshToken: "refresh",
      strict: options.strict,
      fetch: (() => Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch,
    })
  }

  const completed = sse([
    { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
    { type: "response.output_text.delta", delta: "ok" },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
  ])

  // Restated. The fixture used to be `instructions` plus a `temperature`, both native, and the
  // claim was that a fully native request omits the member entirely rather than carrying `[]`. The
  // claim is unchanged and still worth making — `undefined` and `[]` are different answers — but
  // `temperature` is now a `degrade`, so the fixture keeps only the native half.
  test("omits featureNotices entirely when every resolution was native", async () => {
    const result = await provider(completed).proxy(canonicalRequest({ instructions: "Be helpful" }))

    expect(result.type).toBe("canonical_response")
    if (result.type !== "canonical_response") return
    // Omitted, not present-as-empty: `undefined` and `[]` are different answers.
    expect("featureNotices" in result).toBe(false)
  })

  /**
   * The Codex `degrade` reaching a collected response, which is the layer a client on the
   * non-streaming path actually reads. Requirement 10.6 as revised.
   *
   * The same request that produced *no* notice here before the §11.2 correction, asserted the other
   * way round: one notice, naming `sampling`, on a 200.
   */
  test("attaches the dropped-sampling notice to a collected response", async () => {
    const result = await provider(completed).proxy(withFutureMembers(canonicalRequest(), { sampling: { temperature: 0.2 } }))

    expect(result.type).toBe("canonical_response")
    if (result.type !== "canonical_response") return
    expect(result.featureNotices?.map((notice) => notice.feature)).toEqual(["sampling"])
    expect(result.featureNotices?.[0]!.detail).toContain("temperature")
  })

  test("attaches a reporting notice to a collected response", async () => {
    const result = await provider(completed).proxy(withFutureMembers(canonicalRequest(), { sampling: { stopSequences: ["STOP"] } }))

    expect(result.type).toBe("canonical_response")
    if (result.type !== "canonical_response") return
    expect(result.featureNotices?.map((notice) => notice.feature)).toEqual(["stopSequences"])
  })

  // Restated: the same request now carries **two** reporting outcomes rather than one, because
  // `temperature` joined `stopSequences` on the `degrade` side (§11.2). The ordering claim is the
  // one this test exists for and it is unchanged — notices lead, in matrix order, ahead of upstream
  // content — and `sampling` precedes `stopSequences` in `PROVIDER_FEATURES`, so the sequence is
  // pinned rather than merely counted.
  test("yields notice events ahead of the upstream content on a stream", async () => {
    const result = await provider(completed).proxy(
      withFutureMembers(canonicalRequest({ stream: true }), { sampling: { temperature: 0.2, stopSequences: ["STOP"] } }),
    )

    expect(result.type).toBe("canonical_stream")
    if (result.type !== "canonical_stream") return
    const events: Canonical_Event[] = []
    for await (const event of result.events) events.push(event)

    expect(events[0]).toMatchObject({ type: "feature_notice", feature: "sampling" })
    expect(events[1]).toMatchObject({ type: "feature_notice", feature: "stopSequences" })
    expect(events.filter((event) => event.type === "feature_notice")).toHaveLength(2)
    expect(events.map((event) => event.type)).toContain("message_start")
  })

  test("fails the request before calling upstream when a resolution rejects", async () => {
    let called = false
    const rejecting = new Codex_Upstream_Provider({
      accessToken: "access",
      refreshToken: "refresh",
      strict: true,
      fetch: (() => {
        called = true
        return Promise.resolve(new Response(completed, { status: 200 }))
      }) as unknown as typeof fetch,
    })

    const result = await rejecting.proxy(withFutureMembers(canonicalRequest(), { sampling: { stopSequences: ["STOP"] } }))

    expect(result.type).toBe("canonical_error")
    if (result.type !== "canonical_error") return
    expect(result.status).toBe(400)
    expect(result.body).toContain("stopSequences")
    expect(called).toBe(false)
    // Additive (task 14b): the single `degrade` this request carried is the field that escalated,
    // so there is nothing left to report and the error stays byte-identical to the pre-14b one.
    expect("featureNotices" in result).toBe(false)
  })

  // Task 14b — the reject path carries its notices, asserted on this upstream rather than on Kiro
  // alone (14b.2 changed all three `proxy()` implementations, so all three are worth an assertion).
  //
  // The request-level unstrict form 14b.4 describes — "one `reject`-declared field and one
  // `degrade`-declared field" — is still not reachable on this upstream's declaration (§11.2 added
  // two `degrade` cells, not a `reject` one): `CODEX_CAPABILITIES.features`
  // contains no `reject` cell at all, so unstrict resolution never produces a rejection, and under
  // `strict: true` every `degrade` escalates together, which is why the test above records no
  // surviving notice. The delivery is therefore asserted at the one site 14b.2 routed the rejection
  // return through, the same way `test/upstream/kiro/features.test.ts` asserts it for Kiro. This
  // stays correct — and starts being reachable through `proxy()` — the day a cell here becomes `reject`.
  test("a rejection carries the decided notices, leaving status, headers, and body untouched", () => {
    const notice: Canonical_FeatureNotice = { feature: "stopSequences", policy: "degrade", detail: "no stop-sequence field" }
    const headers = new Headers({ "x-test": "1" })
    const error = { type: "canonical_error", status: 400, headers, body: "This upstream does not support promptCache." } as const

    const result = withCodexFeatureNotices(error, [notice])

    expect(result).not.toBe(error)
    expect(result.type).toBe("canonical_error")
    if (result.type !== "canonical_error") return
    expect(result.status).toBe(400)
    expect(result.headers).toBe(headers)
    expect(result.body).toBe("This upstream does not support promptCache.")
    expect(result.featureNotices).toEqual([notice])
  })

  test("an error with no decided notice is the same object it was before", () => {
    const error = { type: "canonical_error", status: 400, headers: new Headers(), body: "no" } as const
    expect(withCodexFeatureNotices(error, [])).toBe(error)
  })
})

describe("Copilot provider carries decisions into the result", () => {
  function provider(options: { strict?: boolean } = {}) {
    const client = {
      proxy: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "resp_1",
              model: "gpt-4.1",
              output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
              usage: { input_tokens: 1, output_tokens: 2 },
            }),
            { status: 200 },
          ),
        ),
    } as unknown as Copilot_Client

    return new Copilot_Upstream_Provider({ auth: {} as unknown as Copilot_Auth_Manager, client, strict: options.strict })
  }

  test("omits featureNotices entirely when every resolution was native", async () => {
    const result = await provider().proxy(withFutureMembers(canonicalRequest({ instructions: "Be helpful", reasoningEffort: "high" }), { sampling: { temperature: 0.2 } }))

    expect(result.type).toBe("canonical_response")
    if (result.type !== "canonical_response") return
    expect("featureNotices" in result).toBe(false)
  })

  test("attaches a reporting notice to a collected response", async () => {
    const result = await provider().proxy(withFutureMembers(canonicalRequest(), { cacheHint: [{ scope: "system" }] }))

    expect(result.type).toBe("canonical_response")
    if (result.type !== "canonical_response") return
    expect(result.featureNotices?.map((notice) => notice.feature)).toEqual(["promptCache"])
  })

  test("fails the request before calling upstream when a resolution rejects", async () => {
    const result = await provider({ strict: true }).proxy(withFutureMembers(canonicalRequest(), { cacheHint: [{ scope: "system" }] }))

    expect(result.type).toBe("canonical_error")
    if (result.type !== "canonical_error") return
    expect(result.status).toBe(400)
    expect(result.body).toContain("promptCache")
    // Additive (task 14b), same reasoning as the Codex case: the one `degrade` this request carried
    // is the field that escalated, so no notice survives and the error is unchanged from pre-14b.
    expect("featureNotices" in result).toBe(false)
  })

  // Task 14b, the Copilot half of the same assertion the Codex suite above explains. Copilot has no
  // connected account and no live case (Requirement 26.9), and `COPILOT_CAPABILITIES.features`
  // likewise declares no `reject` cell, so this delivery is asserted at the channel-choice site
  // 14b.2 routed the rejection return through.
  test("a rejection carries the decided notices, leaving status, headers, and body untouched", () => {
    const notice: Canonical_FeatureNotice = { feature: "promptCache", policy: "degrade", detail: "no client-addressable cache" }
    const headers = new Headers({ "x-test": "1" })
    const error = { type: "canonical_error", status: 400, headers, body: "This upstream does not support stopSequences." } as const

    const result = withCopilotFeatureNotices(error, [notice])

    expect(result).not.toBe(error)
    expect(result.type).toBe("canonical_error")
    if (result.type !== "canonical_error") return
    expect(result.status).toBe(400)
    expect(result.headers).toBe(headers)
    expect(result.body).toBe("This upstream does not support stopSequences.")
    expect(result.featureNotices).toEqual([notice])
  })

  test("an error with no decided notice is the same object it was before", () => {
    const error = { type: "canonical_error", status: 400, headers: new Headers(), body: "no" } as const
    expect(withCopilotFeatureNotices(error, [])).toBe(error)
  })
})
