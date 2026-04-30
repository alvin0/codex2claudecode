import { afterEach, beforeEach, expect, test } from "bun:test"

import { startRuntime } from "../src/app/runtime"
import { mkdtemp, path, rm, tmpdir, writeFile } from "./helpers"

const tempDirs: string[] = []
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

beforeEach(() => {
  process.env = { ...originalEnv, UPSTREAM_PROVIDER: "codex" }
})

afterEach(async () => {
  process.env = { ...originalEnv }
  globalThis.fetch = originalFetch
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function authFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "smoke-test-"))
  tempDirs.push(dir)
  const file = path.join(dir, "auth-codex.json")
  await writeFile(file, JSON.stringify({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }))
  return file
}

test("server starts and GET /health returns 200", async () => {
  globalThis.fetch = ((url, init) => {
    if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 405 }))
    return Promise.resolve(Response.json({ ok: true }))
  }) as unknown as typeof fetch

  const server = await startRuntime({ authFile: await authFile(), port: 0, healthIntervalMs: 0, logBody: false, quiet: true })
  try {
    const response = await originalFetch(`http://${server.hostname}:${server.port}/health`)
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; runtime: { ok: boolean } }
    expect(body.runtime.ok).toBe(true)
  } finally {
    server.stop(true)
  }
})

test("server starts and GET / returns server info", async () => {
  globalThis.fetch = ((url, init) => {
    if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 405 }))
    return Promise.resolve(Response.json({ ok: true }))
  }) as unknown as typeof fetch

  const server = await startRuntime({ authFile: await authFile(), port: 0, healthIntervalMs: 0, logBody: false, quiet: true })
  try {
    const response = await originalFetch(`http://${server.hostname}:${server.port}/`)
    expect(response.status).toBe(200)
    const body = await response.json() as { message: string; status: string; endpoints: Record<string, string> }
    expect(body.message).toBe("Codex2ClaudeCode")
    expect(body.status).toBe("running")
    expect(body.endpoints.health).toBe("/health")
  } finally {
    server.stop(true)
  }
})
