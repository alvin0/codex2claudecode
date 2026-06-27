import { afterEach, describe, expect, test } from "bun:test"

import { connectCopilotAccountFromDeviceCode } from "../../../src/upstream/copilot/device-code"
import { readCopilotAuthFileSelection } from "../../../src/upstream/copilot/account-store"
import { readCopilotCacheFile } from "../../../src/upstream/copilot/cache"
import { mkdtemp, path, readFile, rm, tmpdir } from "../../helpers"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function mockFetch() {
  let polls = 0
  return (async (url: string) => {
    if (String(url).endsWith("/login/device/code")) {
      return Response.json({
        device_code: "device-code-123",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1,
      })
    }

    if (String(url).endsWith("/login/oauth/access_token")) {
      polls += 1
      if (polls === 1) {
        return Response.json({ error: "authorization_pending", interval: 1 })
      }
      return Response.json({ access_token: "github-token", token_type: "bearer", scope: "read:user" })
    }

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

describe("copilot device-code login", () => {
  test("connects from device code and persists device_code auth type", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "copilot-device-code-"))
    tempDirs.push(dir)
    process.env.HOME = dir
    const authFile = path.join(dir, ".codex2claudecode", "provider-state.json")
    const reports: string[] = []
    const deviceCodes: Array<{ verification_uri: string; user_code: string }> = []

    const result = await connectCopilotAccountFromDeviceCode(authFile, {
      fetch: mockFetch(),
      report: (message) => reports.push(message),
      onDeviceCode: (deviceCode) => deviceCodes.push({
        verification_uri: deviceCode.verification_uri,
        user_code: deviceCode.user_code,
      }),
      sleep: async () => undefined,
    })

    expect(result.accountKey).toBe("user-1")
    expect(reports).toEqual([
      "Requesting GitHub device code...",
      "Open https://github.com/login/device and enter code ABCD-EFGH",
      "Waiting for GitHub approval...",
      "Device code approved. Loading Copilot account...",
    ])
    expect(deviceCodes).toEqual([
      {
        verification_uri: "https://github.com/login/device",
        user_code: "ABCD-EFGH",
      },
    ])

    const selection = await readCopilotAuthFileSelection(authFile)
    expect(selection.credentials.githubToken).toBe("github-token")
    expect(selection.credentials.authType).toBe("device_code")
    expect(selection.credentials.email).toBe("dev@example.com")
    expect(selection.credentials.plan).toBe("copilot_pro")

    const saved = JSON.parse(await readFile(authFile, "utf8")) as { copilot?: { activeAccount?: string; data?: { activeAccount?: string; accounts?: Array<{ githubToken: string; authType?: string }> } } }
    expect(saved.copilot?.activeAccount).toBe("user-1")
    expect(saved.copilot?.data?.accounts?.[0]?.authType).toBe("device_code")

    const cache = await readCopilotCacheFile(path.join(dir, ".codex2claudecode", "provider-cache.json"))
    expect(cache.tokens["user-1"]).toMatchObject({ accountType: "individual" })
    expect(cache.tokens["user-1"].copilotToken).toContain("copilot-token")
  })
})
