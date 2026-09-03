// Wiring coverage for task 11.2: the boolean `readNativeFlags()` resolves in
// `src/app/bootstrap.ts` reaches the provider the composition root builds.
//
// `test/app/native-flags.test.ts` covers the reader (environment in, booleans out) and
// `test/upstream/features.test.ts` plus `test/upstream/kiro/features.test.ts` cover the
// interpretation (`strict` at the constructor escalating a `degrade`). Neither says the two ends
// are connected — before this task `NATIVE_STRICT` could be set and every provider would still be
// built with `strict` defaulting to off. That gap is what these tests close, so they go through
// `bootstrapRuntime()` rather than a constructor.
//
// Codex is the upstream under test for one reason: its credentials resolve entirely inside a temp
// directory via `CODEX_AUTH_FILE`, so nothing here reads or writes the shared
// `~/.codex2claudecode/provider-state.json` that the Kiro path goes through. The observable is
// `stopSequences`, which Codex declares `degrade`, and the escalation is asserted to happen
// *before* the upstream call — which is also why the strict case needs no upstream response.
import { afterEach, describe, expect, test } from "bun:test"

import { bootstrapRuntime } from "../../src/app/bootstrap"
import type { Canonical_Request } from "../../src/core/canonical"
import { mkdtemp, path, rm, sse, tmpdir, writeFile } from "../helpers"

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

async function codexAuthFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-strict-wiring-"))
  tempDirs.push(dir)
  const file = path.join(dir, "auth-codex.json")
  // Expiry far enough out that no test reaches a token refresh.
  await writeFile(file, JSON.stringify({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 7 * 86_400_000, accountId: "acct" }))
  return file
}

const completed = sse([
  { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
  { type: "response.output_text.delta", delta: "ok" },
  { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
])

/**
 * A request whose only matrix-covered field is a stop-sequence list.
 *
 * `sampling` is written through a cast because `Canonical_Request` does not declare it until
 * task 13 — the same forward-compatible view `src/upstream/codex/features.ts` reads. Constructing
 * the canonical request directly (rather than mapping a wire body) is what makes the field
 * observable at all before task 14 carries it inbound.
 */
function stopSequenceRequest(): Canonical_Request {
  return {
    model: "gpt-5.4",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
    sampling: { stopSequences: ["STOP"] },
  } as Canonical_Request
}

/**
 * Counts upstream calls so "resolved before the upstream call" is asserted, not assumed.
 *
 * Installed before `bootstrapRuntime()`, because the Codex client captures `fetch` at
 * construction — a stub installed afterwards would leave a live network call on the
 * unescalated path.
 */
function countingFetch() {
  const calls: string[] = []
  globalThis.fetch = ((url: string | URL | Request) => {
    calls.push(String(url instanceof Request ? url.url : url))
    return Promise.resolve(new Response(completed, { status: 200 }))
  }) as unknown as typeof fetch
  return calls
}

async function bootstrapCodex(calls: string[]) {
  process.env.UPSTREAM_PROVIDER = "codex"
  process.env.CODEX_AUTH_FILE = await codexAuthFile()
  const runtime = await bootstrapRuntime()
  calls.length = 0
  return runtime
}

describe("NATIVE_STRICT reaches provider construction through bootstrap", () => {
  test("with the flag set, a degrade escalates to a 400 and spends no upstream request", async () => {
    process.env.NATIVE_STRICT = "1"
    const calls = countingFetch()
    const runtime = await bootstrapCodex(calls)

    const result = await runtime.upstream.proxy(stopSequenceRequest())

    expect(result.type).toBe("canonical_error")
    if (result.type !== "canonical_error") return
    expect(result.status).toBe(400)
    expect(result.body).toContain("stopSequences")
    expect(calls).toEqual([])
  })

  test("with the flag unset, the same request keeps its 200 and its notice", async () => {
    delete process.env.NATIVE_STRICT
    const calls = countingFetch()
    const runtime = await bootstrapCodex(calls)

    const result = await runtime.upstream.proxy(stopSequenceRequest())

    expect(result.type).toBe("canonical_response")
    if (result.type !== "canonical_response") return
    expect(result.featureNotices?.map((notice) => notice.feature)).toEqual(["stopSequences"])
    expect(calls.length).toBeGreaterThan(0)
  })

  test("a value outside the documented enabling set leaves the provider unescalated", async () => {
    process.env.NATIVE_STRICT = "maybe"
    const runtime = await bootstrapCodex(countingFetch())

    expect((await runtime.upstream.proxy(stopSequenceRequest())).type).toBe("canonical_response")
  })
})
