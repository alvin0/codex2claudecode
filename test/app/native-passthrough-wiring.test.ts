// Wiring coverage for task 19.2: the `NATIVE_PASSTHROUGH` boolean `readNativeFlags()` resolves in
// `src/app/bootstrap.ts` reaches the provider the composition root registers, and nothing else
// reads the variable.
//
// What already covers the neighbouring layers, so none of it is repeated here:
//
//  - `test/app/native-flags.test.ts` — the reader: environment in, booleans out.
//  - `test/app/passthrough-resolver.property.test.ts` (Property 18) — the policy, including the
//    `readNativeFlags` ▸ `resolvePassthrough` composition for the flag half of Requirement 15.6.
//  - `test/app/endpoint-share-passthrough.test.ts` — the per-request decision and the instance
//    capability, one level below bootstrap: it calls `endpointProxyRouteProvider()` directly and
//    hands it the boolean itself.
//  - `test/inbound/claude-edge.test.ts` ("unexpected passthrough response returns 500") — the
//    Claude 500 branch on the bare `Claude_Inbound_Provider`.
//
// The gap those leave is the thread between the two ends. Task 19.1 made `passthroughEnabled` a
// required parameter of `endpointProxyRouteProvider()` / `buildEndpointProxyProvider()` so the flag
// keeps exactly one reader (design decision D3) — and a required parameter can still be supplied
// from the wrong place, or hard-coded. Before these tests, `NATIVE_PASSTHROUGH=1` could be set and
// every registered provider might still decide `false`, or the flag could be re-read somewhere
// under `src/inbound/` or `src/upstream/`, and the suite would stay green. So these tests go
// through `bootstrapRuntime()` and observe the response bytes a client would receive.
//
// Codex is the upstream under test for the same reason as `test/app/native-strict-wiring.test.ts`:
// its credentials resolve entirely inside a temp directory via `CODEX_AUTH_FILE`, so nothing here
// touches the shared `~/.codex2claudecode/provider-state.json`.
//
// The observable is **byte identity with the upstream response**. Passthrough is defined as the
// client receiving the upstream bytes unmodified, so the assertion is `body === UPSTREAM_SSE`, not
// a flag read back off an object. `UPSTREAM_SSE` carries an event the canonical parser has no case
// for (`response.custom_marker`), which makes the two paths distinguishable in the negative
// direction too: the canonical path cannot reproduce it.
import { afterEach, describe, expect, test } from "bun:test"

import { bootstrapRuntime } from "../../src/app/bootstrap"
import { endpointProxyRouteProvider } from "../../src/app/endpoint-share"
import type { Canonical_Request } from "../../src/core/canonical"
import type { Upstream_Provider } from "../../src/core/interfaces"
import { mkdtemp, path, readFile, rm, sse, tmpdir, writeFile } from "../helpers"

const tempDirs: string[] = []
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
  globalThis.fetch = originalFetch
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * The upstream SSE body, including one event type the Codex parser has no case for.
 *
 * `response.custom_marker` is what makes the negative direction falsifiable: the canonical path
 * re-renders from parsed events, so it cannot emit an event it never understood. A test that only
 * asserted "the flag-on body differs from the flag-off body" would pass for the wrong reasons.
 */
