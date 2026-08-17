import { afterEach, describe, expect, test } from "bun:test"

import { readAccountCooldowns } from "../../src/app/account-cooldowns"
import { Rotating_Upstream_Provider } from "../../src/app/rotating-upstream"
import type { AccountRoster } from "../../src/app/account-roster"
import type { Canonical_Request } from "../../src/core/canonical"
import type { UpstreamResult, Upstream_Provider } from "../../src/core/interfaces"
import { parseQuotaAvailable, parseQuotaResetAt, rotationReason } from "../../src/core/rotation"
import { mkdtemp, path, rm, tmpdir } from "../helpers"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function cachePath() {
  const dir = await mkdtemp(path.join(tmpdir(), "rotation-test-"))
  tempDirs.push(dir)
  return path.join(dir, "provider-cache.json")
}

function request(): Canonical_Request {
  return { model: "gpt-5.6-sol", input: [], stream: false, passthrough: false, metadata: {} }
}

function ok(model: string): UpstreamResult {
  return { type: "canonical_response", id: "resp", model, stopReason: "end_turn", content: [], usage: { inputTokens: 0, outputTokens: 0 } }
}

function failure(status: number, body = ""): UpstreamResult {
  return { type: "canonical_error", status, headers: new Headers(), body }
}

interface StubOptions {
  results: Record<string, UpstreamResult[]>
  usage?: Record<string, unknown>
}

function stubs(options: StubOptions) {
  const calls: string[] = []
  const create = async (account: string): Promise<Upstream_Provider> => ({
    providerKind: "codex",
    async proxy() {
      calls.push(account)
      const queue = options.results[account] ?? []
      return queue.length > 1 ? queue.shift()! : queue[0] ?? ok(account)
    },
    async checkHealth() {
      return { ok: true, checkedAt: new Date().toISOString(), latencyMs: 1 }
    },
    async usage() {
      return Response.json(options.usage?.[account] ?? {})
    },
  } as unknown as Upstream_Provider)

  return { calls, create }
}

function roster(accounts: string[], persisted: string[]): AccountRoster {
  return {
    accounts,
    activeAccount: accounts[0],
    persistActive: async (accountKey) => {
      persisted.push(accountKey)
    },
  }
}

describe("rotation policy", () => {
  test("classifies which failures belong to the account", () => {
    expect(rotationReason(401)).toBe("auth")
    expect(rotationReason(403)).toBe("auth")
    expect(rotationReason(403, "You have hit your usage limit")).toBe("quota")
    expect(rotationReason(429)).toBe("quota")
    expect(rotationReason(502)).toBe("server")
    expect(rotationReason(400)).toBeUndefined()
    expect(rotationReason(404)).toBeUndefined()
  })

  test("reads the reset time out of each provider's usage shape", () => {
    const now = 1_000_000_000_000

    // Codex: seconds-since-epoch under nested rate_limits
    expect(parseQuotaResetAt({ rate_limits: { primary: { reset_at: now / 1000 + 600 } } }, now)).toBe(now + 600_000)
    // Codex websocket frames also carry a relative reset
    expect(parseQuotaResetAt({ rate_limits: { primary: { reset_after_seconds: 300 } } }, now)).toBe(now + 300_000)
    // Copilot: ISO date string
    expect(parseQuotaResetAt({ quota_snapshots: { chat: { quota_reset_date_utc: new Date(now + 900_000).toISOString() } } }, now)).toBe(now + 900_000)
    // Past resets are ignored
    expect(parseQuotaResetAt({ reset_at: now / 1000 - 60 }, now)).toBeUndefined()
    expect(parseQuotaResetAt({}, now)).toBeUndefined()
  })

  test("reads whether quota came back", () => {
    expect(parseQuotaAvailable({ rate_limits: { allowed: true, limit_reached: false } })).toBe(true)
    expect(parseQuotaAvailable({ rate_limits: { allowed: true, limit_reached: true } })).toBe(false)
    expect(parseQuotaAvailable({ primary: { used_percent: 100 } })).toBe(false)
    expect(parseQuotaAvailable({ quota_snapshots: { chat: { remaining: 42 } } })).toBe(true)
    expect(parseQuotaAvailable({ nothing: "useful" })).toBeUndefined()
  })
})

