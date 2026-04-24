import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { LOG_BODY_PREVIEW_LIMIT } from "../src/core/constants"
import { cors, responseHeaders } from "../src/core/http"
import { readRequestLogDetail, requestLogFilePath } from "../src/core/request-logs"
import { startRuntime } from "../src/app/runtime"
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
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
  test("falls back to the next port when the preferred port is already in use", async () => {
    globalThis.fetch = mockFetch()
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("blocked")
      },
    })
    const requestedPort = blocker.port
    try {
      const server = await startRuntime({ authFile: await authFile(), hostname: "127.0.0.1", port: requestedPort, healthIntervalMs: 0, logBody: false })
      try {
        expect(server.port).toBe(requestedPort + 1)
        expect((await originalFetch(`http://${server.hostname}:${server.port}/health`)).status).toBe(200)
      } finally {
        server.stop(true)
      }
    } finally {
      blocker.stop(true)
    }
  })

  test("serves health, proxy endpoints, Claude endpoints, OpenAI-compatible endpoints, 404, 405, and OPTIONS", async () => {
    globalThis.fetch = mockFetch()
    const logs: any[] = []
    const server = await startRuntime({ authFile: await authFile(), port: 0, healthIntervalMs: 0, logBody: false, onRequestLog: (entry) => logs.push(entry) })
    const base = `http://${server.hostname}:${server.port}`
    try {
      expect((await originalFetch(`${base}/health`)).status).toBe(200)
      expect((await originalFetch(`${base}/usage`)).status).toBe(200)
      expect((await originalFetch(`${base}/environments`)).status).toBe(200)
      expect((await originalFetch(`${base}/v1/messages/count_tokens`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) })).status).toBe(200)
      expect((await originalFetch(`${base}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) })).status).toBe(200)
      expect((await originalFetch(`${base}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) })).status).toBe(200)
      expect((await originalFetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) })).status).toBe(200)
      expect((await originalFetch(`${base}/v1/unknown`, { method: "POST" })).status).toBe(404)
      expect((await originalFetch(`${base}/v1/responses`)).status).toBe(405)
      expect((await originalFetch(`${base}/v1/responses`, { method: "OPTIONS" })).status).toBe(204)
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "GET",
            path: "/health",
            status: 200,
            durationMs: expect.any(Number),
            at: expect.any(String),
            requestHeaders: expect.any(Object),
          }),
          expect.objectContaining({ method: "GET", path: "/usage", status: 200, proxy: expect.objectContaining({ status: 200, target: "/usage" }) }),
          expect.objectContaining({ method: "POST", path: "/v1/messages", status: 200, proxy: expect.objectContaining({ status: 200, target: "/v1/responses" }) }),
          expect.objectContaining({ method: "POST", path: "/v1/unknown", status: 404, error: "Not found", requestHeaders: expect.any(Object) }),
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
          expect.objectContaining({ status: 418, error: "upstream bad", proxy: expect.objectContaining({ status: 418, error: "upstream bad" }) }),
          expect.objectContaining({ status: 500, error: expect.stringContaining("JSON") }),
        ]),
      )
    } finally {
      server.stop(true)
    }
  })

  test("logs Claude endpoint error messages", async () => {
    globalThis.fetch = mockFetch()
    const logs: any[] = []
    const server = await startRuntime({ authFile: await authFile(), port: 0, healthIntervalMs: 0, logBody: false, onRequestLog: (entry) => logs.push(entry) })
    const base = `http://${server.hostname}:${server.port}`
    try {
      const invalid = await originalFetch(`${base}/v1/messages`, { method: "POST", body: "{" })
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error", message: expect.stringContaining("Invalid JSON") } })

      const convertError = await originalFetch(`${base}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          mcp_servers: [{ name: "bad", url: "" }],
          tools: [{ type: "mcp_toolset", mcp_server_name: "bad" }],
        }),
      })
      expect(convertError.status).toBe(400)
      expect(await convertError.json()).toEqual({
        type: "error",
        error: { type: "invalid_request_error", message: "MCP server bad requires url or connector_id" },
      })
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "POST",
            path: "/v1/messages",
            status: 400,
            error: expect.stringContaining("Invalid JSON"),
            proxy: undefined,
          }),
          expect.objectContaining({
            method: "POST",
            path: "/v1/messages",
            status: 400,
            error: "MCP server bad requires url or connector_id",
            proxy: undefined,
          }),
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
      await response.text()
    } finally {
      Request.prototype.clone = originalClone
      server.stop(true)
    }
  })

  test("stores truncated request body previews in memory and on disk", async () => {
    globalThis.fetch = mockFetch()
    const logs: any[] = []
    const auth = await authFile()
    const server = await startRuntime({ authFile: auth, port: 0, healthIntervalMs: 0, logBody: true, quiet: true, onRequestLog: (entry) => logs.push(entry) })
    const base = `http://${server.hostname}:${server.port}`
    const longInput = "x".repeat(LOG_BODY_PREVIEW_LIMIT + 100)
    try {
      const response = await originalFetch(`${base}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "m", input: longInput }) })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("response.output_text.done")
      const entry = logs[logs.length - 1]
      expect(entry.requestBody).not.toContain(longInput)
      expect(entry.requestBody.length).toBe(LOG_BODY_PREVIEW_LIMIT)
      expect(entry.proxy?.requestBody).not.toContain(longInput)
      expect(entry.proxy?.requestBody.length).toBe(LOG_BODY_PREVIEW_LIMIT)
      expect(entry.proxy?.responseBody).toContain("response.output_text.done")
      expect(entry.proxy?.responseBody).toContain("ok")
      expect(entry.responseBody).toContain("response.output_text.done")
      expect(entry.responseBody).toContain("ok")

      const persisted = (await readFile(requestLogFilePath(auth), "utf8")).trim().split("\n").map((line: string) => JSON.parse(line))
      const persistedEntry = persisted[persisted.length - 1]
      const persistedDetail = await readRequestLogDetail(auth, persistedEntry)
      expect(persistedEntry).toMatchObject({
        id: entry.id,
        detailFile: expect.any(String),
        proxy: expect.objectContaining({
          status: 200,
        }),
      })
      expect(persistedEntry.requestBody).toBeUndefined()
      expect(persistedEntry.responseBody).toBeUndefined()
      expect(persistedEntry.proxy.requestBody).toBeUndefined()
      expect(persistedEntry.proxy.responseBody).toBeUndefined()
      expect(persistedDetail).toMatchObject({
        id: entry.id,
        requestBody: entry.requestBody,
        responseBody: entry.responseBody,
        proxy: expect.objectContaining({
          requestBody: entry.proxy?.requestBody,
          responseBody: entry.proxy?.responseBody,
        }),
      })
    } finally {
      server.stop(true)
    }
  })

  test("stores raw Codex proxy response body for Claude messages", async () => {
    globalThis.fetch = mockFetch()
    const logs: any[] = []
    const auth = await authFile()
    const server = await startRuntime({ authFile: auth, port: 0, healthIntervalMs: 0, logBody: true, quiet: true, onRequestLog: (entry) => logs.push(entry) })
    const base = `http://${server.hostname}:${server.port}`
    try {
      const response = await originalFetch(`${base}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("content_block")

      const entry = logs[logs.length - 1]
      expect(entry.path).toBe("/v1/messages")
      expect(entry.responseBody).toContain("content_block")
      expect(entry.proxy?.responseBody).toContain("response.output_text.done")
      expect(entry.proxy?.responseBody).toContain('"text":"ok"')
      expect(entry.proxy?.responseBody).not.toContain('"type":"text_done"')

      const persisted = (await readFile(requestLogFilePath(auth), "utf8")).trim().split("\n").map((line: string) => JSON.parse(line))
      const persistedDetail = await readRequestLogDetail(auth, persisted[persisted.length - 1])
      expect(persistedDetail.proxy?.responseBody).toBe(entry.proxy?.responseBody)
    } finally {
      server.stop(true)
    }
  })

  test("continues serving when request log file cannot be created", async () => {
    globalThis.fetch = mockFetch()
    const auth = await authFile()
    // Block log writes by placing a directory where the log file should be
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(path.dirname(auth), "request-logs-recent.ndjson"), { recursive: true }))
    const logs: any[] = []
    const server = await startRuntime({ authFile: auth, port: 0, healthIntervalMs: 0, logBody: false, quiet: true, onRequestLog: (entry) => logs.push(entry) })
    const base = `http://${server.hostname}:${server.port}`
    try {
      const response = await originalFetch(`${base}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) })
      expect(response.status).toBe(200)
      expect(logs).toEqual([expect.objectContaining({ path: "/v1/messages", status: 200 })])
    } finally {
      server.stop(true)
    }
  })

  test("emits in-process request logs before completion", async () => {
    const upstream = deferred<Response>()
    globalThis.fetch = ((url, init) => {
      if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 405 }))
      if (String(url).includes("/usage")) return Promise.resolve(Response.json({ used: true }))
      if (String(url).includes("/environments")) return Promise.resolve(Response.json([]))
      return upstream.promise
    }) as typeof fetch
    const startedLogs: any[] = []
    const completedLogs: any[] = []
    const server = await startRuntime({
      authFile: await authFile(),
      port: 0,
      healthIntervalMs: 0,
      logBody: false,
      onRequestLogStart: (entry) => startedLogs.push(entry),
      onRequestLog: (entry) => completedLogs.push(entry),
    })
    const base = `http://${server.hostname}:${server.port}`
    try {
      const responsePromise = originalFetch(`${base}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) })
      await waitFor(() => startedLogs.length > 0)
      expect(completedLogs).toHaveLength(0)
      expect(startedLogs[startedLogs.length - 1]).toMatchObject({
        state: "pending",
        path: "/v1/responses",
        status: 0,
        durationMs: 0,
      })

      upstream.resolve(new Response(sse([{ type: "response.output_text.done", text: "ok" }])))
      expect((await responsePromise).status).toBe(200)
      expect(completedLogs[completedLogs.length - 1]).toMatchObject({
        id: startedLogs[startedLogs.length - 1].id,
        state: "complete",
        path: "/v1/responses",
        status: 200,
      })
    } finally {
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

async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for condition")
}
