import { describe, expect, test } from "bun:test"

import { Provider_Registry } from "../../src/core/registry"
import type { Inbound_Provider, RequestHandlerContext, Route_Descriptor, Upstream_Provider } from "../../src/core/interfaces"

class FakeProvider implements Inbound_Provider {
  constructor(
    readonly name: string,
    private readonly descriptors: Route_Descriptor[],
  ) {}

  routes() {
    return this.descriptors
  }

  async handle(_request: Request, _route: Route_Descriptor, _upstream: Upstream_Provider, _context: RequestHandlerContext) {
    return new Response(this.name)
  }
}

describe("Provider_Registry", () => {
  test("matches parameterized paths and exact routes", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("models", [{ method: "GET", path: "/v1/models/:model_id" }]))
    registry.register(new FakeProvider("messages", [{ method: "POST", path: "/v1/messages" }]))

    expect(registry.match("GET", "/v1/models/gpt-5.4", new Headers())?.provider.name).toBe("models")
    expect(registry.match("POST", "/v1/messages", new Headers())?.provider.name).toBe("messages")
    expect(registry.match("GET", "/v1/missing", new Headers())).toBeUndefined()
  })

  test("resolves basePath prefixes", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("prefixed", [{ method: "POST", basePath: "/proxy", path: "/v1/messages" }]))

    expect(registry.match("POST", "/proxy/v1/messages", new Headers())?.provider.name).toBe("prefixed")
  })

  test("orders by exact header, then presence, then none", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("none", [{ method: "POST", path: "/v1/messages" }]))
    registry.register(new FakeProvider("presence", [{ method: "POST", path: "/v1/messages", headerDiscriminator: { name: "x-mode", mode: "presence" } }]))
    registry.register(new FakeProvider("exact", [{ method: "POST", path: "/v1/messages", headerDiscriminator: { name: "x-mode", mode: "exact", value: "claude" } }]))

    expect(registry.match("POST", "/v1/messages", new Headers({ "x-mode": "claude" }))?.provider.name).toBe("exact")
    expect(registry.match("POST", "/v1/messages", new Headers({ "x-mode": "other" }))?.provider.name).toBe("presence")
    expect(registry.match("POST", "/v1/messages", new Headers())?.provider.name).toBe("none")
  })

  test("uses registration order within the same specificity for overlapping paths", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("first", [{ method: "GET", path: "/v1/models/:model_id" }]))
    registry.register(new FakeProvider("second", [{ method: "GET", path: "/v1/models/latest" }]))

    expect(registry.match("GET", "/v1/models/latest", new Headers())?.provider.name).toBe("first")
  })

  test("reports both provider names in conflict errors", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("claude", [{ method: "POST", path: "/v1/messages" }]))

    expect(() => registry.register(new FakeProvider("openai", [{ method: "POST", path: "/v1/messages" }]))).toThrow(
      "between providers claude and openai",
    )
  })

  test("listRoutes returns provider ownership", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("claude", [{ method: "POST", path: "/v1/messages" }]))
    registry.register(new FakeProvider("models", [{ method: "GET", path: "/v1/models/:model_id" }]))

    expect(registry.listRoutes()).toEqual([
      { method: "POST", path: "/v1/messages", provider: "claude" },
      { method: "GET", path: "/v1/models/:model_id", provider: "models" },
    ])
  })
})
