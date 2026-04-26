import { afterEach, describe, expect, test } from "bun:test"

import {
  connectKiroAccount,
  connectKiroAccountFromKiroAuth,
  readKiroAuthFileSelection,
  writeActiveKiroAccount,
} from "../src/upstream/kiro/account-store"
import { Kiro_Auth_Manager } from "../src/upstream/kiro"
import { mkdtemp, path, readFile, rm, tmpdir, writeFile } from "./helpers"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function token(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: new Date(Date.now() + 700_000).toISOString(),
    region: "us-east-1",
    ...overrides,
  }
}

async function tempFile(name: string, contents: unknown) {
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-account-store-test-"))
  tempDirs.push(dir)
  const file = path.join(dir, name)
  await writeFile(file, JSON.stringify(contents))
  return file
}

describe("Kiro account store", () => {
  test("imports Kiro IDE auth into managed state", async () => {
    const source = await tempFile("kiro-auth-token.json", token({ label: "work", profileArn: "arn:work" }))
    const state = path.join(path.dirname(source), "kiro-state.json")

    await expect(connectKiroAccountFromKiroAuth(state, source)).resolves.toMatchObject({
      accountKey: "arn:work",
    })

    expect(JSON.parse(await readFile(state, "utf8"))).toMatchObject({
      activeAccount: "arn:work",
      accounts: [{
        label: "work",
        profileArn: "arn:work",
        accessToken: "access",
        refreshToken: "refresh",
        sourceAuthFile: source,
        sourceAccountIndex: 0,
        sourceAccountKey: "arn:work",
      }],
    })
  })

  test("connects manual Kiro accounts and switches active account", async () => {
    const state = path.join(path.dirname(await tempFile("seed.json", {})), "kiro-state.json")

    await connectKiroAccount(state, {
      label: "first",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      region: "us-east-1",
      profileArn: "arn:first",
    })
    await connectKiroAccount(state, {
      label: "second",
      accessToken: "access-2",
      refreshToken: "refresh-2",
      region: "eu-west-1",
      profileArn: "arn:second",
    })

    const data = JSON.parse(await readFile(state, "utf8"))
    expect(data.activeAccount).toBe("arn:second")
    expect(data.accounts).toHaveLength(2)

    await writeActiveKiroAccount(state, data, "first")
    expect(JSON.parse(await readFile(state, "utf8")).activeAccount).toBe("arn:first")
  })

  test("auth manager selects and refreshes the active managed account", async () => {
    const source = await tempFile("kiro-auth-token.json", token({
      label: "source",
      accessToken: "old-source",
      refreshToken: "refresh-source",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      profileArn: "arn:source",
    }))
    const state = await tempFile("kiro-state.json", {
      activeAccount: "arn:source",
      accounts: [
        token({ label: "first", accessToken: "old-first", profileArn: "arn:first" }),
        token({
          label: "second",
          accessToken: "old-second",
          refreshToken: "refresh-source",
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          profileArn: "arn:source",
          sourceAuthFile: source,
          sourceAccountIndex: 0,
          sourceAccountKey: "arn:source",
        }),
      ],
    })
    const auth = await Kiro_Auth_Manager.fromAuthFile(state, {
      fetch: ((_, init) => {
        expect(String(init?.body)).toContain("refresh-source")
        return Promise.resolve(Response.json({ accessToken: "new-second", refreshToken: "new-refresh-second", expiresIn: 60, profileArn: "arn:second-new" }))
      }) as unknown as typeof fetch,
    })

    expect(await auth.getAccessToken()).toBe("new-second")

    const saved = JSON.parse(await readFile(state, "utf8"))
    expect(saved.activeAccount).toBe("arn:second-new")
    expect(saved.accounts[0].accessToken).toBe("old-first")
    expect(saved.accounts[1]).toMatchObject({
      accessToken: "new-second",
      refreshToken: "new-refresh-second",
      profileArn: "arn:second-new",
      sourceAuthFile: source,
      sourceAccountIndex: 0,
      sourceAccountKey: "arn:second-new",
    })
    const savedSource = JSON.parse(await readFile(source, "utf8"))
    expect(savedSource).toMatchObject({
      accessToken: "new-second",
      refreshToken: "new-refresh-second",
      profileArn: "arn:second-new",
    })
    expect(savedSource.label).toBe("source")
    expect(savedSource.sourceAuthFile).toBeUndefined()
    expect(savedSource.sourceAccountIndex).toBeUndefined()
    expect(savedSource.sourceAccountKey).toBeUndefined()
    await expect(readKiroAuthFileSelection(state, "arn:second-new")).resolves.toMatchObject({
      key: "arn:second-new",
      index: 1,
    })
  })

  test("syncs refreshed imported tokens without copying managed metadata to source", async () => {
    const source = await tempFile("kiro-auth-token.json", token({
      accessToken: "source-old",
      refreshToken: "source-refresh",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      profileArn: "arn:source",
    }))
    const state = await tempFile("kiro-state.json", {
      activeAccount: "arn:source",
      accounts: [
        token({
          label: "managed-only",
          accessToken: "managed-old",
          refreshToken: "source-refresh",
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          profileArn: "arn:source",
          sourceAuthFile: source,
          sourceAccountIndex: 0,
          sourceAccountKey: "arn:source",
        }),
      ],
    })
    const auth = await Kiro_Auth_Manager.fromAuthFile(state, {
      fetch: (() => Promise.resolve(Response.json({ accessToken: "source-new", refreshToken: "source-refresh-new", expiresIn: 60, profileArn: "arn:source" }))) as unknown as typeof fetch,
    })

    await auth.refresh()

    const savedSource = JSON.parse(await readFile(source, "utf8"))
    expect(savedSource).toMatchObject({
      accessToken: "source-new",
      refreshToken: "source-refresh-new",
      profileArn: "arn:source",
    })
    expect(savedSource.label).toBeUndefined()
    expect(savedSource.sourceAuthFile).toBeUndefined()
    expect(savedSource.sourceAccountIndex).toBeUndefined()
    expect(savedSource.sourceAccountKey).toBeUndefined()
  })

  test("syncs source tokens without changing an unrelated active source account", async () => {
    const source = await tempFile("kiro-auth-token.json", {
      activeAccount: "arn:other",
      accounts: [
        token({
          accessToken: "source-old",
          refreshToken: "source-refresh",
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          profileArn: "arn:source",
        }),
        token({
          accessToken: "other-access",
          refreshToken: "other-refresh",
          profileArn: "arn:other",
        }),
      ],
    })
    const state = await tempFile("kiro-state.json", {
      activeAccount: "arn:source",
      accounts: [
        token({
          accessToken: "managed-old",
          refreshToken: "source-refresh",
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          profileArn: "arn:source",
          sourceAuthFile: source,
          sourceAccountIndex: 0,
          sourceAccountKey: "arn:source",
        }),
      ],
    })
    const auth = await Kiro_Auth_Manager.fromAuthFile(state, {
      fetch: (() => Promise.resolve(Response.json({ accessToken: "source-new", refreshToken: "source-refresh-new", expiresIn: 60, profileArn: "arn:source-new" }))) as unknown as typeof fetch,
    })

    await auth.refresh()

    const savedSource = JSON.parse(await readFile(source, "utf8"))
    expect(savedSource.activeAccount).toBe("arn:other")
    expect(savedSource.accounts[0]).toMatchObject({
      accessToken: "source-new",
      refreshToken: "source-refresh-new",
      profileArn: "arn:source-new",
    })
    expect(savedSource.accounts[1]).toMatchObject({
      accessToken: "other-access",
      refreshToken: "other-refresh",
      profileArn: "arn:other",
    })

    const saved = JSON.parse(await readFile(state, "utf8"))
    expect(saved.activeAccount).toBe("arn:source-new")
    expect(saved.accounts[0]).toMatchObject({
      accessToken: "source-new",
      refreshToken: "source-refresh-new",
      sourceAccountIndex: 0,
      sourceAccountKey: "arn:source-new",
    })
  })

  test("pulls optional auth field removals from source before refreshing", async () => {
    const expiresAt = new Date(Date.now() + 700_000).toISOString()
    const source = await tempFile("kiro-auth-token.json", token({
      accessToken: "shared-access",
      refreshToken: "shared-refresh",
      expiresAt,
    }))
    const state = await tempFile("kiro-state.json", {
      activeAccount: "arn:source",
      accounts: [
        token({
          label: "managed-only",
          accessToken: "shared-access",
          refreshToken: "shared-refresh",
          expiresAt,
          profileArn: "arn:source",
          sourceAuthFile: source,
          sourceAccountIndex: 0,
          sourceAccountKey: "arn:source",
        }),
      ],
    })
    let refreshCalls = 0
    const auth = await Kiro_Auth_Manager.fromAuthFile(state, {
      fetch: (() => {
        refreshCalls += 1
        return Promise.resolve(new Response("source token is still fresh", { status: 401 }))
      }) as unknown as typeof fetch,
    })

    await auth.refresh()

    expect(refreshCalls).toBe(0)
    const saved = JSON.parse(await readFile(state, "utf8"))
    expect(saved.activeAccount).toBe("managed-only")
    expect(saved.accounts[0].profileArn).toBeUndefined()
    expect(saved.accounts[0]).toMatchObject({
      label: "managed-only",
      accessToken: "shared-access",
      refreshToken: "shared-refresh",
      sourceAccountIndex: 0,
      sourceAccountKey: "us-east-1:account-1",
    })
  })

  test("does not overwrite a selected Kiro account when its source file now points at another account", async () => {
    const source = await tempFile("kiro-auth-token.json", token({
      accessToken: "source-b",
      refreshToken: "source-refresh-b",
      expiresAt: new Date(Date.now() + 700_000).toISOString(),
      profileArn: "arn:b",
    }))
    const state = await tempFile("kiro-state.json", {
      activeAccount: "arn:a",
      accounts: [
        token({
          label: "first",
          accessToken: "managed-a-old",
          refreshToken: "managed-a-refresh",
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          profileArn: "arn:a",
          sourceAuthFile: source,
          sourceAccountIndex: 0,
          sourceAccountKey: "arn:a",
        }),
        token({
          label: "second",
          accessToken: "managed-b",
          refreshToken: "managed-b-refresh",
          profileArn: "arn:b",
          sourceAuthFile: source,
          sourceAccountIndex: 0,
          sourceAccountKey: "arn:b",
        }),
      ],
    })
    let refreshCalls = 0
    const auth = await Kiro_Auth_Manager.fromAuthFile(state, {
      fetch: ((_, init) => {
        refreshCalls += 1
        expect(String(init?.body)).toContain("managed-a-refresh")
        return Promise.resolve(Response.json({ accessToken: "managed-a-new", refreshToken: "managed-a-refresh-new", expiresIn: 60, profileArn: "arn:a" }))
      }) as unknown as typeof fetch,
    })

    await auth.refresh()

    expect(refreshCalls).toBe(1)
    expect(JSON.parse(await readFile(state, "utf8"))).toMatchObject({
      activeAccount: "arn:a",
      accounts: [
        {
          label: "first",
          accessToken: "managed-a-new",
          refreshToken: "managed-a-refresh-new",
          profileArn: "arn:a",
          sourceAuthFile: source,
          sourceAccountIndex: 0,
          sourceAccountKey: "arn:a",
        },
        {
          label: "second",
          accessToken: "managed-b",
          refreshToken: "managed-b-refresh",
          profileArn: "arn:b",
          sourceAuthFile: source,
          sourceAccountIndex: 0,
          sourceAccountKey: "arn:b",
        },
      ],
    })
    expect(JSON.parse(await readFile(source, "utf8"))).toMatchObject({
      accessToken: "source-b",
      refreshToken: "source-refresh-b",
      profileArn: "arn:b",
    })
  })

  test("auth manager pulls changed source auth before refreshing stale managed tokens", async () => {
    const source = await tempFile("kiro-auth-token.json", token({
      accessToken: "source-access",
      refreshToken: "source-refresh",
      expiresAt: new Date(Date.now() + 700_000).toISOString(),
      profileArn: "arn:source",
    }))
    const state = await tempFile("kiro-state.json", {
      activeAccount: "arn:source",
      accounts: [
        token({
          accessToken: "managed-access",
          refreshToken: "managed-refresh",
          expiresAt: new Date(Date.now() + 700_000).toISOString(),
          profileArn: "arn:source",
          sourceAuthFile: source,
          sourceAccountIndex: 0,
          sourceAccountKey: "arn:source",
        }),
      ],
    })
    let refreshCalls = 0
    const auth = await Kiro_Auth_Manager.fromAuthFile(state, {
      fetch: (() => {
        refreshCalls += 1
        return Promise.resolve(new Response("stale token should not refresh", { status: 401 }))
      }) as unknown as typeof fetch,
    })

    await auth.refresh()

    expect(refreshCalls).toBe(0)
    expect(await auth.getAccessToken()).toBe("source-access")
    expect(JSON.parse(await readFile(state, "utf8"))).toMatchObject({
      activeAccount: "arn:source",
      accounts: [{
        accessToken: "source-access",
        refreshToken: "source-refresh",
        profileArn: "arn:source",
        sourceAuthFile: source,
      }],
    })
  })
})
