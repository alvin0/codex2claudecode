import { afterEach, describe, expect, test } from "bun:test"

import { OpenAI_Inbound_Provider } from "../../src/inbound/openai"
import { codexConfigPath, writeCodexFastModeConfig } from "../../src/upstream/codex/fast-mode"
import { normalizeCanonicalRequest, normalizeRequestBody } from "../../src/inbound/openai/normalize"
import { mkdtemp, path, readFile, rm, tmpdir, writeFile } from "../helpers"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempAuthFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "openai-inbound-test-"))
  tempDirs.push(dir)
  return path.join(dir, "auth-codex.json")
}

describe("OpenAI inbound normalization", () => {
  test("normalizes responses and chat completions into canonical requests", () => {
    expect(normalizeCanonicalRequest("/v1/responses", { model: "gpt-5.4_high", input: "hello" })).toMatchObject({
      model: "gpt-5.4",
      instructions: "You are a helpful assistant.",
      passthrough: true,
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    })

    expect(
      normalizeCanonicalRequest("/v1/chat/completions", {
        model: "gpt-5.4",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "there" },
        ],
      }),
    ).toMatchObject({
      model: "gpt-5.4",
      instructions: "sys",
      passthrough: true,
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "there" }] },
      ],
    })
  })

  test("keeps the legacy normalizeRequestBody output shape", () => {
    expect(normalizeRequestBody("/v1/responses", { model: "gpt-5.4_high", input: "hello" })).toEqual({
      model: "gpt-5.4",
      reasoning: { effort: "high" },
      instructions: "You are a helpful assistant.",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      store: false,
      stream: true,
    })
  })

  test("property: randomized OpenAI requests become valid canonical requests", () => {
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const responsesRequest = normalizeCanonicalRequest("/v1/responses", {
        model: `model-${iteration}`,
        input: `input-${iteration}`,
        tools: Array.from({ length: iteration % 3 }, (_, index) => ({ type: "function", name: `tool_${index}` })),
      })
      expect(responsesRequest.model).toBe(`model-${iteration}`)
      expect(responsesRequest.input).toHaveLength(1)
      expect(responsesRequest.passthrough).toBe(true)
      expect(responsesRequest.tools?.length ?? 0).toBe(iteration % 3)

      const chatRequest = normalizeCanonicalRequest("/v1/chat/completions", {
        model: `chat-${iteration}`,
        messages: Array.from({ length: (iteration % 4) + 1 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message-${index}`,
        })),
      })
      expect(chatRequest.model).toBe(`chat-${iteration}`)
      expect(chatRequest.input).toHaveLength((iteration % 4) + 1)
      expect(chatRequest.passthrough).toBe(true)
    }
  })
})

describe("OpenAI inbound provider", () => {
  test("forwards passthrough successes, upstream errors, and invalid JSON", async () => {
    const provider = new OpenAI_Inbound_Provider()
    const upstream = {
      proxy: () =>
        Promise.resolve({
          type: "canonical_passthrough" as const,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-type": "text/event-stream" }),
          body: new Response("event: message\ndata: ok\n\n").body,
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const response = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("event: message\ndata: ok\n\n")

    const failingUpstream = {
      proxy: () =>
        Promise.resolve({
          type: "canonical_error" as const,
          status: 418,
          headers: new Headers({ "content-type": "text/plain" }),
          body: "denied",
        }),
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    const error = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
      { path: "/v1/responses", method: "POST" },
      failingUpstream,
      { requestId: "req_2", logBody: false, quiet: true },
    )
    expect(error.status).toBe(418)
    expect(await error.text()).toBe("denied")

    const invalid = await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: "{" }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_3", logBody: false, quiet: true },
    )
    expect(invalid.status).toBe(500)
    expect(await invalid.json()).toEqual({ error: { message: expect.stringContaining("Invalid JSON") } })
  })

  test("does not inject service tier at inbound level", async () => {
    const authFile = await tempAuthFile()
    await writeCodexFastModeConfig(authFile, { enabled: true })
    let capturedRequest: any
    const provider = new OpenAI_Inbound_Provider()
    const upstream = {
      proxy: (request: unknown) => {
        capturedRequest = request
        return Promise.resolve({
          type: "canonical_passthrough" as const,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          body: "ok",
        })
      },
      checkHealth: () => Promise.resolve({ ok: true }),
    }

    await provider.handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
      { path: "/v1/responses", method: "POST" },
      upstream,
      { requestId: "req_fast", authFile, logBody: false, quiet: true },
    )

    expect(capturedRequest.metadata.serviceTier).toBeUndefined()
  })

  test("stores Codex fast mode inside shared Codex config file", async () => {
    const authFile = await tempAuthFile()
    await writeFile(codexConfigPath(authFile), `${JSON.stringify({ other: { value: true } }, null, 2)}\n`)
    await writeCodexFastModeConfig(authFile, { enabled: true })

    expect(JSON.parse(await readFile(codexConfigPath(authFile), "utf8"))).toEqual({
      other: { value: true },
      fastMode: { enabled: true },
    })
  })
})
