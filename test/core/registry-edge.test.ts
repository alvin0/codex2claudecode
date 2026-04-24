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

describe("Provider_Registry edge cases", () => {
  // --- Path matching edge cases ---

  test("trailing slash still matches route (path normalization strips trailing slash)", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("messages", [{ method: "POST", path: "/v1/messages" }]))

    // The registry normalizes paths, so trailing slash is equivalent
    expect(registry.match("POST", "/v1/messages/", new Headers())?.provider.name).toBe("messages")
  })

  test("double slashes in pathname do not match", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("messages", [{ method: "POST", path: "/v1/messages" }]))

    expect(registry.match("POST", "/v1//messages", new Headers())).toBeUndefined()
  })

  test("empty pathname matches root route", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("root", [{ method: "GET", path: "/" }]))

    expect(registry.match("GET", "/", new Headers())?.provider.name).toBe("root")
  })

  test("parameterized segment does not match empty segment", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("models", [{ method: "GET", path: "/v1/models/:model_id" }]))

    // trailing slash creates an empty segment after "models"
    expect(registry.match("GET", "/v1/models/", new Headers())).toBeUndefined()
  })

  test("parameterized segment matches any non-empty value", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("models", [{ method: "GET", path: "/v1/models/:model_id" }]))

    expect(registry.match("GET", "/v1/models/gpt-5.4", new Headers())?.provider.name).toBe("models")
    expect(registry.match("GET", "/v1/models/a", new Headers())?.provider.name).toBe("models")
    expect(registry.match("GET", "/v1/models/with%20spaces", new Headers())?.provider.name).toBe("models")
    expect(registry.match("GET", "/v1/models/123", new Headers())?.provider.name).toBe("models")
  })

  test("extra path segments do not match shorter route", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("messages", [{ method: "POST", path: "/v1/messages" }]))

    expect(registry.match("POST", "/v1/messages/extra", new Headers())).toBeUndefined()
    expect(registry.match("POST", "/v1/messages/extra/more", new Headers())).toBeUndefined()
  })

  test("fewer path segments do not match longer route", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("models", [{ method: "GET", path: "/v1/models/:model_id" }]))

    expect(registry.match("GET", "/v1/models", new Headers())).toBeUndefined()
    expect(registry.match("GET", "/v1", new Headers())).toBeUndefined()
  })

  // --- Method matching edge cases ---

  test("method matching is case-sensitive", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("messages", [{ method: "POST", path: "/v1/messages" }]))

    expect(registry.match("POST", "/v1/messages", new Headers())?.provider.name).toBe("messages")
    expect(registry.match("post", "/v1/messages", new Headers())).toBeUndefined()
    expect(registry.match("Post", "/v1/messages", new Headers())).toBeUndefined()
  })

  test("GET and POST on same path are independent routes", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("getter", [{ method: "GET", path: "/v1/data" }]))
    registry.register(new FakeProvider("poster", [{ method: "POST", path: "/v1/data" }]))

    expect(registry.match("GET", "/v1/data", new Headers())?.provider.name).toBe("getter")
    expect(registry.match("POST", "/v1/data", new Headers())?.provider.name).toBe("poster")
    expect(registry.match("PUT", "/v1/data", new Headers())).toBeUndefined()
  })

  // --- Header discriminator edge cases ---

  test("header discriminator name comparison is case-insensitive for conflict detection", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("first", [{ method: "POST", path: "/v1/messages", headerDiscriminator: { name: "X-Mode", mode: "exact", value: "claude" } }]))

    expect(() =>
      registry.register(new FakeProvider("second", [{ method: "POST", path: "/v1/messages", headerDiscriminator: { name: "x-mode", mode: "exact", value: "claude" } }])),
    ).toThrow("Route conflict")
  })

  test("different exact header values do not conflict", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("claude", [{ method: "POST", path: "/v1/messages", headerDiscriminator: { name: "x-mode", mode: "exact", value: "claude" } }]))
    registry.register(new FakeProvider("openai", [{ method: "POST", path: "/v1/messages", headerDiscriminator: { name: "x-mode", mode: "exact", value: "openai" } }]))

    expect(registry.match("POST", "/v1/messages", new Headers({ "x-mode": "claude" }))?.provider.name).toBe("claude")
    expect(registry.match("POST", "/v1/messages", new Headers({ "x-mode": "openai" }))?.provider.name).toBe("openai")
  })

  test("presence discriminator rejects when header is absent", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("guarded", [{ method: "POST", path: "/v1/messages", headerDiscriminator: { name: "x-api-key", mode: "presence" } }]))

    expect(registry.match("POST", "/v1/messages", new Headers({ "x-api-key": "anything" }))?.provider.name).toBe("guarded")
    expect(registry.match("POST", "/v1/messages", new Headers())).toBeUndefined()
  })

  test("exact discriminator rejects when header value does not match", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("exact", [{ method: "POST", path: "/v1/messages", headerDiscriminator: { name: "x-mode", mode: "exact", value: "claude" } }]))

    expect(registry.match("POST", "/v1/messages", new Headers({ "x-mode": "claude" }))?.provider.name).toBe("exact")
    expect(registry.match("POST", "/v1/messages", new Headers({ "x-mode": "openai" }))).toBeUndefined()
    expect(registry.match("POST", "/v1/messages", new Headers())).toBeUndefined()
  })

  // --- basePath edge cases ---

  test("basePath with trailing slash normalizes correctly", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("prefixed", [{ method: "POST", basePath: "/proxy/", path: "/v1/messages" }]))

    expect(registry.match("POST", "/proxy/v1/messages", new Headers())?.provider.name).toBe("prefixed")
  })

  test("basePath only (empty path) matches basePath root", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("base", [{ method: "GET", basePath: "/api", path: "/" }]))

    expect(registry.match("GET", "/api", new Headers())?.provider.name).toBe("base")
  })

  test("multiple basePaths do not conflict when paths differ", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("v1", [{ method: "POST", basePath: "/v1", path: "/messages" }]))
    registry.register(new FakeProvider("v2", [{ method: "POST", basePath: "/v2", path: "/messages" }]))

    expect(registry.match("POST", "/v1/messages", new Headers())?.provider.name).toBe("v1")
    expect(registry.match("POST", "/v2/messages", new Headers())?.provider.name).toBe("v2")
  })

  // --- Conflict detection edge cases ---

  test("parameterized paths with different names still conflict", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("first", [{ method: "GET", path: "/v1/models/:model_id" }]))

    expect(() =>
      registry.register(new FakeProvider("second", [{ method: "GET", path: "/v1/models/:id" }])),
    ).toThrow("Route conflict")
  })

  test("exact and presence discriminators on same path do not conflict", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("exact", [{ method: "POST", path: "/v1/messages", headerDiscriminator: { name: "x-mode", mode: "exact", value: "claude" } }]))
    registry.register(new FakeProvider("presence", [{ method: "POST", path: "/v1/messages", headerDiscriminator: { name: "x-mode", mode: "presence" } }]))

    // Should not throw — different discriminator modes
    expect(registry.listRoutes()).toHaveLength(2)
  })

  // --- Empty registry ---

  test("empty registry returns undefined for any match", () => {
    const registry = new Provider_Registry()

    expect(registry.match("GET", "/anything", new Headers())).toBeUndefined()
    expect(registry.match("POST", "/v1/messages", new Headers())).toBeUndefined()
    expect(registry.listRoutes()).toEqual([])
  })

  // --- Provider with no routes ---

  test("provider with empty routes array registers without error", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("empty", []))

    expect(registry.listRoutes()).toEqual([])
    expect(registry.match("GET", "/", new Headers())).toBeUndefined()
  })

  // --- Multiple providers ---

  test("multiple providers with distinct routes all match correctly", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("claude", [
      { method: "POST", path: "/v1/messages" },
      { method: "GET", path: "/v1/models" },
    ]))
    registry.register(new FakeProvider("openai", [
      { method: "POST", path: "/v1/responses" },
      { method: "POST", path: "/v1/chat/completions" },
    ]))

    expect(registry.match("POST", "/v1/messages", new Headers())?.provider.name).toBe("claude")
    expect(registry.match("GET", "/v1/models", new Headers())?.provider.name).toBe("claude")
    expect(registry.match("POST", "/v1/responses", new Headers())?.provider.name).toBe("openai")
    expect(registry.match("POST", "/v1/chat/completions", new Headers())?.provider.name).toBe("openai")
  })

  // --- listRoutes preserves registration order ---

  test("listRoutes preserves registration order across providers", () => {
    const registry = new Provider_Registry()
    registry.register(new FakeProvider("b", [{ method: "POST", path: "/b" }]))
    registry.register(new FakeProvider("a", [{ method: "GET", path: "/a" }]))

    const routes = registry.listRoutes()
    expect(routes[0]).toEqual({ method: "POST", path: "/b", provider: "b" })
    expect(routes[1]).toEqual({ method: "GET", path: "/a", provider: "a" })
  })
})
