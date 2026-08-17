import { DEFAULT_CLIENT_ID, DEFAULT_ISSUER } from "./constants"

/** Codex registers this exact callback with the OAuth client, so the port is not configurable. */
export const CODEX_LOGIN_PORT = 1455
export const CODEX_LOGIN_REDIRECT_PATH = "/auth/callback"
export const CODEX_LOGIN_SCOPE = "openid profile email offline_access"
export const CODEX_LOGIN_TIMEOUT_MS = 5 * 60_000

export interface CodexBrowserLoginTokens {
  access_token: string
  refresh_token: string
  id_token?: string
  expires_in?: number
}

export interface CodexBrowserLoginOptions {
  issuer?: string
  clientId?: string
  port?: number
  fetch?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
  /** Called with the URL the user has to open; the caller decides how to surface it. */
  onAuthorizeUrl?: (url: string) => void
  openBrowser?: (url: string) => void | Promise<void>
  serve?: typeof Bun.serve
}

export function codexLoginRedirectUri(port = CODEX_LOGIN_PORT) {
  return `http://localhost:${port}${CODEX_LOGIN_REDIRECT_PATH}`
}

export function codexAuthorizeUrl(options: { issuer?: string; clientId?: string; port?: number; challenge: string; state: string }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId ?? DEFAULT_CLIENT_ID,
    redirect_uri: codexLoginRedirectUri(options.port),
    scope: CODEX_LOGIN_SCOPE,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    state: options.state,
  })
  return `${options.issuer ?? DEFAULT_ISSUER}/oauth/authorize?${params.toString()}`
}

/**
 * Signs in through the browser with PKCE and returns the tokens.
 *
 * This is the OAuth flow `codex login` uses, run by this gateway instead, so the
 * credentials land in the gateway's own auth file and `~/.codex/auth.json` is left
 * untouched.
 */
export async function runCodexBrowserLogin(options: CodexBrowserLoginOptions = {}): Promise<CodexBrowserLoginTokens> {
  const port = options.port ?? CODEX_LOGIN_PORT
  const verifier = randomUrlSafe(32)
  const challenge = await pkceChallenge(verifier)
  const state = randomUrlSafe(16)
  const authorizeUrl = codexAuthorizeUrl({ ...options, challenge, state })

  const code = await waitForAuthorizationCode({ ...options, port, state, authorizeUrl })
  return exchangeAuthorizationCode(code, verifier, { ...options, port })
}

async function waitForAuthorizationCode(options: CodexBrowserLoginOptions & { port: number; state: string; authorizeUrl: string }) {
  const serve = options.serve ?? Bun.serve
  let settle: (result: { code?: string; error?: Error }) => void
  const result = new Promise<{ code?: string; error?: Error }>((resolve) => { settle = resolve })

  let server: { stop: (closeActiveConnections?: boolean) => unknown }
  try {
    server = serve({
      port: options.port,
      hostname: "127.0.0.1",
      fetch(request: Request) {
        const url = new URL(request.url)
        if (url.pathname !== CODEX_LOGIN_REDIRECT_PATH) return new Response("Not found", { status: 404 })

        const fail = (message: string) => {
          queueMicrotask(() => settle({ error: new Error(message) }))
          return htmlResponse("Sign-in failed. You can close this tab and try again.")
        }

        const error = url.searchParams.get("error")
        if (error) return fail(`Sign-in failed: ${url.searchParams.get("error_description") ?? error}`)
        if (url.searchParams.get("state") !== options.state) return fail("Sign-in failed: state mismatch")

        const code = url.searchParams.get("code")
        if (!code) return fail("Sign-in failed: callback did not include a code")

        // Settle after this response is on its way; stopping the server first would
        // reset the browser's connection instead of showing the confirmation page.
        queueMicrotask(() => settle({ code }))
        return htmlResponse("Signed in. You can close this tab and return to Codex2ClaudeCode.")
      },
    }) as { stop: (closeActiveConnections?: boolean) => unknown }
  } catch (error) {
    throw new Error(`Could not listen on ${codexLoginRedirectUri(options.port)} — is another login already running? (${error instanceof Error ? error.message : String(error)})`)
  }

  const timeout = setTimeout(() => settle({ error: new Error("Sign-in timed out") }), options.timeoutMs ?? CODEX_LOGIN_TIMEOUT_MS)
  const onAbort = () => settle({ error: new Error("Sign-in cancelled") })
  options.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    options.onAuthorizeUrl?.(options.authorizeUrl)
    await options.openBrowser?.(options.authorizeUrl)

    const settled = await result
    if (settled.error) throw settled.error
    return settled.code!
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener("abort", onAbort)
    // Graceful: let the confirmation page finish sending before the port closes.
    server.stop()
  }
}

async function exchangeAuthorizationCode(code: string, verifier: string, options: CodexBrowserLoginOptions & { port: number }) {
  const response = await (options.fetch ?? fetch)(`${options.issuer ?? DEFAULT_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: options.clientId ?? DEFAULT_CLIENT_ID,
      redirect_uri: codexLoginRedirectUri(options.port),
      code_verifier: verifier,
    }).toString(),
  })

  if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`)

  const tokens = (await response.json()) as Partial<CodexBrowserLoginTokens>
  if (!tokens.access_token || !tokens.refresh_token) throw new Error("Token exchange did not return a refresh token")
  return tokens as CodexBrowserLoginTokens
}

function htmlResponse(message: string) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Codex2ClaudeCode</title><body style="font-family:system-ui;padding:3rem"><p>${message}</p></body>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}

function randomUrlSafe(bytes: number) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url")
}

async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return Buffer.from(digest).toString("base64url")
}
