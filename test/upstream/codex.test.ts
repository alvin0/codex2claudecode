import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { normalizeReasoningBody } from "../../src/core/reasoning"
import { jwt, sse } from "../helpers"
import { Codex_Upstream_Provider } from "../../src/upstream/codex"
import { canonicalToCodexBody, collectCodexResponse } from "../../src/upstream/codex/parse"
import type { Canonical_Request } from "../../src/core/canonical"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function authFile(contents = { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000, accountId: "acct" }) {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-upstream-test-"))
  tempDirs.push(dir)
  const file = path.join(dir, "auth-codex.json")
  await writeFile(file, JSON.stringify(contents))
  return file
}

function canonicalRequest(overrides: Partial<Canonical_Request> = {}): Canonical_Request {
  return {
    model: "gpt-5.4_xhigh",
    instructions: "Be helpful",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [{ type: "function", name: "save" }],
    toolChoice: "auto",
    include: ["web_search_call.action.sources"],
    textFormat: { type: "json_schema", name: "result" },
    reasoningEffort: "high",
    stream: false,
    passthrough: false,
    metadata: {},
    ...overrides,
  }
}

describe("Codex upstream translation", () => {
  test("translates canonical requests into Codex responses bodies", () => {
    expect(canonicalToCodexBody(canonicalRequest())).toEqual({
      model: "gpt-5.4_xhigh",
      reasoning_effort: "high",
      instructions: "Be helpful",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      store: false,
      stream: false,
      tools: [{ type: "function", name: "save" }],
      include: ["web_search_call.action.sources"],
      tool_choice: "auto",
      text: { format: { type: "json_schema", name: "result" } },
    })
  })

  test("property: translated bodies preserve structure across random canonical requests", () => {
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const request = canonicalRequest({
        model: iteration % 2 === 0 ? `gpt-5.4_${["none", "low", "medium", "high", "xhigh"][iteration % 5]}` : `model-${iteration}`,
        input: Array.from({ length: (iteration % 4) + 1 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: [{ type: index % 2 === 0 ? "input_text" : "output_text", text: `text-${iteration}-${index}` }],
        })),
        tools: Array.from({ length: iteration % 3 }, (_, index) => ({ type: "function", name: `tool_${index}` })),
        stream: iteration % 2 === 0,
        reasoningEffort: undefined,
      })

      const normalized = normalizeReasoningBody(canonicalToCodexBody(request))
      expect(normalized.model).toBe(typeof request.model === "string" ? request.model.replace(/_(none|low|medium|high|xhigh)$/, "") : request.model)
      expect(Array.isArray(normalized.input) ? normalized.input.length : 0).toBe(request.input.length)
      expect(normalized.store).toBe(false)
      expect(normalized.stream).toBe(request.stream)
      expect(Array.isArray(normalized.tools) ? normalized.tools.length : 0).toBe(request.tools?.length ?? 0)
    }
  })
})

describe("Codex SSE parsing", () => {
  test("collects canonical responses from known SSE sequences", async () => {
    const response = await collectCodexResponse(
      new Response(
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
          { type: "response.output_text.delta", delta: "hel" },
          { type: "response.output_text.done", text: "hello" },
          { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{\"ok\":true}" } },
          { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 4 }, output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }, { type: "function_call", id: "fc_1", call_id: "call_1", name: "save", arguments: "{\"ok\":true}" }] } },
        ]),
      ),
      "fallback",
    )

    expect(response).toMatchObject({
      id: "resp_1",
      model: "gpt-5.4",
      usage: { inputTokens: 3, outputTokens: 4 },
    })
    expect(response.content).toEqual([
      { type: "thinking", thinking: "Initializing…", signature: expect.stringMatching(/^sig_/) },
      { type: "text", text: "hello" },
      { type: "tool_call", id: "fc_1", callId: "call_1", name: "save", arguments: "{\"ok\":true}" },
    ])
  })

  test("property: random completed SSE sequences produce valid canonical responses", async () => {
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const text = `text-${iteration}`
      const callId = `call_${iteration}`
      const response = await collectCodexResponse(
        new Response(
          sse([
            { type: "response.created", response: { id: `resp_${iteration}`, model: `model-${iteration}` } },
            { type: "response.output_text.done", text },
            { type: "response.output_item.done", item: { type: "function_call", id: `fc_${iteration}`, call_id: callId, name: `tool_${iteration}`, arguments: `{\"iteration\":${iteration}}` } },
            {
              type: "response.completed",
              response: {
                usage: { input_tokens: iteration + 1, output_tokens: iteration + 2 },
                output: [
                  { type: "message", content: [{ type: "output_text", text }] },
                  { type: "function_call", id: `fc_${iteration}`, call_id: callId, name: `tool_${iteration}`, arguments: `{\"iteration\":${iteration}}` },
                ],
              },
            },
          ]),
        ),
        "fallback",
      )

      expect(response.usage.inputTokens).toBe(iteration + 1)
      expect(response.usage.outputTokens).toBe(iteration + 2)
      expect(response.content.some((block) => block.type === "text" && block.text === text)).toBe(true)
      expect(response.content.some((block) => block.type === "tool_call" && block.callId === callId)).toBe(true)
    }
  })
})

