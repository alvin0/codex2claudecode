import { describe, expect, test } from "bun:test"

import { MODEL_CACHE_TTL_SECONDS } from "../../../src/upstream/kiro/constants"
import { HIDDEN_KIRO_MODELS } from "../../../src/upstream/kiro/constants"
import { Kiro_Auth_Manager, Kiro_Client, Kiro_Upstream_Provider, normalizeKiroModelName } from "../../../src/upstream/kiro"

function auth(overrides: Record<string, unknown> = {}) {
  return new Kiro_Auth_Manager({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: new Date(Date.now() + 700_000).toISOString(),
    region: "us-east-1",
    ...overrides,
  } as any, "/tmp/unused")
}

describe("Kiro model handling", () => {
  test("normalizes model name variants", () => {
    expect(normalizeKiroModelName("claude-sonnet-4-5")).toBe("claude-sonnet-4.5")
    expect(normalizeKiroModelName("claude-sonnet-4-20250514")).toBe("claude-sonnet-4")
    expect(normalizeKiroModelName("claude-sonnet-4-latest")).toBe("claude-sonnet-4")
    expect(normalizeKiroModelName("claude-opus-latest")).toBe("claude-opus-latest")
    expect(normalizeKiroModelName("claude-3-7-sonnet")).toBe("claude-3.7-sonnet")
  })

  test("lists API models, dedupes results, and re-fetches after TTL expiry", async () => {
    let calls = 0
    const manager = auth()
    const client = new Kiro_Client(manager, {
      fetch: (() => {
        calls += 1
        return Promise.resolve(Response.json({ models: ["claude-sonnet-4-5", "claude-sonnet-4.5", "custom-kiro-model"] }))
      }) as unknown as typeof fetch,
    })
    const upstream = new Kiro_Upstream_Provider({ auth: manager, client })

    const first = await upstream.listModels()
    expect(first).toEqual(["claude-sonnet-4.5", "custom-kiro-model"])
    expect(calls).toBe(1)

    ;(upstream as unknown as { modelCache: { models: string[]; cachedAt: number } }).modelCache.cachedAt = Date.now() - MODEL_CACHE_TTL_SECONDS * 1000 - 1

    const second = await upstream.listModels()
    expect(second).toEqual(first)
    expect(calls).toBe(2)
  })

  test("falls back to hidden models when API listing fails", async () => {
    const manager = auth()
    const client = new Kiro_Client(manager, {
      fetch: (() => Promise.reject(new Error("listing failed"))) as unknown as typeof fetch,
    })
    const upstream = new Kiro_Upstream_Provider({ auth: manager, client })

    expect(await upstream.listModels()).toEqual(HIDDEN_KIRO_MODELS)
  })

  test("omits profileArn for SSO OIDC model listing requests", async () => {
    let url = ""
    const manager = auth({ clientId: "client-id", clientSecret: "client-secret", profileArn: "arn:aws:sso:::profile/example" })
    const client = new Kiro_Client(manager, {
      fetch: ((input) => {
        url = String(input)
        return Promise.resolve(Response.json({ models: [] }))
      }) as unknown as typeof fetch,
    })
    const upstream = new Kiro_Upstream_Provider({ auth: manager, client })

    await upstream.listModels()
    expect(url).toContain("origin=AI_EDITOR")
    expect(url).not.toContain("profileArn=")
  })

  test("delegates checkHealth to the client", async () => {
    const expected = {
      ok: false,
      checkedAt: "2026-04-25T00:00:00.000Z",
      latencyMs: 12,
      status: 503,
      error: "unhealthy",
    }
    const upstream = new Kiro_Upstream_Provider({
      auth: auth(),
      client: {
        generateAssistantResponse: () => Promise.resolve(new Response("{}")),
        listAvailableModels: () => Promise.resolve([]),
        checkHealth: (timeoutMs: number) => {
          expect(timeoutMs).toBe(1234)
          return Promise.resolve(expected)
        },
      } as unknown as Kiro_Client,
    })

    expect(await upstream.checkHealth(1234)).toEqual(expected)
  })
})
