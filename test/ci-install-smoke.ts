#!/usr/bin/env bun

/**
 * CI install smoke test — run from a clean directory against an installed
 * tarball. Verifies the server starts and /health responds.
 *
 * Usage (CI):
 *   bun run test/ci-install-smoke.ts <path-to-installed-package>
 *
 * The argument should be the resolved path to the installed package directory,
 * e.g. /work/test-project/node_modules/codex2claudecode
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const pkgDir = process.argv[2]
if (!pkgDir) {
  console.error("Usage: bun run ci-install-smoke.ts <installed-package-dir>")
  process.exit(1)
}

const resolvedPkg = resolve(pkgDir)

const { startRuntimeWithBootstrap } = await import(`${resolvedPkg}/src/app/runtime.ts`)
const { Provider_Registry } = await import(`${resolvedPkg}/src/core/registry.ts`)

const dir = mkdtempSync(join(tmpdir(), "smoke-auth-"))
const authFile = join(dir, "auth.json")
writeFileSync(authFile, JSON.stringify({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 }))

const originalFetch = globalThis.fetch
globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
  const target = String(url)
  if (target.includes("127.0.0.1")) return originalFetch(url, init)
  if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 405 }))
  return Promise.resolve(Response.json({ ok: true }))
}) as typeof fetch

try {
  const server = await startRuntimeWithBootstrap(
    { port: 0, hostname: "127.0.0.1", healthIntervalMs: 0, logBody: false, quiet: true },
    async () => ({
      authFile,
      registry: new Provider_Registry(),
      upstream: {
        proxy: () => { throw new Error("not implemented") },
        inputTokens: () => { throw new Error("not implemented") },
        checkHealth: async () => ({ ok: true, status: "mock", latencyMs: 0 }),
        listModels: async () => [],
      },
    }),
  )

  try {
    const health = await originalFetch(`http://127.0.0.1:${server.port}/health`)
    if (health.status !== 200 && health.status !== 503) {
      console.error("GET /health returned", health.status)
      process.exit(1)
    }
    console.log("GET /health:", health.status)

    const root = await originalFetch(`http://127.0.0.1:${server.port}/`)
    if (root.status !== 200) {
      console.error("GET / returned", root.status)
      process.exit(1)
    }
    const rootBody = (await root.json()) as { status: string }
    if (rootBody.status !== "running") {
      console.error("Unexpected status:", rootBody.status)
      process.exit(1)
    }
    console.log("GET /: running")
    console.log("Install smoke test passed")
  } finally {
    server.stop(true)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
