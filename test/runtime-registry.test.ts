import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Provider_Registry } from "../src/core/registry"
import type { Inbound_Provider, RequestHandlerContext, Route_Descriptor, Upstream_Provider } from "../src/core/interfaces"
import { startRuntimeWithBootstrap } from "../src/app/runtime"

const tempDirs: string[] = []
const originalFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = originalFetch
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function authFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-runtime-registry-test-"))
  tempDirs.push(dir)
  const file = path.join(dir, "auth-codex.json")
  await writeFile(file, JSON.stringify({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }))
  return file
}

class EmptyProvider implements Inbound_Provider {
  readonly name = "empty"

  routes(): Route_Descriptor[] {
    return [{ method: "POST", path: "/v1/messages" }]
  }

  async handle(_request: Request, _route: Route_Descriptor, _upstream: Upstream_Provider, _context: RequestHandlerContext) {
    return new Response("ok")
  }
}

describe("registry runtime integration", () => {
  test("returns 501 when optional upstream endpoints are not implemented", async () => {
    const auth = await authFile()
    const registry = new Provider_Registry()
    registry.register(new EmptyProvider())

    const server = await startRuntimeWithBootstrap(
      { port: 0, healthIntervalMs: 0, logBody: false, quiet: true },
      async () => ({
        authFile: auth,
        authAccount: undefined,
        registry,
        upstream: {
          proxy: async () => {
            throw new Error("should not proxy")
          },
          checkHealth: async () => ({ ok: true }),
        },
      }),
    )
    const base = `http://${server.hostname}:${server.port}`

    try {
      expect((await originalFetch(`${base}/usage`)).status).toBe(501)
      expect((await originalFetch(`${base}/environments`)).status).toBe(501)
    } finally {
      server.stop(true)
    }
  })

  test("runtime stays provider-agnostic while bootstrap owns concrete wiring", async () => {
    const runtimeSource = await readFile(path.join(process.cwd(), "src", "app", "runtime.ts"), "utf8")
    const bootstrapSource = await readFile(path.join(process.cwd(), "src", "app", "bootstrap.ts"), "utf8")

    expect(runtimeSource).not.toContain(`from "./claude"`)
    expect(runtimeSource).not.toContain(`from "./inbound/"`)
    expect(runtimeSource).not.toContain(`from "./upstream/"`)
    expect(bootstrapSource).toContain(`from "../inbound/claude"`)
    expect(bootstrapSource).toContain(`from "../inbound/openai"`)
    expect(bootstrapSource).toContain(`from "../upstream/codex"`)
  })
})
