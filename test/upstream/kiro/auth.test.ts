import { afterEach, describe, expect, test } from "bun:test"

import { Kiro_Auth_Manager } from "../../../src/upstream/kiro"
import { homedir, mkdir, mkdtemp, path, randomUUID, readFile, rm, stat, tmpdir, writeFile } from "../../helpers"

const tempDirs: string[] = []
const tempFiles: string[] = []

afterEach(async () => {
  await Promise.all(tempFiles.splice(0).map((file) => rm(file, { force: true })))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-auth-test-"))
  tempDirs.push(dir)
  return dir
}

async function tempAuthFile(contents: Record<string, unknown>, filePath?: string) {
  const dir = filePath ? path.dirname(filePath) : await tempDir()
  const file = filePath ?? path.join(dir, "kiro-auth-token.json")
  await mkdir(dir, { recursive: true })
  await writeFile(file, JSON.stringify(contents))
  return file
}

async function tempCompanionFile(clientIdHash: string, contents: string | Record<string, unknown>) {
  const file = path.join(homedir(), ".aws", "sso", "cache", `${clientIdHash}.json`)
  tempFiles.push(file)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents))
  return file
}

function token(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: new Date(Date.now() + 700_000).toISOString(),
    region: "us-east-1",
    ...overrides,
  }
}