describe("Codex upstream provider", () => {
  test("retries once after a 401 response", async () => {
    const calls: string[] = []
    const provider = await Codex_Upstream_Provider.fromAuthFile(await authFile({ type: "oauth", access: "old", refresh: "refresh", expires: Date.now() - 1, accountId: "acct" }), {
      issuer: "https://issuer.test",
      fetch: ((url, init) => {
        calls.push(String(url))
        if (String(url).endsWith("/oauth/token")) {
          return Promise.resolve(
            Response.json({
              access_token: `access-${calls.length}`,
              refresh_token: `refresh-${calls.length}`,
              expires_in: 60,
              id_token: jwt({ chatgpt_account_id: `acct-${calls.length}` }),
            }),
          )
        }
        if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 405 }))
        if (calls.filter((item) => item.includes("/codex/responses")).length === 1) return Promise.resolve(new Response("no", { status: 401 }))
        return Promise.resolve(
          new Response(
            sse([{ type: "response.output_text.done", text: "ok" }, { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } }]),
          ),
        )
      }) as typeof fetch,
    })

    const result = await provider.proxy(canonicalRequest())
    expect(result.type).toBe("canonical_response")
    expect(calls.filter((url) => url.endsWith("/oauth/token"))).toHaveLength(2)
  })

  test("wraps passthrough successes and upstream errors", async () => {
    const passthrough = new Codex_Upstream_Provider({
      accessToken: "access",
      refreshToken: "refresh",
      fetch: (() => Promise.resolve(new Response("raw", { status: 200, statusText: "OK", headers: { "content-type": "application/json" } }))) as typeof fetch,
    })
    const success = await passthrough.proxy(canonicalRequest({ passthrough: true, stream: true }))
    expect(success).toMatchObject({ type: "canonical_passthrough", status: 200, statusText: "OK" })

    const failing = new Codex_Upstream_Provider({
      accessToken: "access",
      refreshToken: "refresh",
      fetch: (() => Promise.resolve(new Response("denied", { status: 418 }))) as typeof fetch,
    })
    const error = await failing.proxy(canonicalRequest())
    expect(error).toEqual({
      type: "canonical_error",
      status: 418,
      headers: new Headers(),
      body: "denied",
    })
  })

  test("parses streaming responses into canonical events", async () => {
    const provider = new Codex_Upstream_Provider({
      accessToken: "access",
      refreshToken: "refresh",
      fetch: (() =>
        Promise.resolve(
          new Response(
            sse([
              { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
              { type: "response.output_text.delta", delta: "ok" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 }, output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] } },
            ]),
          ),
        )) as typeof fetch,
    })

    const result = await provider.proxy(canonicalRequest({ stream: true }))
    expect(result.type).toBe("canonical_stream")

    const events = []
    if (result.type === "canonical_stream") {
      for await (const event of result.events) events.push(event)
    }

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["message_start", "text_delta", "usage", "completion", "message_stop"]),
    )
  })

  test("cancels upstream stream when canonical stream consumer stops", async () => {
    let upstreamCancelled = false
    const provider = new Codex_Upstream_Provider({
      accessToken: "access",
      refreshToken: "refresh",
      fetch: (() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } })}\n\n`))
              },
              cancel() {
                upstreamCancelled = true
              },
            }),
          ),
        )) as typeof fetch,
    })

    const result = await provider.proxy(canonicalRequest({ stream: true }))
    expect(result.type).toBe("canonical_stream")
    if (result.type !== "canonical_stream") return

    const iterator = result.events[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()
    await waitFor(() => upstreamCancelled)

    expect(upstreamCancelled).toBe(true)
  })
})

async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for condition")
}
