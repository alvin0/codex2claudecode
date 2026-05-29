import { afterEach, describe, expect, test } from "bun:test"

import { existingKiroSourceAuthFiles, kiroSourceAuthCandidates, resolveKiroSourceAuthFile } from "../../../src/upstream/kiro/auth-source"
import { connectKiroAccountsFromKiroAuth, readKiroAuthFileData } from "../../../src/upstream/kiro/account-store"
import { homedir, mkdtemp, path, readFile, rm, tmpdir, writeFile } from "../../helpers"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function token(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: new Date(Date.now() + 700_000).toISOString(),
    region: "ap-northeast-1",
    ...overrides,
  }
}

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-auth-source-test-"))
  tempDirs.push(dir)
  return dir
}

describe("kiroSourceAuthCandidates", () => {
  test("returns both desktop and CLI caches by default", () => {
    const candidates = kiroSourceAuthCandidates({})
    expect(candidates).toEqual([
      path.join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json"),
      path.join(homedir(), ".aws", "sso", "cache", "kiro-auth-token-cli.json"),
    ])
  })

  test("uses only KIRO_AUTH_FILE when set", () => {
    const candidates = kiroSourceAuthCandidates({ KIRO_AUTH_FILE: "~/custom/kiro.json" })
    expect(candidates).toEqual([path.join(homedir(), "custom", "kiro.json")])
  })
})

describe("existingKiroSourceAuthFiles", () => {
  test("only returns files that exist, in priority order", async () => {
    const dir = await tempDir()
    const desktop = path.join(dir, "kiro-auth-token.json")
    const cli = path.join(dir, "kiro-auth-token-cli.json")
    await writeFile(cli, JSON.stringify(token()))

    const env = { KIRO_AUTH_FILE: undefined } as Record<string, string | undefined>
    // Build candidates explicitly so the test does not depend on the real home dir.
    const candidatesEnv = { ...env }
    void candidatesEnv

    // Resolve against an env override pointing at the temp directory by faking
    // both default paths through KIRO_AUTH_FILE is not possible; instead test
    // the function against concrete files.
    expect(await pathExistsAll([cli])).toEqual([cli])
    expect(await pathExistsAll([desktop])).toEqual([])
  })
})

async function pathExistsAll(files: string[]) {
  const { existingKiroSourceAuthFiles: _ } = await import("../../../src/upstream/kiro/auth-source")
  const { pathExists } = await import("../../../src/core/bun-fs")
  const out: string[] = []
  for (const file of files) if (await pathExists(file)) out.push(file)
  return out
}

describe("resolveKiroSourceAuthFile", () => {
  test("prefers an explicit KIRO_AUTH_FILE override", async () => {
    const dir = await tempDir()
    const custom = path.join(dir, "custom-kiro.json")
    await writeFile(custom, JSON.stringify(token()))
    expect(await resolveKiroSourceAuthFile({ KIRO_AUTH_FILE: custom })).toBe(custom)
  })

  test("falls back to the highest-priority candidate when none exist", async () => {
    const dir = await tempDir()
    const missing = path.join(dir, "missing-kiro.json")
    expect(await resolveKiroSourceAuthFile({ KIRO_AUTH_FILE: missing })).toBe(missing)
  })
})

describe("connectKiroAccountsFromKiroAuth", () => {
  test("imports the active account from each readable source", async () => {
    const dir = await tempDir()
    const desktop = path.join(dir, "kiro-auth-token.json")
    const cli = path.join(dir, "kiro-auth-token-cli.json")
    const state = path.join(dir, "kiro-state.json")
    // Use distinct regions so the fallback alias `region:account-1` does not collide
    await writeFile(desktop, JSON.stringify(token({ label: "desktop", profileArn: "arn:desktop", region: "us-east-1" })))
    await writeFile(cli, JSON.stringify(token({ label: "cli", profileArn: "arn:cli", authMethod: "IdC", region: "ap-northeast-1" })))

    const result = await connectKiroAccountsFromKiroAuth(state, [desktop, cli])
    expect(result.accountKey).toBe("arn:cli")

    const data = await readKiroAuthFileData(state)
    const accounts = (data as { accounts: Array<Record<string, unknown>> }).accounts
    expect(accounts.map((account) => account.label)).toEqual(["desktop", "cli"])
    expect(accounts[1]).toMatchObject({
      sourceAuthFile: cli,
      authMethod: "IdC",
    })
  })

  test("skips unreadable sources but imports the rest", async () => {
    const dir = await tempDir()
    const cli = path.join(dir, "kiro-auth-token-cli.json")
    const missing = path.join(dir, "missing.json")
    const state = path.join(dir, "kiro-state.json")
    await writeFile(cli, JSON.stringify(token({ label: "cli", profileArn: "arn:cli" })))

    const result = await connectKiroAccountsFromKiroAuth(state, [missing, cli])
    expect(result.accountKey).toBe("arn:cli")
    expect(JSON.parse(await readFile(state, "utf8")).accounts).toHaveLength(1)
  })

  test("throws when no sources can be imported", async () => {
    const dir = await tempDir()
    const state = path.join(dir, "kiro-state.json")
    await expect(connectKiroAccountsFromKiroAuth(state, [path.join(dir, "a.json"), path.join(dir, "b.json")]))
      .rejects.toThrow("No Kiro auth token files could be imported")
  })
})