describe("Kiro auth manager", () => {
  test("reads token fields and detects auth type", async () => {
    const file = await tempAuthFile(token({ clientId: "direct-client", clientSecret: "direct-secret", profileArn: "arn" }))
    const auth = await Kiro_Auth_Manager.fromAuthFile(file)

    expect(await auth.getAccessToken()).toBe("access")
    expect(auth.getRegion()).toBe("us-east-1")
    expect(auth.getProfileArn()).toBe("arn")
    expect(auth.getAuthType()).toBe("aws_sso_oidc")
  })

  test("throws with the auth file path when the token file is missing", async () => {
    const file = path.join(await tempDir(), "missing", "kiro-auth-token.json")
    await expect(Kiro_Auth_Manager.fromAuthFile(file)).rejects.toThrow(`Kiro auth token file not found at ${file}`)
  })

  test("throws with parse details when the token file contains invalid JSON", async () => {
    const file = path.join(await tempDir(), "kiro-auth-token.json")
    await writeFile(file, "{not-json")

    await expect(Kiro_Auth_Manager.fromAuthFile(file)).rejects.toThrow(`Failed to parse Kiro auth token file ${file}`)
  })

  test("rejects invalid region values before constructing Kiro URLs", async () => {
    const file = await tempAuthFile(token({ region: "attacker.example/#" }))

    await expect(Kiro_Auth_Manager.fromAuthFile(file)).rejects.toThrow(`Kiro auth token file ${file} contains invalid AWS region`)
  })

  test("uses companion credentials from the AWS SSO cache without persisting them into the token file", async () => {
    const clientIdHash = `kiro-auth-test-${randomUUID()}`
    await tempCompanionFile(clientIdHash, { clientId: "companion", clientSecret: "companion-secret" })
    const file = await tempAuthFile(token({ clientIdHash }))

    let body: Record<string, unknown> | undefined
    const auth = await Kiro_Auth_Manager.fromAuthFile(file, {
      fetch: ((_, init) => {
        body = JSON.parse(String(init?.body))
        return Promise.resolve(Response.json({ accessToken: "new", refreshToken: "new-refresh", expiresIn: 60 }))
      }) as unknown as typeof fetch,
    })

    await auth.refresh()

    expect(auth.getAuthType()).toBe("aws_sso_oidc")
    expect(body).toEqual({
      grantType: "refresh_token",
      clientId: "companion",
      clientSecret: "companion-secret",
      refreshToken: "refresh",
    })
    const saved = JSON.parse(await readFile(file, "utf8"))
    expect(saved.clientId).toBeUndefined()
    expect(saved.clientSecret).toBeUndefined()
  })

  test("falls back to Desktop Auth when the companion file is missing", async () => {
    const clientIdHash = `kiro-auth-test-${randomUUID()}`
    const companionFile = path.join(homedir(), ".aws", "sso", "cache", `${clientIdHash}.json`)
    await rm(companionFile, { force: true })
    const file = await tempAuthFile(token({ clientIdHash }))
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message?: unknown) => warnings.push(String(message))

    try {
      const auth = await Kiro_Auth_Manager.fromAuthFile(file)
      expect(auth.getAuthType()).toBe("kiro_desktop")
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(companionFile)
      expect(warnings[0]).toContain("SSO OIDC refresh will not be available")
    } finally {
      console.warn = originalWarn
    }
  })

  test("falls back to Desktop Auth when the companion file contains invalid JSON", async () => {
    const clientIdHash = `kiro-auth-test-${randomUUID()}`
    const companionFile = await tempCompanionFile(clientIdHash, "{not-json")
    const file = await tempAuthFile(token({ clientIdHash }))
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message?: unknown) => warnings.push(String(message))

    try {
      const auth = await Kiro_Auth_Manager.fromAuthFile(file)
      expect(auth.getAuthType()).toBe("kiro_desktop")
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(companionFile)
      expect(warnings[0]).toContain("Failed to parse")
    } finally {
      console.warn = originalWarn
    }
  })

  test("falls back to Desktop Auth when the companion file is missing credentials", async () => {
    const clientIdHash = `kiro-auth-test-${randomUUID()}`
    const companionFile = await tempCompanionFile(clientIdHash, { clientId: "only-id" })
    const file = await tempAuthFile(token({ clientIdHash }))
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message?: unknown) => warnings.push(String(message))

    try {
      const auth = await Kiro_Auth_Manager.fromAuthFile(file)
      expect(auth.getAuthType()).toBe("kiro_desktop")
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(companionFile)
      expect(warnings[0]).toContain("missing clientId/clientSecret")
    } finally {
      console.warn = originalWarn
    }
  })

  test("direct credentials take priority over companion credentials", async () => {
    const clientIdHash = `kiro-auth-test-${randomUUID()}`
    await tempCompanionFile(clientIdHash, { clientId: "companion", clientSecret: "companion-secret" })
    const file = await tempAuthFile(token({ clientIdHash, clientId: "direct", clientSecret: "direct-secret" }))

    let body: Record<string, unknown> | undefined
    const auth = await Kiro_Auth_Manager.fromAuthFile(file, {
      fetch: ((_, init) => {
        body = JSON.parse(String(init?.body))
        return Promise.resolve(Response.json({ accessToken: "new", refreshToken: "new-refresh", expiresIn: 60 }))
      }) as unknown as typeof fetch,
    })

    await auth.refresh()

    expect(auth.getAuthType()).toBe("aws_sso_oidc")
    expect(body?.clientId).toBe("direct")
    expect(body?.clientSecret).toBe("direct-secret")
  })

  test("does not mix partial direct OIDC credentials with companion credentials", async () => {
    const clientIdHash = `kiro-auth-test-${randomUUID()}`
    await tempCompanionFile(clientIdHash, { clientId: "companion", clientSecret: "companion-secret" })
    const file = await tempAuthFile(token({ clientIdHash, clientId: "direct-only" }))

    let body: Record<string, unknown> | undefined
    const auth = await Kiro_Auth_Manager.fromAuthFile(file, {
      fetch: ((_, init) => {
        body = JSON.parse(String(init?.body))
        return Promise.resolve(Response.json({ accessToken: "new", refreshToken: "new-refresh", expiresIn: 60 }))
      }) as unknown as typeof fetch,
    })

    await auth.refresh()

    expect(body?.clientId).toBe("companion")
    expect(body?.clientSecret).toBe("companion-secret")
  })

  test("refresh writes back token fields while preserving other fields and Desktop Auth user agent", async () => {
    const file = await tempAuthFile(token({ expiresAt: new Date(Date.now() - 1000).toISOString(), custom: "preserve" }))
    let headers: Headers | undefined
    const auth = await Kiro_Auth_Manager.fromAuthFile(file, {
      fetch: ((_, init) => {
        headers = new Headers(init?.headers)
        return Promise.resolve(Response.json({ accessToken: "new", refreshToken: "new-refresh", expiresIn: 60, profileArn: "arn:new" }))
      }) as unknown as typeof fetch,
      fingerprint: "fingerprint",
      kiroVersion: "1.2.3",
    })

    expect(await auth.getAccessToken()).toBe("new")

    const saved = JSON.parse(await readFile(file, "utf8"))
    expect(headers?.get("user-agent")).toBe("KiroIDE-1.2.3-fingerprint")
    expect(saved).toMatchObject({
      accessToken: "new",
      refreshToken: "new-refresh",
      custom: "preserve",
      profileArn: "arn:new",
    })
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  test("treats an unparseable expiresAt as expired and expiring soon", () => {
    const auth = new Kiro_Auth_Manager(token({ expiresAt: "not-a-date" }), "/tmp/unused")

    expect(auth.isTokenExpired()).toBe(true)
    expect(auth.isTokenExpiringSoon()).toBe(true)
  })

  test("reuses the pending refresh promise for concurrent refreshes", async () => {
    let releaseRefresh: (() => void) | undefined
    let fetchCalls = 0
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const auth = new Kiro_Auth_Manager(token({ expiresAt: new Date(Date.now() - 1000).toISOString() }), "/tmp/unused", {
      fetch: (async () => {
        fetchCalls += 1
        await gate
        return Response.json({ accessToken: "new", refreshToken: "new-refresh", expiresIn: 60 })
      }) as unknown as typeof fetch,
    })

    const first = auth.refresh()
    const second = auth.refresh()

    expect(fetchCalls).toBe(1)

    releaseRefresh?.()
    await Promise.all([first, second])
    expect(await auth.getAccessToken()).toBe("new")
  })

  test("uses camelCase JSON fields for SSO OIDC refresh", async () => {
    const file = await tempAuthFile(token({ expiresAt: new Date(Date.now() - 1000).toISOString(), clientId: "client", clientSecret: "secret" }))
    let body: Record<string, unknown> | undefined
    const auth = await Kiro_Auth_Manager.fromAuthFile(file, {
      fetch: ((_, init) => {
        body = JSON.parse(String(init?.body))
        return Promise.resolve(Response.json({ accessToken: "new", refreshToken: "new-refresh", expiresIn: 60 }))
      }) as unknown as typeof fetch,
    })

    await auth.refresh()

    expect(body).toEqual({
      grantType: "refresh_token",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
    })
  })

  test("includes status code and response body in refresh failures", async () => {
    const auth = new Kiro_Auth_Manager(token({ expiresAt: new Date(Date.now() - 1000).toISOString() }), "/tmp/unused", {
      fetch: (() => Promise.resolve(new Response("denied", { status: 500 }))) as unknown as typeof fetch,
    })

    await expect(auth.refresh()).rejects.toThrow("Kiro Desktop Auth refresh failed: 500 denied")
  })

  test("creates missing parent directories before writing refreshed credentials", async () => {
    const file = path.join(await tempDir(), "nested", "auth", "kiro-auth-token.json")
    const auth = new Kiro_Auth_Manager(token({ expiresAt: new Date(Date.now() - 1000).toISOString(), custom: "keep" }), file, {
      fetch: (() => Promise.resolve(Response.json({ accessToken: "new", refreshToken: "new-refresh", expiresIn: 60 }))) as unknown as typeof fetch,
    })

    await auth.refresh()

    const saved = JSON.parse(await readFile(file, "utf8"))
    expect(saved).toMatchObject({ accessToken: "new", refreshToken: "new-refresh", custom: "keep" })
  })

  test("property: expiration checks match 600 second threshold", async () => {
    const originalNow = Date.now
    try {
      for (let index = 0; index < 100; index += 1) {
        const now = 1_700_000_000_000 + index * 1000
        Date.now = () => now
        const expiresAt = new Date(now + (index - 50) * 30_000).toISOString()
        const auth = new Kiro_Auth_Manager(token({ expiresAt }), "/tmp/unused")
        expect(auth.isTokenExpired()).toBe(now >= Date.parse(expiresAt))
        expect(auth.isTokenExpiringSoon()).toBe(now >= Date.parse(expiresAt) - 600_000)
      }
    } finally {
      Date.now = originalNow
    }
  })
})
