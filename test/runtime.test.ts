import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { cors, responseHeaders } from "../src/http"
import { startRuntime } from "../src/runtime"
import { sse } from "./helpers"

const tempDirs: string[] = []
const originalFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = originalFetch
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function authFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-runtime-test-"))
  tempDirs.push(dir)
  const file = path.join(dir, "auth-codex.json")
  await writeFile(file, JSON.stringify({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }))
  return file
}

function mockFetch(status = 200) {
  return ((url, init) => {
    if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 405 }))
    if (String(url).includes("/usage")) return Promise.resolve(Response.json({ used: true }))
    if (String(url).includes("/environments")) return Promise.resolve(Response.json([]))
    if (status !== 200) return Promise.resolve(new Response("upstream bad", { status }))
    return Promise.resolve(new Response(sse([{ type: "response.output_text.done", text: "ok" }, { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } }])))
  }) as typeof fetch
}

function rejectingFetch() {
  return ((url, init) => {
    if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 500 }))
    if (String(url).includes("/usage")) return Promise.reject(new Error("usage down"))
    return Promise.resolve(new Response(sse([])))
  }) as typeof fetch
}

function flappingHealthFetch() {
  let heads = 0
  return ((url, init) => {
    if (init?.method === "HEAD") {
      heads += 1
      return Promise.resolve(new Response(null, { status: heads === 1 ? 405 : 500 }))
    }
    return Promise.resolve(Response.json({ ok: true }))
  }) as typeof fetch
}

describe("HTTP helpers", () => {
  test("strips hop-by-hop response headers and adds CORS headers", () => {
    const headers = responseHeaders(
      new Headers({
        "content-encoding": "gzip",
        "content-length": "10",
        connection: "close",
        "set-cookie": "x",
        "x-keep": "yes",
      }),
    )
    expect(headers.get("x-keep")).toBe("yes")
    expect(headers.has("content-length")).toBe(false)

    const response = cors(new Response("ok"))
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
  })
})

describe("runtime server", () => {
  test("serves health, proxy endpoints, Claude endpoints, OpenAI-compatible endpoints, 404, 405, and OPTIONS", async () => {
    globalThis.fetch = mockFetch()
    const logs: any[] = []
    const server = await startRuntime({ authFile: await authFile(), port: 0, healthIntervalMs: 0, logBody: false, onRequestLog: (entry) => logs.push(entry) })
    const base = `http://${server.hostname}:${server.port}`
    try {
      expect((await originalFetch(`${base}/health`)).status).toBe(200)
      expect((await originalFetch(`${base}/usage`)).status).toBe(200)
      expect((await originalFetch(`${base}/environments`)).status).toBe(200)
      expect((await originalFetch(`${base}/v1/messages/count_tokens`, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) })).status).toBe(200)
      expect((await originalFetch(`${base}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) })).status).toBe(200)
      expect((await originalFetch(`${base}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) })).status).toBe(200)
      expect((await originalFetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) })).status).toBe(200)
      expect((await originalFetch(`${base}/v1/unknown`, { method: "POST" })).status).toBe(404)
      expect((await originalFetch(`${base}/v1/responses`)).status).toBe(405)
      expect((await originalFetch(`${base}/v1/responses`, { method: "OPTIONS" })).status).toBe(204)
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "GET", path: "/health", status: 200, durationMs: expect.any(Number), at: expect.any(String) }),
          expect.objectContaining({ method: "POST", path: "/v1/unknown", status: 404, error: "-" }),
        ]),
      )
    } finally {
      server.stop(true)
    }
  })

  test("returns upstream errors and handles invalid JSON through fail path", async () => {
    globalThis.fetch = mockFetch(418)
    const logs: any[] = []
    const server = await startRuntime({ authFile: await authFile(), port: 0, healthIntervalMs: 0, logBody: true, onRequestLog: (entry) => logs.push(entry) })
    const base = `http://${server.hostname}:${server.port}`
    try {
      const upstream = await originalFetch(`${base}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) })
      expect(upstream.status).toBe(418)
      expect(await upstream.text()).toBe("upstream bad")

      const invalid = await originalFetch(`${base}/v1/responses`, { method: "POST", body: "{" })
      expect(invalid.status).toBe(500)
      expect(await invalid.json()).toMatchObject({ error: { message: expect.any(String) } })
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: 418, error: "upstream bad" }),
          expect.objectContaining({ status: 500, error: expect.stringContaining("JSON") }),
        ]),
      )
    } finally {
      server.stop(true)
    }
  })

  test("logs body preview clone failures without failing requests", async () => {
    globalThis.fetch = mockFetch()
    const originalClone = Request.prototype.clone
    Request.prototype.clone = () => {
      throw new Error("clone exploded")
    }
    const server = await startRuntime({ authFile: await authFile(), port: 0, healthIntervalMs: 0, logBody: true })
    const base = `http://${server.hostname}:${server.port}`
    try {
      const response = await originalFetch(`${base}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) })
      expect(response.status).toBe(200)
    } finally {
      Request.prototype.clone = originalClone
      server.stop(true)
    }
  })

  test("reports unhealthy health state, proxy failures, and clears interval timers", async () => {
    globalThis.fetch = rejectingFetch()
    const server = await startRuntime({ authFile: await authFile(), port: 0, healthIntervalMs: 5, logBody: false })
    const base = `http://${server.hostname}:${server.port}`
    try {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const health = await originalFetch(`${base}/health`)
      expect(health.status).toBe(503)
      const usage = await originalFetch(`${base}/usage`)
      expect(usage.status).toBe(500)
      expect(await usage.json()).toEqual({ error: { message: "usage down" } })
    } finally {
      server.stop(true)
    }
  })

  test("logs health transitions from healthy to unhealthy", async () => {
    globalThis.fetch = flappingHealthFetch()
    const server = await startRuntime({ authFile: await authFile(), port: 0, healthIntervalMs: 5, logBody: false })
    try {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const health = await originalFetch(`http://${server.hostname}:${server.port}/health`)
      expect(health.status).toBe(503)
    } finally {
      server.stop(true)
    }
  })
})
