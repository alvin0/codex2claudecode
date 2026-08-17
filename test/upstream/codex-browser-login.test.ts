import { afterEach, describe, expect, test } from "bun:test"

import { codexAuthorizeUrl, codexLoginRedirectUri, runCodexBrowserLogin } from "../../src/upstream/codex/browser-login"
import { connectAccountFromBrowserLogin } from "../../src/upstream/codex/connect-account"
import { exists, jwt, mkdtemp, path, readFile, rm, tmpdir, writeFile } from "../helpers"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-browser-login-"))
  tempDirs.push(dir)
  return dir
}

/** Stands in for Bun.serve, capturing the handler so the test can drive the callback. */
function fakeServe(respond: (handle: (request: Request) => Response | Promise<Response>) => void) {
  let stopped = false
  return {
    serve: ((options: { fetch: (request: Request) => Response | Promise<Response> }) => {
      queueMicrotask(() => respond(options.fetch))
      return { stop: () => { stopped = true } }
    }) as unknown as typeof Bun.serve,
    get stopped() { return stopped },
  }
}

const tokenResponse = (accountId = "acct-1") => Response.json({
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_in: 3600,
  id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
})

describe("Codex authorize URL", () => {
  test("uses the callback Codex registered and asks for a refresh token", () => {
    const url = new URL(codexAuthorizeUrl({ challenge: "chal", state: "st" }))

    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
    expect(url.searchParams.get("scope")).toContain("offline_access")
    expect(url.searchParams.get("code_challenge")).toBe("chal")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("state")).toBe("st")
  })

  test("keeps the redirect on the registered port", () => {
    expect(codexLoginRedirectUri()).toBe("http://localhost:1455/auth/callback")
  })
})

describe("Codex browser login", () => {
  test("exchanges the callback code with the verifier that matches the challenge", async () => {
    let authorizeUrl = ""
    let tokenBody: URLSearchParams | undefined
    const server = fakeServe(async (handle) => {
      const state = new URL(authorizeUrl).searchParams.get("state")
      await handle(new Request(`http://localhost:1455/auth/callback?code=the-code&state=${state}`))
    })

    const tokens = await runCodexBrowserLogin({
      serve: server.serve,
      onAuthorizeUrl: (url) => { authorizeUrl = url },
      fetch: (async (_url: string, init: RequestInit) => {
        tokenBody = new URLSearchParams(String(init.body))
        return tokenResponse()
      }) as unknown as typeof fetch,
    })

    expect(tokens.access_token).toBe("access-1")
    expect(tokenBody?.get("grant_type")).toBe("authorization_code")
    expect(tokenBody?.get("code")).toBe("the-code")
    expect(tokenBody?.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")

    const verifier = tokenBody!.get("code_verifier")!
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    expect(Buffer.from(digest).toString("base64url")).toBe(new URL(authorizeUrl).searchParams.get("code_challenge")!)
    expect(server.stopped).toBe(true)
  })

  test("rejects a callback whose state does not match", async () => {
    const server = fakeServe(async (handle) => {
      await handle(new Request("http://localhost:1455/auth/callback?code=the-code&state=forged"))
    })

    await expect(runCodexBrowserLogin({
      serve: server.serve,
      fetch: (() => Promise.reject(new Error("token endpoint must not be called"))) as unknown as typeof fetch,
    })).rejects.toThrow("state mismatch")
  })

  test("surfaces an error returned on the callback", async () => {
    const server = fakeServe(async (handle) => {
      await handle(new Request("http://localhost:1455/auth/callback?error=access_denied&error_description=User%20said%20no"))
    })

    await expect(runCodexBrowserLogin({
      serve: server.serve,
      fetch: (() => Promise.reject(new Error("token endpoint must not be called"))) as unknown as typeof fetch,
    })).rejects.toThrow("User said no")
  })
})

describe("Codex browser login callback server", () => {
  test("serves the confirmation page instead of resetting the browser connection", async () => {
    let authorizeUrl = ""
    const port = 14_557

    const flow = runCodexBrowserLogin({
      port,
      onAuthorizeUrl: (url) => { authorizeUrl = url },
      fetch: (() => Promise.resolve(tokenResponse())) as unknown as typeof fetch,
    })

    while (!authorizeUrl) await new Promise((resolve) => setTimeout(resolve, 5))
    const state = new URL(authorizeUrl).searchParams.get("state")!

    const callback = await fetch(`http://localhost:${port}/auth/callback?code=live-code&state=${encodeURIComponent(state)}`)
    expect(callback.status).toBe(200)
    expect(await callback.text()).toContain("close this tab")

    expect((await flow).access_token).toBe("access-1")
  })
})

describe("Codex browser login account storage", () => {
  test("writes the account into the gateway auth file", async () => {
    const dir = await tempDir()
    const authFile = path.join(dir, "auth-codex.json")
    const server = fakeServe(async (handle) => {
      await handle(new Request(`http://localhost:1455/auth/callback?code=c&state=${captured}`))
    })
    let captured = ""

    const result = await connectAccountFromBrowserLogin(authFile, {
      serve: server.serve,
      onAuthorizeUrl: (url) => { captured = new URL(url).searchParams.get("state")! },
      fetch: (() => Promise.resolve(tokenResponse("acct-browser"))) as unknown as typeof fetch,
    })

    expect(result.accountId).toBe("acct-browser")
    const saved = JSON.parse(await readFile(authFile, "utf8")) as Array<{ accountId: string; access: string; refresh: string }>
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ accountId: "acct-browser", access: "access-1", refresh: "refresh-1" })
  })

  test("leaves the Codex CLI auth file untouched", async () => {
    const dir = await tempDir()
    const authFile = path.join(dir, "auth-codex.json")
    const codexCliAuth = path.join(dir, "codex-auth.json")
    const original = `${JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "acct-browser", access_token: "cli-access", refresh_token: "cli-refresh" } }, null, 2)}\n`
    await writeFile(codexCliAuth, original)

    let captured = ""
    const server = fakeServe(async (handle) => {
      await handle(new Request(`http://localhost:1455/auth/callback?code=c&state=${captured}`))
    })

    await connectAccountFromBrowserLogin(authFile, {
      serve: server.serve,
      codexAuthFile: codexCliAuth,
      onAuthorizeUrl: (url) => { captured = new URL(url).searchParams.get("state")! },
      fetch: (() => Promise.resolve(tokenResponse("acct-browser"))) as unknown as typeof fetch,
    })

    expect(await exists(codexCliAuth)).toBe(true)
    expect(await readFile(codexCliAuth, "utf8")).toBe(original)
  })
})