describe("Rotating_Upstream_Provider", () => {
  test("moves to the next account on quota failure and persists it", async () => {
    const persisted: string[] = []
    const cache = await cachePath()
    const { calls, create } = stubs({
      results: { a: [failure(429, "usage limit reached")], b: [ok("b")] },
      usage: { a: { rate_limits: { primary: { reset_after_seconds: 600 } } } },
    })

    const rotating = await Rotating_Upstream_Provider.create(
      { mode: "codex", roster: roster(["a", "b"], persisted), create, cachePath: cache, enabled: true },
      "a",
      await create("a"),
    )

    expect((await rotating.proxy(request())).type).toBe("canonical_response")
    expect(calls).toEqual(["a", "b"])
    expect(persisted).toEqual(["b"])
    expect(rotating.activeAccount).toBe("b")

    const cooldown = (await readAccountCooldowns("codex", cache)).a!
    expect(cooldown.reason).toBe("quota")
    expect(cooldown.status).toBe(429)
    expect(cooldown.resetSource).toBe("upstream")
    expect(cooldown.until - cooldown.since).toBe(600_000)
  })

  test("falls back to the default cooldown when the provider gives no reset time", async () => {
    const cache = await cachePath()
    const { create } = stubs({ results: { a: [failure(401)], b: [ok("b")] } })

    const rotating = await Rotating_Upstream_Provider.create(
      { mode: "codex", roster: roster(["a", "b"], []), create, cachePath: cache, enabled: true },
      "a",
      await create("a"),
    )
    await rotating.proxy(request())

    const cooldown = (await readAccountCooldowns("codex", cache)).a!
    expect(cooldown.reason).toBe("auth")
    expect(cooldown.resetSource).toBe("default")
    expect(cooldown.until).toBeGreaterThan(cooldown.since)
  })

  test("skips a resting account on the next request instead of retrying it", async () => {
    const cache = await cachePath()
    const { calls, create } = stubs({ results: { a: [failure(429)], b: [ok("b")] } })

    const rotating = await Rotating_Upstream_Provider.create(
      { mode: "codex", roster: roster(["a", "b"], []), create, cachePath: cache, enabled: true },
      "a",
      await create("a"),
    )

    await rotating.proxy(request())
    await rotating.proxy(request())

    expect(calls).toEqual(["a", "b", "b"])
  })

  test("stays on the active account while rotation is switched off", async () => {
    const cache = await cachePath()
    const { calls, create } = stubs({ results: { a: [failure(429)], b: [ok("b")] } })

    const rotating = await Rotating_Upstream_Provider.create(
      { mode: "codex", roster: roster(["a", "b"], []), create, cachePath: cache, enabled: false },
      "a",
      await create("a"),
    )

    expect((await rotating.proxy(request()) as { status: number }).status).toBe(429)
    expect(calls).toEqual(["a"])
    expect(await readAccountCooldowns("codex", cache)).toEqual({})

    rotating.setEnabled(true)
    expect((await rotating.proxy(request())).type).toBe("canonical_response")
    expect(calls).toEqual(["a", "a", "b"])
  })

  test("does not rotate on request errors that are not the account's fault", async () => {
    const cache = await cachePath()
    const { calls, create } = stubs({ results: { a: [failure(400, "bad request")], b: [ok("b")] } })

    const rotating = await Rotating_Upstream_Provider.create(
      { mode: "codex", roster: roster(["a", "b"], []), create, cachePath: cache, enabled: true },
      "a",
      await create("a"),
    )

    expect((await rotating.proxy(request()) as { status: number }).status).toBe(400)
    expect(calls).toEqual(["a"])
    expect(await readAccountCooldowns("codex", cache)).toEqual({})
  })

  test("reports exhaustion once every account has failed the request", async () => {
    const cache = await cachePath()
    const { calls, create } = stubs({ results: { a: [failure(429)], b: [failure(429)] } })

    const rotating = await Rotating_Upstream_Provider.create(
      { mode: "codex", roster: roster(["a", "b"], []), create, cachePath: cache, enabled: true },
      "a",
      await create("a"),
    )

    const result = await rotating.proxy(request()) as { type: string; status: number }
    expect(result.type).toBe("canonical_error")
    expect(result.status).toBe(429)
    expect(calls).toEqual(["a", "b"])
  })

  test("re-probes a resting account and uses it when quota came back before its reset time", async () => {
    const cache = await cachePath()
    const { calls, create } = stubs({
      // `a` is exhausted, recovers early; `b` works once and is then exhausted too.
      results: { a: [failure(429), ok("a")], b: [ok("b"), failure(429)] },
      usage: { a: { rate_limits: { allowed: true, limit_reached: false, primary: { reset_after_seconds: 3600 } } } },
    })

    const rotating = await Rotating_Upstream_Provider.create(
      { mode: "codex", roster: roster(["a", "b"], []), create, cachePath: cache, enabled: true },
      "a",
      await create("a"),
    )

    await rotating.proxy(request())
    expect(rotating.activeAccount).toBe("b")
    expect((await readAccountCooldowns("codex", cache)).a!.until).toBeGreaterThan(Date.now() + 3_000_000)

    // Age the cooldown past the probe interval; its reported reset is still an hour out.
    rotating.accountCooldowns.a!.since = Date.now() - 10 * 60_000

    await rotating.proxy(request())
    expect(calls).toEqual(["a", "b", "b", "a"])
    expect(rotating.activeAccount).toBe("a")
    expect((await readAccountCooldowns("codex", cache)).a).toBeUndefined()
  })
})