const MARKER = "response.custom_marker"
const UPSTREAM_SSE = sse([
  { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
  { type: MARKER, marker: "wiring-19-2" },
  { type: "response.output_text.delta", delta: "ok" },
  { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
])

const CODEX_MODELS = {
  models: [{ slug: "gpt-5.4", title: "GPT-5.4", max_tokens: 100, max_output_tokens: 100, supports_images: false, thinking_efforts: [] }],
}

async function codexAuthFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-passthrough-wiring-"))
  tempDirs.push(dir)
  const file = path.join(dir, "auth-codex.json")
  // Expiry far enough out that no test reaches a token refresh.
  await writeFile(file, JSON.stringify({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 7 * 86_400_000, accountId: "acct" }))
  return file
}

/**
 * Installed before `bootstrapRuntime()`, because the Codex client captures `fetch` at
 * construction — a stub installed afterwards would leave a live network call on either path.
 */
function stubFetch() {
  globalThis.fetch = ((url: string | URL | Request) => {
    const target = String(url instanceof Request ? url.url : url)
    if (target.includes("/codex/models")) return Promise.resolve(Response.json(CODEX_MODELS))
    return Promise.resolve(new Response(UPSTREAM_SSE, { status: 200, headers: { "content-type": "text/event-stream" } }))
  }) as unknown as typeof fetch
}

/** One request through the provider the composition root registered for `path`. */
async function throughBootstrap(routePath: string, body: unknown, env: Record<string, string> = {}) {
  process.env.UPSTREAM_PROVIDER = "codex"
  process.env.CODEX_AUTH_FILE = await codexAuthFile()
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  stubFetch()

  const runtime = await bootstrapRuntime()
  const matched = runtime.registry.match("POST", routePath, new Headers())
  if (!matched) throw new Error(`no provider registered for ${routePath}`)
  const response = await matched.provider.handle(
    new Request(`http://localhost${routePath}`, { method: "POST", body: JSON.stringify(body) }),
    matched.descriptor,
    runtime.upstream,
    { requestId: "req_1", logBody: false, quiet: true },
  )
  return { provider: matched.provider.name, status: response.status, text: await response.text() }
}

const responsesBody = (stream: boolean) => ({ model: "gpt-5.4", input: "hi", stream })

describe("NATIVE_PASSTHROUGH reaches the registered provider through bootstrap", () => {
  test("with the flag unset, a streaming /v1/responses call takes the canonical path", async () => {
    const result = await throughBootstrap("/v1/responses", responsesBody(true))

    expect(result.provider).toBe("openai")
    expect(result.status).toBe(200)
    expect(result.text).not.toBe(UPSTREAM_SSE)
    expect(result.text).not.toInclude(MARKER)
  })

  test("with the flag set, the same call returns the upstream bytes unmodified", async () => {
    const result = await throughBootstrap("/v1/responses", responsesBody(true), { NATIVE_PASSTHROUGH: "1" })

    expect(result.status).toBe(200)
    expect(result.text).toBe(UPSTREAM_SSE)
    expect(result.text).toInclude(MARKER)
  })

  test("with the flag set, a non-streaming call still takes the canonical path", async () => {
    // The stream half of the conjunction, asserted at the far end of the thread rather than at the
    // resolver: `stream: false` must not forward raw SSE where the client asked for one JSON body.
    const result = await throughBootstrap("/v1/responses", responsesBody(false), { NATIVE_PASSTHROUGH: "1" })

    expect(result.text).not.toBe(UPSTREAM_SSE)
    expect(result.text).not.toInclude(MARKER)
    expect(JSON.parse(result.text)).toMatchObject({ model: "gpt-5.4" })
  })

  test("with the flag set, /v1/messages still takes the canonical path", async () => {
    // The route half, and the unit-level form of the live `messages-no-passthrough` claim.
    const result = await throughBootstrap("/v1/messages", { model: "gpt-5.4", messages: [{ role: "user", content: "hi" }], stream: true }, { NATIVE_PASSTHROUGH: "1" })

    expect(result.provider).toBe("claude-codex")
    expect(result.text).not.toBe(UPSTREAM_SSE)
    expect(result.text).not.toInclude(MARKER)
  })

  test("a value outside the documented enabling set leaves the registered provider canonical", async () => {
    const result = await throughBootstrap("/v1/responses", responsesBody(true), { NATIVE_PASSTHROUGH: "maybe" })

    expect(result.text).not.toBe(UPSTREAM_SSE)
  })
})

describe("NATIVE_PASSTHROUGH has exactly one reader", () => {
  // Design decision D3, asserted as a repository-wide grep rather than left to the comment in
  // `src/app/bootstrap.ts`. This is what makes the required `passthroughEnabled` parameter mean
  // something: without it, a module could take the parameter and then read the environment anyway.
  test("only src/app/native-flags.ts names the variable", async () => {
    const readers: string[] = []
    for await (const file of new Bun.Glob("src/**/*.{ts,tsx}").scan({ cwd: process.cwd(), onlyFiles: true })) {
      const normalized = file.replace(/\\/g, "/")
      const source = await readFile(path.join(process.cwd(), normalized), "utf8")
      // Comments legitimately name the flag when documenting where it is read; only executable
      // text counts as a reader.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      if (code.includes("NATIVE_PASSTHROUGH")) readers.push(normalized)
    }

    expect(readers).toEqual(["src/app/native-flags.ts"])
  })
})

describe("the Claude branch of the endpoint-proxy factory ignores the flag", () => {
  // `endpointProxyRouteProvider()` gained the required `passthroughEnabled` parameter for its
  // OpenAI branch, and the Claude branch shares the signature. Requirement 15.7: Claude keeps its
  // 500 for a passthrough result, whatever the flag says. `test/inbound/claude-edge.test.ts`
  // asserts that branch on the bare provider; what is new here is that the provider *this factory
  // builds* keeps it at both flag states, and never asks for passthrough in the first place.
  function passthroughUpstream(capture?: (request: Canonical_Request) => void): Upstream_Provider {
    return {
      providerKind: "codex",
      async proxy(request: Canonical_Request) {
        capture?.(request)
        return { type: "canonical_passthrough", status: 200, statusText: "OK", headers: new Headers(), body: UPSTREAM_SSE }
      },
      async listModels() {
        return ["gpt-5.4"]
      },
      async checkHealth() {
        return { ok: true }
      },
    } as unknown as Upstream_Provider
  }

  for (const flagEnabled of [false, true]) {
    test(`with the flag ${flagEnabled ? "on" : "off"}, a passthrough result becomes a 500 and no passthrough was requested`, async () => {
      let captured: Canonical_Request | undefined
      const upstream = passthroughUpstream((request) => { captured = request })
      const provider = endpointProxyRouteProvider("codex", "messages", upstream, flagEnabled)
      const route = provider.routes().find((descriptor) => descriptor.path === "/v1/messages")
      if (!route) throw new Error("provider does not serve /v1/messages")

      const response = await provider.handle(
        new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }) }),
        route,
        upstream,
        { requestId: "req_1", logBody: false, quiet: true },
      )

      expect(response.status).toBe(500)
      expect((await response.json()).error.message).toContain("passthrough")
      expect(captured?.passthrough).toBe(false)
    })
  }
})
