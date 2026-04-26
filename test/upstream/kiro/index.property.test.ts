import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_Request } from "../../../src/core/canonical"
import { Kiro_Auth_Manager, Kiro_Client, Kiro_Upstream_Provider, computeEffectiveTools } from "../../../src/upstream/kiro"

const tools = [{ type: "function", name: "a" }, { type: "function", name: "b" }]

function auth() {
  return new Kiro_Auth_Manager({
    accessToken: "a",
    refreshToken: "r",
    expiresAt: new Date(Date.now() + 700_000).toISOString(),
    region: "us-east-1",
  }, "/tmp/unused")
}

function request(overrides: Partial<Canonical_Request> = {}): Canonical_Request {
  return {
    model: "claude-sonnet-4-5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    tools,
    stream: false,
    passthrough: false,
    metadata: {},
    ...overrides,
  }
}

describe("Kiro provider properties", () => {
  test("Property 12: effectiveTools computation correctness", () => {
    fc.assert(fc.property(
      fc.constantFrom<any>(undefined, "auto", "required", "none", { type: "function", name: "a" }, { type: "function", function: { name: "b" } }),
      (choice) => {
        const result = computeEffectiveTools(tools, choice)
        expect("tools" in result).toBe(true)
        if (!("tools" in result)) return
        if (choice === "none") expect(result.tools).toEqual([])
        else if (typeof choice === "object" && typeof choice?.name === "string") expect(result.tools).toEqual([tools[0]])
        else if (typeof choice === "object" && typeof choice?.function?.name === "string") expect(result.tools).toEqual([tools[1]])
        else expect(result.tools).toEqual(tools)
      },
    ), { numRuns: 100 })
  })

  test("Property 13: unsupported server tool validation returns 400 before conversion", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("web_fetch", "mcp"), async (type) => {
      let calls = 0
      const manager = auth()
      const client = new Kiro_Client(manager, {
        fetch: (() => {
          calls += 1
          return Promise.resolve(new Response("{}"))
        }) as unknown as typeof fetch,
      })
      const provider = new Kiro_Upstream_Provider({ auth: manager, client })

      const result = await provider.proxy(request({ tools: [{ type }] }))
      expect(result).toMatchObject({ type: "canonical_error", status: 400 })
      expect(calls).toBe(0)
    }), { numRuns: 100 })
  })
})
