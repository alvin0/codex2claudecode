import { describe, expect, test } from "bun:test"

import { Rotating_Upstream_Provider } from "../../src/app/rotating-upstream"
import type { Upstream_Provider } from "../../src/core/interfaces"
import type { AccountCooldownMap } from "../../src/core/rotation"
import { loadRotationUsage, rotationView, rotationViewOrFallback, type RotationUsageMap } from "../../src/ui/rotation"

const now = Date.now()

async function rotating(cooldowns: AccountCooldownMap, enabled = true, usage: Record<string, unknown> = {}) {
  const create = async (account: string): Promise<Upstream_Provider> => ({
    providerKind: "codex",
    async proxy() { throw new Error("unused") },
    async checkHealth() { return { ok: true, checkedAt: "", latencyMs: 0 } },
    async usage() {
      const payload = usage[account]
      return payload === undefined ? new Response("no", { status: 404 }) : Response.json(payload)
    },
  } as unknown as Upstream_Provider)

  return Rotating_Upstream_Provider.create(
    {
      mode: "codex",
      roster: { accounts: ["a", "b"], activeAccount: "a", persistActive: async () => {} },
      create,
      enabled,
      cooldowns,
    },
    "b",
    await create("b"),
  )
}

describe("rotation view", () => {
  test("is absent when the upstream cannot rotate", () => {
    expect(rotationView(undefined)).toBeUndefined()
    expect(rotationView({ providerKind: "codex" })).toBeUndefined()
  })

  test("marks the active account and the ones merely available", async () => {
    const view = rotationView(await rotating({}), {}, now)

    expect(view?.enabled).toBe(true)
    expect(view?.activeAccount).toBe("b")
    expect(view?.accounts.map((account) => [account.key, account.status])).toEqual([["a", "ready"], ["b", "active"]])
    expect(view?.restingCount).toBe(0)
  })

  test("reports the toggle state", async () => {
    expect(rotationView(await rotating({}, false), {}, now)?.enabled).toBe(false)
  })

  test("explains why an account is resting", async () => {
    const view = rotationView(await rotating({
      a: { account: "a", reason: "quota", status: 429, since: now, until: now + 20 * 60_000, resetSource: "default" },
    }), {}, now)

    expect(view?.restingCount).toBe(1)
    expect(view?.accounts[0]).toMatchObject({ key: "a", status: "resting", detail: "quota (429) · retry in 20m" })
  })

  test("shows the provider's own reset time when it reported one", async () => {
    const until = now + 90 * 60_000
    const view = rotationView(await rotating({
      a: { account: "a", reason: "auth", status: 401, since: now, until, resetSource: "upstream" },
    }), {}, now)

    expect(view?.accounts[0]!.detail).toContain("auth failed (401)")
    expect(view?.accounts[0]!.detail).toContain(new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))
  })

  test("treats an expired cooldown as available again", async () => {
    const view = rotationView(await rotating({
      a: { account: "a", reason: "server", status: 503, since: now - 120_000, until: now - 60_000, resetSource: "default" },
    }), {}, now)

    expect(view?.accounts[0]!.status).toBe("ready")
    expect(view?.restingCount).toBe(0)
  })

  test("renders each account's quota from its own usage payload", async () => {
    const usage: RotationUsageMap = {
      a: { rate_limits: { primary: { used_percent: 55.4, reset_at: now / 1000 + 3600 } } },
      b: { rate_limits: { primary: { used_percent: 12 } } },
    }
    const view = rotationView(await rotating({}), usage, now)

    expect(view?.accounts[0]!.quota).toBe(`55% used · resets ${new Date(now + 3_600_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`)
    expect(view?.accounts[1]!.quota).toBe("12% used")
  })

  test("leaves quota blank for an account whose usage could not be read", async () => {
    const view = rotationView(await rotating({}), { a: { rate_limits: { primary: { used_percent: 3 } } } }, now)

    expect(view?.accounts[0]!.quota).toBe("3% used")
    expect(view?.accounts[1]!.quota).toBe("")
  })
})

describe("rotation view without a rotating upstream", () => {
  test("still reports the toggle so a single-account gateway shows its state", () => {
    const view = rotationViewOrFallback(undefined, { enabled: true, accounts: ["a"], activeAccount: "a" }, {}, now)

    expect(view?.enabled).toBe(true)
    expect(view?.rotatable).toBe(false)
    expect(view?.accounts).toEqual([{ key: "a", status: "active", detail: "", quota: "" }])
  })

  test("marks the pool rotatable once a second account exists", () => {
    const view = rotationViewOrFallback(undefined, { enabled: false, accounts: ["a", "b"], activeAccount: "b" }, {}, now)

    expect(view?.rotatable).toBe(true)
    expect(view?.accounts.map((account) => account.status)).toEqual(["ready", "active"])
  })

  test("is absent when no account is connected", () => {
    expect(rotationViewOrFallback(undefined, { enabled: true, accounts: [] }, {}, now)).toBeUndefined()
  })

  test("prefers the live rotating upstream over the fallback", async () => {
    const view = rotationViewOrFallback(await rotating({}, true), { enabled: false, accounts: ["z"] }, {}, now)

    expect(view?.enabled).toBe(true)
    expect(view?.accounts.map((account) => account.key)).toEqual(["a", "b"])
  })
})

describe("rotation usage loading", () => {
  test("collects usage for every account in the pool", async () => {
    const upstream = await rotating({}, true, {
      a: { rate_limits: { primary: { used_percent: 20 } } },
      b: { rate_limits: { primary: { used_percent: 40 } } },
    })

    expect(Object.keys(await loadRotationUsage(upstream)).sort()).toEqual(["a", "b"])
  })

  test("skips accounts whose usage endpoint fails", async () => {
    const upstream = await rotating({}, true, { a: { rate_limits: {} } })

    expect(Object.keys(await loadRotationUsage(upstream))).toEqual(["a"])
  })

  test("is empty when the upstream cannot rotate", async () => {
    expect(await loadRotationUsage(undefined)).toEqual({})
  })
})
