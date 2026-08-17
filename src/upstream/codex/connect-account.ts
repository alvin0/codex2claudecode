import { writeTextFile } from "../../core/bun-fs"
import { expandHome } from "../../core/paths"
import { isProviderStatePath, updateProviderSection } from "../../core/provider-state"
import { writeAccountInfoFile } from "./account-info"
import { accessTokenExpiresAt, extractAccountId, readAuthFileData } from "./auth"
import { DEFAULT_CLIENT_ID, DEFAULT_ISSUER } from "./constants"
import { runCodexBrowserLogin, type CodexBrowserLoginOptions } from "./browser-login"
import { DEFAULT_CODEX_CLI_AUTH_FILE, readCodexCliAuthFile, syncCodexCliAuthTokens } from "./codex-auth"
import type { AuthFileContent, AuthFileData } from "./types"

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
  /** Set false to keep the credentials out of the Codex CLI auth file entirely. */
  syncCodexCli?: boolean
}

export async function connectAccount(authFile: string, draft: ConnectAccountDraft, options?: ConnectAccountOptions) {
  return saveConnectedAuth(authFile, await connectedAuthEntry(draft, options), options)
}

export async function connectAccountFromCodexAuth(authFile: string, source = DEFAULT_CODEX_CLI_AUTH_FILE, options?: ConnectAccountOptions) {
  const auth = await readCodexCliAuthFile(source)
  if (auth.auth_mode && auth.auth_mode !== "chatgpt") throw new Error(`Unsupported auth_mode: ${auth.auth_mode}`)
  const sourceAuthFile = expandHome(source)
  const entry = connectedAuthEntryFromTokens(auth.tokens?.account_id ?? "", auth.tokens?.access_token ?? "", auth.tokens?.refresh_token ?? "")
  return saveConnectedAuth(authFile, {
    ...entry,
    sourceAuthFile,
    sourceAccountKey: entry.accountId,
  }, {
    ...options,
    codexAuthFile: sourceAuthFile,
  })
}

/**
 * Signs in through the browser and stores the account here only — the Codex CLI
 * auth file is never read or written, so this does not double as a `codex` setup.
 */
export async function connectAccountFromBrowserLogin(authFile: string, options?: ConnectAccountOptions & CodexBrowserLoginOptions) {
  const tokens = await runCodexBrowserLogin(options)
  const accountId = extractAccountId(tokens)
  if (!accountId) throw new Error("Sign-in succeeded but the account id is missing from the token")

  return saveConnectedAuth(authFile, {
    type: "oauth",
    access: cleanToken(tokens.access_token),
    refresh: cleanToken(tokens.refresh_token),
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId,
  }, { ...options, syncCodexCli: false })
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
  const file = await readAuthFileData(authFile).catch(() => ({ path: authFile, data: [] as AuthFileData }))
  const entries = Array.isArray(file.data) ? file.data : [file.data]
  const index = entries.findIndex((entry) => entry.accountId === auth.accountId)
  const nextEntries = index >= 0 ? entries.map((entry, itemIndex) => (itemIndex === index ? { ...entry, ...auth } : entry)) : [...entries, auth]

  if (isProviderStatePath(authFile)) {
    await updateProviderSection("codex", authFile, async (section) => ({
      ...(section ?? {}),
      data: nextEntries,
      activeAccount: auth.accountId,
    }))
  } else {
    await writeTextFile(authFile, `${JSON.stringify(nextEntries satisfies AuthFileData, null, 2)}\n`)
    await writeAccountInfoFile(authFile, nextEntries, auth.accountId)
  }

  if (options?.syncCodexCli !== false) {
    await syncCodexCliAuthTokens({
      accountId: auth.accountId,
      accessToken: auth.access,
      refreshToken: auth.refresh,
      path: auth.sourceAuthFile ?? options?.codexAuthFile,
      sourceAccountKey: auth.sourceAccountKey,
    }).catch(() => false)
  }
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
