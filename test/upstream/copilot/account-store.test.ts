import { afterEach, describe, expect, test } from "bun:test"

import { connectCopilotAccount, readCopilotAuthFileSelection } from "../../../src/upstream/copilot/account-store"
import { readCopilotCacheFile } from "../../../src/upstream/copilot/cache"
import { mkdtemp, path, readFile, rm, tmpdir } from "../../helpers"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function mockFetch() {
  return (async (url: string) => {
    if (String(url).includes("/copilot_internal/v2/token")) {
      return Response.json({ token: `copilot-token;exp=${Math.floor(Date.now() / 1000) + 3600}` })
    }
    if (String(url).includes("/copilot_internal/user")) {
      return Response.json({
        access_type_sku: "free_limited_copilot",
        copilot_plan: "copilot_pro",
        userInfo: { email: "dev@example.com", userId: "user-1" },
        limited_user_quotas: { chat: 100, completions: 100 },
        limited_user_reset_date: "2026-01-01",
      })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }) as unknown as typeof fetch
}

describe("copilot account store", () => {
  test("connects a Copilot account and persists auth plus filesystem cache", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "copilot-account-store-"))
    tempDirs.push(dir)
    process.env.HOME = dir
    const authFile = path.join(dir, ".codex2claudecode", "provider-state.json")
    const cacheFile = path.join(dir, ".codex2claudecode", "provider-cache.json")

    const result = await connectCopilotAccount(authFile, {
      label: "Primary",
      githubToken: "github-token",
      accountType: "individual",
    }, { fetch: mockFetch() })

    expect(result.accountKey).toBe("user-1")

    const selection = await readCopilotAuthFileSelection(authFile)
    expect(selection.credentials.githubToken).toBe("github-token")
    expect(selection.credentials.email).toBe("dev@example.com")
    expect(selection.credentials.plan).toBe("copilot_pro")
    expect(selection.credentials.authType).toBe("github_token")

    const saved = JSON.parse(await readFile(authFile, "utf8")) as { copilot?: { activeAccount?: string; data?: { activeAccount?: string; accounts?: Array<{ githubToken: string; email?: string; plan?: string }> } } }
    expect(saved.copilot?.activeAccount).toBe("user-1")
    expect(saved.copilot?.data?.accounts?.[0]?.githubToken).toBe("github-token")

    const cache = await readCopilotCacheFile(cacheFile)
    expect(cache.tokens["user-1"]).toMatchObject({
      accountType: "individual",
    })
    expect(cache.tokens["user-1"].copilotToken).toContain("copilot-token")
  })
})
