import { readAuthFileData } from "./auth"
import { writeAccountInfoFile } from "./account-info"
import { extractAccountId } from "./auth"
import { DEFAULT_CODEX_CLI_AUTH_FILE, readCodexCliAuthFile, syncCodexCliAuthTokens } from "./codex-auth"
import type { AuthFileContent, AuthFileData } from "./types"
import { writeFile } from "node:fs/promises"
import { DEFAULT_CLIENT_ID, DEFAULT_ISSUER } from "./constants"
import { ensureParentDir } from "./paths"

export interface ConnectAccountDraft {
  accountId: string
  accessToken: string
  refreshToken: string
}

export interface ConnectAccountOptions {
  issuer?: string
  clientId?: string
  fetch?: typeof fetch
  codexAuthFile?: string
}

export async function connectAccount(authFile: string, draft: ConnectAccountDraft, options?: ConnectAccountOptions) {
  return saveConnectedAuth(authFile, await connectedAuthEntry(draft, options), options)
}

export async function connectAccountFromCodexAuth(authFile: string, source = DEFAULT_CODEX_CLI_AUTH_FILE, options?: ConnectAccountOptions) {
  const auth = await readCodexCliAuthFile(source)
  if (auth.auth_mode && auth.auth_mode !== "chatgpt") throw new Error(`Unsupported auth_mode: ${auth.auth_mode}`)
  return saveConnectedAuth(authFile, connectedAuthEntryFromTokens(auth.tokens?.account_id ?? "", auth.tokens?.access_token ?? "", auth.tokens?.refresh_token ?? ""), {
    ...options,
    codexAuthFile: source,
  })
}

async function connectedAuthEntry(draft: ConnectAccountDraft, options?: ConnectAccountOptions): Promise<AuthFileContent> {
  const refreshToken = cleanToken(draft.refreshToken)
  const accessToken = cleanToken(draft.accessToken)
  if (!refreshToken) throw new Error("refreshToken is required")
  const tokens = await refreshAccessToken(refreshToken, options)
  const accountId = cleanToken(draft.accountId) || extractAccountId(tokens) || extractAccountId({ access_token: accessToken, refresh_token: refreshToken })
  if (!accountId) throw new Error("accountId is required")
  return {
    type: "oauth",
    access: cleanToken(tokens.access_token),
    refresh: tokens.refresh_token ? cleanToken(tokens.refresh_token) : refreshToken,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId,
  }
}

async function saveConnectedAuth(authFile: string, auth: AuthFileContent, options?: ConnectAccountOptions) {
  const file = await readAuthFileData(authFile).catch(() => ({ path: authFile, data: [] as AuthFileContent[] }))
  const entries = Array.isArray(file.data) ? file.data : [file.data]
  const index = entries.findIndex((entry) => entry.accountId === auth.accountId)
  const nextEntries = index >= 0 ? entries.map((entry, itemIndex) => (itemIndex === index ? { ...entry, ...auth } : entry)) : [...entries, auth]
  await ensureParentDir(authFile)
  await writeFile(authFile, `${JSON.stringify(nextEntries satisfies AuthFileData, null, 2)}\n`)
  await writeAccountInfoFile(authFile, nextEntries, auth.accountId)
  await syncCodexCliAuthTokens({
    accountId: auth.accountId,
    accessToken: auth.access,
    refreshToken: auth.refresh,
    path: options?.codexAuthFile,
  }).catch(() => false)
  return {
    accountId: auth.accountId,
    data: nextEntries,
  }
}

function connectedAuthEntryFromTokens(accountIdInput: string, accessTokenInput: string, refreshTokenInput: string): AuthFileContent {
  const access = cleanToken(accessTokenInput)
  const refresh = cleanToken(refreshTokenInput)
  const accountId = cleanToken(accountIdInput) || extractAccountId({ access_token: access, refresh_token: refresh })
  if (!accountId) throw new Error("accountId is required")
  if (!access) throw new Error("accessToken is required")
  if (!refresh) throw new Error("refreshToken is required")
  return {
    type: "oauth",
    access,
    refresh,
    expires: accessTokenExpiresAt(access),
    accountId,
  }
}

async function refreshAccessToken(refreshToken: string, options?: ConnectAccountOptions) {
  const response = await (options?.fetch ?? fetch)(`${options?.issuer ?? DEFAULT_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: options?.clientId ?? DEFAULT_CLIENT_ID,
    }).toString(),
  })
  if (response.ok) return (await response.json()) as { access_token: string; refresh_token?: string; expires_in?: number; id_token?: string }
  throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`)
}

function cleanToken(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, "")
}

function accessTokenExpiresAt(accessToken: string) {
  const payload = accessToken.split(".")[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp?: unknown }
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}
