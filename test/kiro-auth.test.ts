import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { KiroAuthManager, resolveAuthType, resolveKiroRefreshUrl } from "../src/llm-connect/kiro/auth"
import { loadKiroCredentials } from "../src/llm-connect/kiro/credentials"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-auth-test-"))
  tempDirs.push(dir)
  return dir
}

async function writeJson(filePath: string, data: unknown) {
  await writeFile(filePath, JSON.stringify(data), "utf8")
}

describe("Kiro auth", () => {
  test("detects auth type from client credentials", () => {
    expect(resolveAuthType({})).toBe("kiro_desktop")
    expect(resolveAuthType({ clientId: "client", clientSecret: "secret" })).toBe("aws_sso_oidc")
  })

  test("resolves desktop and oidc refresh urls", () => {
    expect(resolveKiroRefreshUrl("us-east-1", "kiro_desktop")).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken")
    expect(resolveKiroRefreshUrl("eu-central-1", "aws_sso_oidc")).toBe("https://oidc.eu-central-1.amazonaws.com/token")
  })

  test("loads credentials from the configured json file only", async () => {
    const dir = await tempDir()
    const credsFile = path.join(dir, "auth-kiro.json")
    await writeJson(credsFile, {
      accessToken: "json-access",
      refreshToken: "json-refresh",
      region: "ap-southeast-1",
      clientId: "json-client",
      clientSecret: "json-secret",
      profileArn: "arn:aws:codewhisperer:ap-southeast-1:123:profile/id",
    })

    const { snapshot } = await loadKiroCredentials({ credsFile })
    expect(snapshot.accessToken).toBe("json-access")
    expect(snapshot.refreshToken).toBe("json-refresh")
    expect(snapshot.clientId).toBe("json-client")
    expect(snapshot.clientSecret).toBe("json-secret")
    expect(snapshot.detectedApiRegion).toBe("ap-southeast-1")
    expect(snapshot.profileArn).toBe("arn:aws:codewhisperer:ap-southeast-1:123:profile/id")
  })

  test("uses api region override over detected region and sso region", async () => {
    const auth = await KiroAuthManager.fromSources({
      accessToken: "access",
      refreshToken: "refresh",
      region: "us-east-1",
      apiRegionOverride: "eu-west-1",
    })
    expect(auth.apiHost).toBe("https://q.eu-west-1.amazonaws.com")
    expect(auth.qHost).toBe("https://q.eu-west-1.amazonaws.com")
    expect(auth.refreshUrl).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken")
  })

  test("refreshes desktop tokens with json refresh contract", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const auth = await KiroAuthManager.fromSources({
      refreshToken: "refresh-token",
      fetch: ((url, init) => {
        calls.push({ url: String(url), init })
        return Promise.resolve(Response.json({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600, profileArn: "arn:new" }))
      }) as typeof fetch,
    })
    await expect(auth.getAccessToken(true)).resolves.toBe("new-access")
    expect(calls[0].url).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken")
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ refreshToken: "refresh-token" })
    expect((calls[0].init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
    expect(auth.tokens).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", profileArn: "arn:new" })
  })

  test("refreshes aws sso oidc tokens with camelCase json body", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const auth = await KiroAuthManager.fromSources({
      refreshToken: "refresh-token",
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: ((url, init) => {
        calls.push({ url: String(url), init })
        return Promise.resolve(Response.json({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 }))
      }) as typeof fetch,
    })
    await expect(auth.getAccessToken(true)).resolves.toBe("new-access")
    expect(calls[0].url).toBe("https://oidc.us-east-1.amazonaws.com/token")
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      grantType: "refresh_token",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    })
  })
})
