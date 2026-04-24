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

const METHODS = ["GET", "POST"] as const

describe("Provider_Registry properties", () => {
  test("matches the correct provider for randomly generated non-conflicting routes", () => {
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const registry = new Provider_Registry()
      const cases = Array.from({ length: 5 }, (_, index) => {
        const method = METHODS[index % METHODS.length]
        const useParams = (iteration + index) % 2 === 0
        const path = useParams ? `/v${iteration}/resource-${index}/:item_id` : `/v${iteration}/resource-${index}/fixed`
        const route: Route_Descriptor = { method, path }
        const provider = new FakeProvider(`provider-${iteration}-${index}`, [route])
        registry.register(provider)
        const pathname = useParams ? `/v${iteration}/resource-${index}/value-${iteration}` : path
        return { route, provider, pathname }
      })

      for (const entry of cases) {
        const match = registry.match(entry.route.method, entry.pathname, new Headers())
        expect(match?.provider.name).toBe(entry.provider.name)
      }
    }
  })

  test("detects conflicting registrations and accepts non-conflicting pairs", () => {
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const method = METHODS[iteration % METHODS.length]
      const left = new FakeProvider(`left-${iteration}`, [{ method, path: `/conflict/${iteration}/:model_id` }])
      const conflictSameShape = new FakeProvider(`right-${iteration}`, [{ method, path: `/conflict/${iteration}/:other_id` }])
      const registry = new Provider_Registry()
      registry.register(left)
      expect(() => registry.register(conflictSameShape)).toThrow("Route conflict")

      const nonConflict = new FakeProvider(`ok-${iteration}`, [
        {
          method,
          path: `/conflict/${iteration}/fixed`,
          headerDiscriminator: { name: "x-mode", mode: iteration % 2 === 0 ? "presence" : "exact", value: iteration % 2 === 0 ? undefined : "alpha" },
        },
      ])
      const cleanRegistry = new Provider_Registry()
      cleanRegistry.register(left)
      expect(() => cleanRegistry.register(nonConflict)).not.toThrow()
    }
  })

  test("applies specificity ordering and registration-order tie-breaking", () => {
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const registry = new Provider_Registry()
      registry.register(new FakeProvider(`none-${iteration}`, [{ method: "POST", path: `/messages/${iteration}` }]))
      registry.register(
        new FakeProvider(`presence-${iteration}`, [
          { method: "POST", path: `/messages/${iteration}`, headerDiscriminator: { name: "x-mode", mode: "presence" } },
        ]),
      )
      registry.register(
        new FakeProvider(`exact-${iteration}`, [
          { method: "POST", path: `/messages/${iteration}`, headerDiscriminator: { name: "x-mode", mode: "exact", value: "claude" } },
        ]),
      )

      expect(registry.match("POST", `/messages/${iteration}`, new Headers({ "x-mode": "claude" }))?.provider.name).toBe(`exact-${iteration}`)
      expect(registry.match("POST", `/messages/${iteration}`, new Headers({ "x-mode": "other" }))?.provider.name).toBe(`presence-${iteration}`)
      expect(registry.match("POST", `/messages/${iteration}`, new Headers())?.provider.name).toBe(`none-${iteration}`)

      const tie = new Provider_Registry()
      tie.register(new FakeProvider(`first-${iteration}`, [{ method: "GET", path: `/models/:model_id` }]))
      tie.register(new FakeProvider(`second-${iteration}`, [{ method: "GET", path: "/models/latest" }]))
      expect(tie.match("GET", "/models/latest", new Headers())?.provider.name).toBe(`first-${iteration}`)
    }
  })
})
