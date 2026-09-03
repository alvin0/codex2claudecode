// What the composition root wires into the OpenAI inbound provider for passthrough.
//
// Task 18.1 made `normalize.ts` read the option that `endpoint-share.ts` had been passing all
// along, which turned the old `passthrough: sourceMode === "codex"` into a live claim that every
// codex-mode OpenAI request may be forwarded as bytes — including `stream: false`, which the rule
// forbids because the upstream answers raw Codex SSE where the client asked for one JSON object.
// Task 18.2 replaces that boolean with the four-way decider. These tests pin both halves of the
// wiring: the per-request decision, and the instance capability the lenient branches key off.
import { describe, expect, test } from "bun:test"
import { endpointProxyRouteProvider } from "../../src/app/endpoint-share"
import type { Canonical_Request } from "../../src/core/canonical"
import type { ProviderMode } from "../../src/core/provider-state"
import type { Upstream_Provider } from "../../src/core/interfaces"

function stubUpstream(providerKind: ProviderMode, capture?: (request: Canonical_Request) => void): Upstream_Provider {
  return {
    providerKind,
    async proxy(request: Canonical_Request) {
      capture?.(request)
      return {
        type: "canonical_response",
        id: "resp_1",
        model: request.model,
        stopReason: "end_turn",
        content: [{ type: "text", text: "OK" }],
        usage: { inputTokens: 1, outputTokens: 1 },
      }
    },
    async listModels() {
      return ["gpt-5"]
    },
  } as unknown as Upstream_Provider
}

const context = { requestId: "test", logBody: false, quiet: true }

/** The canonical request the provider hands its upstream for one `/v1/responses` call. */
async function canonicalRequestFor(sourceMode: ProviderMode, stream: boolean, passthroughEnabled: boolean) {
  let captured: Canonical_Request | undefined
  const upstream = stubUpstream(sourceMode, (request) => { captured = request })
  const provider = endpointProxyRouteProvider(sourceMode, "responses", upstream, passthroughEnabled)
  const route = provider.routes().find((descriptor) => descriptor.path === "/v1/responses")
  if (!route) throw new Error("provider does not serve /v1/responses")
  await provider.handle(
    new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-5", input: "hi", stream }) }),
    route,
    upstream,
    context,
  )
  if (!captured) throw new Error("upstream was never called")
  return captured
}

/** The malformed-JSON branch, which reads instance capability rather than a per-request answer. */
async function malformedJsonStatus(sourceMode: ProviderMode, passthroughEnabled: boolean) {
  const upstream = stubUpstream(sourceMode)
  const provider = endpointProxyRouteProvider(sourceMode, "responses", upstream, passthroughEnabled)
  const route = provider.routes().find((descriptor) => descriptor.path === "/v1/responses")
  if (!route) throw new Error("provider does not serve /v1/responses")
  const response = await provider.handle(
    new Request("http://localhost/v1/responses", { method: "POST", body: "{ not json" }),
    route,
    upstream,
    context,
  )
  return response.status
}

describe("endpoint-share passthrough wiring", () => {
  test("codex with the flag off never asks for passthrough, at either stream value", async () => {
    expect((await canonicalRequestFor("codex", true, false)).passthrough).toBe(false)
    expect((await canonicalRequestFor("codex", false, false)).passthrough).toBe(false)
  })

  test("codex with the flag on asks for passthrough only when streaming", async () => {
    expect((await canonicalRequestFor("codex", true, true)).passthrough).toBe(true)
    // The case task 18.1 exposed: the old boolean would have said `true` here.
    expect((await canonicalRequestFor("codex", false, true)).passthrough).toBe(false)
  })

  test("kiro and copilot never ask for passthrough, whatever the flag says", async () => {
    for (const sourceMode of ["kiro", "copilot"] as const) {
      for (const flag of [false, true]) {
        expect((await canonicalRequestFor(sourceMode, true, flag)).passthrough).toBe(false)
        expect((await canonicalRequestFor(sourceMode, false, flag)).passthrough).toBe(false)
      }
    }
  })

  test("instance capability is unchanged by the rewiring", async () => {
    // Codex stays a byte conduit — lenient 500 — even with the flag off, exactly as the boolean
    // `true` behaved before. Kiro and Copilot stay strict — 400 with the OpenAI error shape — so
    // handing them a decider must not promote them to "capable".
    expect(await malformedJsonStatus("codex", false)).toBe(500)
    expect(await malformedJsonStatus("codex", true)).toBe(500)
    expect(await malformedJsonStatus("kiro", false)).toBe(400)
    expect(await malformedJsonStatus("copilot", true)).toBe(400)
  })
})
