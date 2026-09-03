// Task 10.4 — the Codex and Copilot upstreams resolve their own declared matrix.
//
// The load-bearing assertion is negative and belongs to Requirement 10.6: a request carrying
// generation controls produces **zero** notices for `sampling` on both of these upstreams,
// because both declare that cell native. It is asserted three ways — on the decisions object,
// on a collected response, and on a stream — so a regression cannot hide behind whichever
// layer a later change happens to touch.
//
// The complementary positive assertions keep the negative one from passing vacuously: a
// reporting cell of the same upstream does produce exactly one notice, and it reaches the
// canonical result. Without those, "zero notices" would also be satisfied by a provider that
// resolves nothing at all.
import { describe, expect, test } from "bun:test"

import type { Canonical_Event, Canonical_Request } from "../../src/core/canonical"
import { CODEX_CAPABILITIES } from "../../src/upstream/codex/capabilities"
import { resolveCodexFeatures } from "../../src/upstream/codex/features"
import { Codex_Upstream_Provider } from "../../src/upstream/codex"
import { COPILOT_CAPABILITIES } from "../../src/upstream/copilot/capabilities"
import { resolveCopilotFeatures } from "../../src/upstream/copilot/features"
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

  // Requirement 10.6. The declaration is what makes this true, so it is asserted alongside the
  // outcome: a future edit that flips the cell fails here as well as on the live case.
  //
  // Per-shape counts, since task 12b made them differ: the first two shapes carry `sampling`
  // alone, and the third carries an output length limit as well, which is `outputLength` — its own
  // feature and its own cell — so that shape resolves **two** features rather than one. Both cells
  // are `native` on this upstream, so the zero-notices clause holds for all three shapes; the
  // resolved-set assertion is what distinguishes them, and it is written per shape so a regression
  // that stopped resolving the second feature cannot hide behind the shared silence.
  test("generation controls produce zero sampling notices and no rejection", () => {
    expect(CODEX_CAPABILITIES.features.sampling).toBe("native")
    expect(CODEX_CAPABILITIES.features.outputLength).toBe("native")

    const shapes = [
      { sampling: { temperature: 0.2 }, resolves: ["sampling"] },
      { sampling: { topP: 0.9 }, resolves: ["sampling"] },
      { sampling: { temperature: 0, topP: 1, maxOutputTokens: 256 }, resolves: ["sampling", "outputLength"] },
    ] as const

    for (const { sampling, resolves } of shapes) {
      const decisions = resolveCodexFeatures(withFutureMembers(canonicalRequest(), { sampling }))

      expect(decisions.resolvedFeatures().has("sampling")).toBe(true)
      expect([...decisions.resolvedFeatures()]).toEqual([...resolves])
      expect(noticesFor(decisions, "sampling")).toEqual([])
      expect(noticesFor(decisions, "outputLength")).toEqual([])
      expect(decisions.notices()).toEqual([])
      expect(decisions.firstRejection()).toBeUndefined()
    }
  })

  // Strict mode escalates a reporting outcome, never a native one, so `sampling` stays silent
  // even here while a reporting cell of the same request fails it.
  test("strict mode leaves a native cell silent", () => {
    const decisions = resolveCodexFeatures(withFutureMembers(canonicalRequest(), { sampling: { temperature: 0.2 } }), { strict: true })

    expect(noticesFor(decisions, "sampling")).toEqual([])
    expect(decisions.firstRejection()).toBeUndefined()
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

  test("omits featureNotices entirely when every resolution was native", async () => {
    const result = await provider(completed).proxy(withFutureMembers(canonicalRequest({ instructions: "Be helpful" }), { sampling: { temperature: 0.2 } }))

    expect(result.type).toBe("canonical_response")
    if (result.type !== "canonical_response") return
    // Omitted, not present-as-empty: `undefined` and `[]` are different answers.
    expect("featureNotices" in result).toBe(false)
  })

  test("attaches a reporting notice to a collected response", async () => {
    const result = await provider(completed).proxy(withFutureMembers(canonicalRequest(), { sampling: { stopSequences: ["STOP"] } }))

    expect(result.type).toBe("canonical_response")
    if (result.type !== "canonical_response") return
    expect(result.featureNotices?.map((notice) => notice.feature)).toEqual(["stopSequences"])
  })

  test("yields notice events ahead of the upstream content on a stream", async () => {
    const result = await provider(completed).proxy(
      withFutureMembers(canonicalRequest({ stream: true }), { sampling: { temperature: 0.2, stopSequences: ["STOP"] } }),
    )

    expect(result.type).toBe("canonical_stream")
    if (result.type !== "canonical_stream") return
    const events: Canonical_Event[] = []
    for await (const event of result.events) events.push(event)

    expect(events[0]).toMatchObject({ type: "feature_notice", feature: "stopSequences" })
    expect(events.filter((event) => event.type === "feature_notice")).toHaveLength(1)
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
  })
})
