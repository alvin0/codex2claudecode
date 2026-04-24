import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { CodexStandaloneClient } from "../src/upstream/codex/client"
import { jwt, sse } from "./helpers"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function authFile(contents = { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000, accountId: "acct" }) {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-client-test-"))
  tempDirs.push(dir)
  const file = path.join(dir, "auth-codex.json")
  await writeFile(file, JSON.stringify(contents))
  return file
}

async function codexCliAuthFile(contents: unknown) {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-cli-auth-test-"))
  tempDirs.push(dir)
  const file = path.join(dir, "auth.json")
  await writeFile(file, JSON.stringify(contents))
  return file
}

describe("CodexStandaloneClient", () => {
  test("loads auth files and exposes tokens", async () => {
    const client = await CodexStandaloneClient.fromAuthFile(await authFile())
    expect(client.tokens).toMatchObject({ accessToken: "access", refreshToken: "refresh", accountId: "acct" })
  })

  test("loads selected accounts from auth arrays", async () => {
    const file = await authFile([
      { type: "oauth", name: "first", access: "a", refresh: "r", accountId: "one" },
      { type: "oauth", email: "second@example.com", access: "b", refresh: "s", accountId: "two" },
    ])
    expect((await CodexStandaloneClient.fromAuthFile(file)).tokens).toMatchObject({ accessToken: "a", accountId: "one" })
    expect((await CodexStandaloneClient.fromAuthFile(file, { authAccount: "second@example.com" })).tokens).toMatchObject({ accessToken: "b", accountId: "two" })
  })

  test("normalizes reasoning on proxied requests and sets sanitized headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new CodexStandaloneClient({
      accessToken: "a",
      refreshToken: "r",
      accountId: "acct",
      fetch: ((url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Promise.resolve(Response.json({ ok: true }))
      }) as typeof fetch,
    })

    await expect(client.proxy({ model: "gpt-5.4_xhigh", input: "hi" }, { headers: { host: "bad", "x-test": "yes" } })).resolves.toBeInstanceOf(Response)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: "gpt-5.4", input: "hi", reasoning: { effort: "xhigh" } })
    const headers = calls[0].init.headers as Headers
    expect(headers.get("authorization")).toBe("Bearer a")
    expect(headers.get("ChatGPT-Account-Id")).toBe("acct")
    expect(headers.get("x-test")).toBe("yes")
    expect(headers.has("host")).toBe(false)
  })

  test("refreshes expired tokens once and retries after a 401", async () => {
    const calls: string[] = []
    const file = await authFile({ type: "oauth", access: "old", refresh: "refresh", expires: Date.now() - 1, accountId: "old_acct" })
    const client = await CodexStandaloneClient.fromAuthFile(file, {
      issuer: "https://issuer.test",
      fetch: ((url, init) => {
        calls.push(String(url))
        if (String(url).endsWith("/oauth/token")) {
          expect(String(init?.body)).toContain("refresh_token=refresh")
          return Promise.resolve(
            Response.json({
              access_token: `access-${calls.length}`,
              refresh_token: `refresh-${calls.length}`,
              expires_in: 60,
              id_token: jwt({ chatgpt_account_id: `acct-${calls.length}` }),
            }),
          )
        }
        if (calls.filter((item) => item.includes("/codex/responses")).length === 1) return Promise.resolve(new Response("no", { status: 401 }))
        return Promise.resolve(Response.json({ ok: true }))
      }) as typeof fetch,
    })

    const response = await client.proxy({ model: "gpt-5.4", input: "hi" })
    expect(response.ok).toBe(true)
    expect(calls.filter((url) => url.endsWith("/oauth/token"))).toHaveLength(2)
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ access: "access-3", refresh: "refresh-3", accountId: "acct-3" })
  })

  test("refresh updates only the selected auth array entry", async () => {
    const file = await authFile([
      { type: "oauth", name: "first", access: "a", refresh: "r", accountId: "one" },
      { type: "oauth", name: "second", access: "old", refresh: "refresh", expires: Date.now() - 1, accountId: "two" },
    ])
    const client = await CodexStandaloneClient.fromAuthFile(file, {
      authAccount: "second",
      issuer: "https://issuer.test",
      fetch: ((url) => {
        if (String(url).endsWith("/oauth/token")) return Promise.resolve(Response.json({ access_token: "new", refresh_token: "new-refresh", expires_in: 60 }))
        return Promise.resolve(Response.json({ ok: true }))
      }) as typeof fetch,
    })

    await client.refresh()
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject([
      { name: "first", access: "a", refresh: "r", accountId: "one" },
      { name: "second", access: "new", refresh: "new-refresh", accountId: "two" },
    ])
  })

  test("surfaces token refresh failures", async () => {
    const client = new CodexStandaloneClient({
      accessToken: "old",
      refreshToken: "refresh",
      expiresAt: Date.now() - 1,
      issuer: "https://issuer.test",
      fetch: ((url) => {
        if (String(url).endsWith("/oauth/token")) return Promise.resolve(new Response("denied", { status: 400 }))
        return Promise.resolve(Response.json({ ok: true }))
      }) as typeof fetch,
    })

    await expect(client.proxy({ model: "m" })).rejects.toThrow("Token refresh failed: 400 denied")
  })

  test("refresh works without an auth file", async () => {
    const client = new CodexStandaloneClient({
      accessToken: "old",
      refreshToken: "refresh",
      issuer: "https://issuer.test",
      fetch: ((url) => {
        expect(String(url)).toBe("https://issuer.test/oauth/token")
        return Promise.resolve(Response.json({ access_token: "new", refresh_token: "new-refresh", expires_in: 1 }))
      }) as typeof fetch,
    })

    await expect(client.refresh()).resolves.toMatchObject({ accessToken: "new", refreshToken: "new-refresh" })
  })

  test("refresh keeps the previous refresh token when upstream omits rotation", async () => {
    const client = new CodexStandaloneClient({
      accessToken: "old",
      refreshToken: "refresh",
      issuer: "https://issuer.test",
      fetch: ((url) => {
        expect(String(url)).toBe("https://issuer.test/oauth/token")
        return Promise.resolve(Response.json({ access_token: "new", expires_in: 1 }))
      }) as typeof fetch,
    })

    await expect(client.refresh()).resolves.toMatchObject({ accessToken: "new", refreshToken: "refresh" })
  })

  test("refresh syncs a matching Codex CLI auth file", async () => {
    const file = await authFile({ type: "oauth", access: "old", refresh: "refresh", expires: Date.now() - 1, accountId: "acct" })
    const codexFile = await codexCliAuthFile({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "acct",
        access_token: "cli-old",
        refresh_token: "cli-refresh",
      },
    })
    const client = await CodexStandaloneClient.fromAuthFile(file, {
      issuer: "https://issuer.test",
      codexAuthFile: codexFile,
      fetch: ((url) => {
        if (String(url).endsWith("/oauth/token")) return Promise.resolve(Response.json({ access_token: "new", refresh_token: "new-refresh", expires_in: 60 }))
        return Promise.resolve(Response.json({ ok: true }))
      }) as typeof fetch,
    })

    await client.refresh()
    expect(JSON.parse(await readFile(codexFile, "utf8"))).toMatchObject({
      tokens: { account_id: "acct", access_token: "new", refresh_token: "new-refresh" },
    })
  })

  test("refresh leaves a mismatched Codex CLI auth file unchanged", async () => {
    const file = await authFile({ type: "oauth", access: "old", refresh: "refresh", expires: Date.now() - 1, accountId: "acct" })
    const codexFile = await codexCliAuthFile({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "other",
        access_token: "cli-old",
        refresh_token: "cli-refresh",
      },
    })
    const client = await CodexStandaloneClient.fromAuthFile(file, {
      issuer: "https://issuer.test",
      codexAuthFile: codexFile,
      fetch: ((url) => {
        if (String(url).endsWith("/oauth/token")) return Promise.resolve(Response.json({ access_token: "new", refresh_token: "new-refresh", expires_in: 60 }))
        return Promise.resolve(Response.json({ ok: true }))
      }) as typeof fetch,
    })

    await client.refresh()
    expect(JSON.parse(await readFile(codexFile, "utf8"))).toMatchObject({
      tokens: { account_id: "other", access_token: "cli-old", refresh_token: "cli-refresh" },
    })
  })

  test("refresh syncs fallback refresh token into a matching Codex CLI auth file", async () => {
    const file = await authFile({ type: "oauth", access: "old", refresh: "refresh", expires: Date.now() - 1, accountId: "acct" })
    const codexFile = await codexCliAuthFile({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "acct",
        access_token: "cli-old",
        refresh_token: "cli-refresh",
      },
    })
    const client = await CodexStandaloneClient.fromAuthFile(file, {
      issuer: "https://issuer.test",
      codexAuthFile: codexFile,
      fetch: ((url) => {
        if (String(url).endsWith("/oauth/token")) return Promise.resolve(Response.json({ access_token: "new", expires_in: 60 }))
        return Promise.resolve(Response.json({ ok: true }))
      }) as typeof fetch,
    })

    await client.refresh()
    expect(JSON.parse(await readFile(codexFile, "utf8"))).toMatchObject({
      tokens: { account_id: "acct", access_token: "new", refresh_token: "refresh" },
    })
  })

  test("throws helpful errors for failed JSON/stream requests and missing stream bodies", async () => {
    const failing = new CodexStandaloneClient({
      accessToken: "a",
      refreshToken: "r",
      fetch: (() => Promise.resolve(new Response("bad", { status: 400 }))) as typeof fetch,
    })
    await expect(failing.responses({ model: "gpt-5.4", input: "hi" })).rejects.toThrow("Codex request failed: 400 bad")

    const noBody = new CodexStandaloneClient({
      accessToken: "a",
      refreshToken: "r",
      fetch: (() => Promise.resolve(new Response(null))) as typeof fetch,
    })
    await expect(noBody.responsesStream({ model: "gpt-5.4", input: "hi" })).rejects.toThrow("Response did not include a stream body")
  })

  test("supports responses, chat completions, and stream aliases", async () => {
    const bodies: unknown[] = []
    const client = new CodexStandaloneClient({
      accessToken: "a",
      refreshToken: "r",
      fetch: ((url, init) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")))
        return Promise.resolve(Response.json({ ok: true }))
      }) as typeof fetch,
    })

    await expect(client.responses({ model: "gpt-5.4", input: "hi" })).resolves.toEqual({ ok: true })
    await expect(client.chatCompletions({ model: "gpt-5.4", messages: [] })).resolves.toEqual({ ok: true })
    await expect(client.chatCompletionsStream({ model: "gpt-5.4", messages: [] })).resolves.toBeInstanceOf(ReadableStream)
    expect(bodies[2]).toMatchObject({ stream: true })
  })

  test("uses OpenAI API key for input token counts when configured", async () => {
    let captured: { url?: string; authorization?: string; originator?: string | null; accountId?: string | null; body?: unknown } = {}
    const client = new CodexStandaloneClient({
      accessToken: "codex-token",
      refreshToken: "r",
      accountId: "acct",
      openAiApiKey: "platform-key",
      fetch: ((url, init) => {
        const headers = new Headers(init?.headers)
        captured = {
          url: String(url),
          authorization: headers.get("authorization") ?? undefined,
          originator: headers.get("originator"),
          accountId: headers.get("ChatGPT-Account-Id"),
          body: JSON.parse(String(init?.body ?? "{}")),
        }
        return Promise.resolve(Response.json({ object: "response.input_tokens", input_tokens: 7 }))
      }) as typeof fetch,
    })

    const response = await client.inputTokens({ model: "gpt-5.4", input: "hi" })

    expect(await response.json()).toEqual({ object: "response.input_tokens", input_tokens: 7 })
    expect(captured.url).toBe("https://api.openai.com/v1/responses/input_tokens")
    expect(captured.authorization).toBe("Bearer platform-key")
    expect(captured.originator).toBeNull()
    expect(captured.accountId).toBeNull()
    expect(captured.body).toMatchObject({ model: "gpt-5.4", input: "hi" })
  })

  test("supports usage, environments, health success, auth rejection, and health failures", async () => {
    const client = new CodexStandaloneClient({
      accessToken: "a",
      refreshToken: "r",
      fetch: ((url, init) => {
        if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 405 }))
        if (String(url).includes("/usage")) return Promise.resolve(Response.json({ usage: true }))
        if (String(url).includes("/environments")) return Promise.resolve(Response.json([]))
        return Promise.resolve(new Response(sse([])))
      }) as typeof fetch,
    })
    expect((await client.checkHealth()).ok).toBe(true)
    expect(await (await client.usage()).json()).toEqual({ usage: true })
    expect(await (await client.environments()).json()).toEqual([])

    const rejected = new CodexStandaloneClient({
      accessToken: "a",
      refreshToken: "r",
      fetch: (() => Promise.resolve(new Response(null, { status: 401 }))) as typeof fetch,
    })
    expect(await rejected.checkHealth()).toMatchObject({ ok: false, status: 401, error: "Codex auth rejected health check with 401" })

    const broken = new CodexStandaloneClient({
      accessToken: "a",
      refreshToken: "r",
      fetch: (() => Promise.reject(new Error("network down"))) as typeof fetch,
    })
    expect(await broken.checkHealth()).toMatchObject({ ok: false, error: "network down" })
  })
})
