import { afterEach, describe, expect, test } from "bun:test"

import { Provider_Registry } from "../src/core/registry"
import type { Inbound_Provider, RequestHandlerContext, Route_Descriptor, Upstream_Provider } from "../src/core/interfaces"
import { startRuntimeWithBootstrap } from "../src/app/runtime"
import { mkdtemp, path, readFile, rm, tmpdir, writeFile } from "./helpers"

const tempDirs: string[] = []
const originalFetch = globalThis.fetch
const bunServe = Bun as unknown as { serve: typeof Bun.serve }
const originalServe = Bun.serve

afterEach(async () => {
  globalThis.fetch = originalFetch
  bunServe.serve = originalServe
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

  constructor(
    private readonly route: Route_Descriptor = { method: "POST", path: "/v1/messages" },
    private readonly onHandle?: (route: Route_Descriptor) => void,
  ) {}

  routes(): Route_Descriptor[] {
    return [this.route]
  }

  async handle(_request: Request, route: Route_Descriptor, _upstream: Upstream_Provider, _context: RequestHandlerContext) {
    this.onHandle?.(route)
    return new Response("ok")
  }
}

describe("registry runtime integration", () => {
  test("disables Bun idle timeout for matched /v1 API requests before provider handling", async () => {
    const auth = await authFile()
    const events: string[] = []
    const registry = new Provider_Registry()
    registry.register(new EmptyProvider(undefined, (route) => events.push(`handle:${route.path}`)))
    type CapturedFetch = (request: Request, server: unknown) => Response | Promise<Response>
    const captures: Array<{ fetch: CapturedFetch; server: unknown }> = []
    let nextPort = 8787
    let throwOnTimeout = false
    const latestCapture = () => {
      const capture = captures[captures.length - 1]
      if (!capture) throw new Error("Bun.serve fetch handler was not captured")
      return capture
    }

    bunServe.serve = ((options: { fetch: CapturedFetch }) => {
      const fakeServer = {
        hostname: "127.0.0.1",
        port: nextPort++,
        timeout(request: Request, seconds: number) {
          events.push(`timeout:${new URL(request.url).pathname}:${seconds}`)
          if (throwOnTimeout) throw new Error("timeout failed")
        },
        stop: () => Promise.resolve(),
      }
      captures.push({ fetch: options.fetch, server: fakeServer })
      return fakeServer as ReturnType<typeof Bun.serve>
    }) as typeof Bun.serve

    const server = await startRuntimeWithBootstrap(
      {
        port: 0,
        healthIntervalMs: 0,
        logBody: false,
        quiet: true,
        requestLogMode: () => {
          events.push("mode")
          return "sync"
        },
      },
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

    events.length = 0
    try {
      const capture = latestCapture()
      const missing = await capture.fetch(new Request("http://127.0.0.1:8787/v1/unknown", { method: "POST" }), capture.server)
      expect(missing.status).toBe(404)
      expect(events).toEqual(["mode"])
      events.length = 0

      const response = await capture.fetch(new Request("http://127.0.0.1:8787/v1/messages", { method: "POST", body: "{}" }), capture.server)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("ok")
      expect(events).toEqual(["timeout:/v1/messages:0", "mode", "handle:/v1/messages"])

      events.length = 0
      const prefixedRegistry = new Provider_Registry()
      prefixedRegistry.register(new EmptyProvider({ method: "POST", basePath: "/proxy", path: "/v1/messages" }, (route) => events.push(`handle:${route.basePath}${route.path}`)))
      const prefixedServer = await startRuntimeWithBootstrap(
        { port: 0, healthIntervalMs: 0, logBody: false, quiet: true },
        async () => ({
          authFile: auth,
          authAccount: undefined,
          registry: prefixedRegistry,
          upstream: {
            proxy: async () => {
              throw new Error("should not proxy")
            },
            checkHealth: async () => ({ ok: true }),
          },
        }),
      )
      try {
        const prefixedCapture = latestCapture()
        const prefixed = await prefixedCapture.fetch(new Request("http://127.0.0.1:8787/proxy/v1/messages", { method: "POST", body: "{}" }), prefixedCapture.server)
        expect(prefixed.status).toBe(200)
        expect(await prefixed.text()).toBe("ok")
        expect(events).toEqual(["timeout:/proxy/v1/messages:0", "handle:/proxy/v1/messages"])
      } finally {
        prefixedServer.stop(true)
      }

      events.length = 0
      const dynamicVersionRegistry = new Provider_Registry()
      dynamicVersionRegistry.register(new EmptyProvider({ method: "POST", path: "/:version/messages" }, (route) => events.push(`handle:${route.path}`)))
      const dynamicVersionServer = await startRuntimeWithBootstrap(
        { port: 0, healthIntervalMs: 0, logBody: false, quiet: true },
        async () => ({
          authFile: auth,
          authAccount: undefined,
          registry: dynamicVersionRegistry,
          upstream: {
            proxy: async () => {
              throw new Error("should not proxy")
            },
            checkHealth: async () => ({ ok: true }),
          },
        }),
      )
      try {
        const dynamicVersionCapture = latestCapture()
        const dynamicVersion = await dynamicVersionCapture.fetch(new Request("http://127.0.0.1:8787/v1/messages", { method: "POST", body: "{}" }), dynamicVersionCapture.server)
        expect(dynamicVersion.status).toBe(200)
        expect(await dynamicVersion.text()).toBe("ok")
        expect(events).toEqual(["timeout:/v1/messages:0", "handle:/:version/messages"])
      } finally {
        dynamicVersionServer.stop(true)
      }

      events.length = 0
      const dynamicRegistry = new Provider_Registry()
      dynamicRegistry.register(new EmptyProvider({ method: "POST", path: "/models/:model_id" }, (route) => events.push(`handle:${route.path}`)))
      const dynamicServer = await startRuntimeWithBootstrap(
        { port: 0, healthIntervalMs: 0, logBody: false, quiet: true },
        async () => ({
          authFile: auth,
          authAccount: undefined,
          registry: dynamicRegistry,
          upstream: {
            proxy: async () => {
              throw new Error("should not proxy")
            },
            checkHealth: async () => ({ ok: true }),
          },
        }),
      )
      try {
        const dynamicCapture = latestCapture()
        const dynamic = await dynamicCapture.fetch(new Request("http://127.0.0.1:8787/models/v1", { method: "POST", body: "{}" }), dynamicCapture.server)
        expect(dynamic.status).toBe(200)
        expect(await dynamic.text()).toBe("ok")
        expect(events).toEqual(["handle:/models/:model_id"])
      } finally {
        dynamicServer.stop(true)
      }

      events.length = 0
      const staticNonV1Registry = new Provider_Registry()
      staticNonV1Registry.register(new EmptyProvider({ method: "POST", path: "/models/v1" }, (route) => events.push(`handle:${route.path}`)))
      const staticNonV1Server = await startRuntimeWithBootstrap(
        { port: 0, healthIntervalMs: 0, logBody: false, quiet: true },
        async () => ({
          authFile: auth,
          authAccount: undefined,
          registry: staticNonV1Registry,
          upstream: {
            proxy: async () => {
              throw new Error("should not proxy")
            },
            checkHealth: async () => ({ ok: true }),
          },
        }),
      )
      try {
        const staticNonV1Capture = latestCapture()
        const staticNonV1 = await staticNonV1Capture.fetch(new Request("http://127.0.0.1:8787/models/v1", { method: "POST", body: "{}" }), staticNonV1Capture.server)
        expect(staticNonV1.status).toBe(200)
        expect(await staticNonV1.text()).toBe("ok")
        expect(events).toEqual(["handle:/models/v1"])
      } finally {
        staticNonV1Server.stop(true)
      }

      events.length = 0
      throwOnTimeout = true
      const timeoutFailureRegistry = new Provider_Registry()
      timeoutFailureRegistry.register(new EmptyProvider(undefined, (route) => events.push(`handle:${route.path}`)))
      const timeoutFailureServer = await startRuntimeWithBootstrap(
        { port: 0, healthIntervalMs: 0, logBody: false, quiet: true },
        async () => ({
          authFile: auth,
          authAccount: undefined,
          registry: timeoutFailureRegistry,
          upstream: {
            proxy: async () => {
              throw new Error("should not proxy")
            },
            checkHealth: async () => ({ ok: true }),
          },
        }),
      )
      try {
        const timeoutFailureCapture = latestCapture()
        const timeoutFailure = await timeoutFailureCapture.fetch(new Request("http://127.0.0.1:8787/v1/messages", { method: "POST", body: "{}" }), timeoutFailureCapture.server)
        expect(timeoutFailure.status).toBe(200)
        expect(await timeoutFailure.text()).toBe("ok")
        expect(events).toEqual(["timeout:/v1/messages:0", "handle:/v1/messages"])
      } finally {
        throwOnTimeout = false
        timeoutFailureServer.stop(true)
      }
    } finally {
      server.stop(true)
    }
  })

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
    expect(bootstrapSource).toContain(`from "../inbound/claude/codex"`)
    expect(bootstrapSource).toContain(`from "../inbound/claude/kiro"`)
    expect(bootstrapSource).toContain(`from "../inbound/openai"`)
    expect(bootstrapSource).toContain(`from "../upstream/codex"`)
  })
})
