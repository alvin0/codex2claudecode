import { readTextFile, writeTextFile } from "../../core/bun-fs"
import { expandHome } from "../../core/paths"
import { accessTokenExpiresAt, extractAccountId } from "./auth"
import type { AuthFileContent } from "./types"

export const DEFAULT_CODEX_CLI_AUTH_FILE = "~/.codex/auth.json"

export interface CodexCliAuthFile {
  auth_mode?: string
  tokens?: {
    access_token?: string
    refresh_token?: string
    account_id?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface CodexCliTokenSnapshot {
  accountId?: string
  accessToken: string
  refreshToken: string
  expiresAt?: number
  path: string
  key?: string
}

export async function readCodexCliAuthFile(path = DEFAULT_CODEX_CLI_AUTH_FILE) {
  return JSON.parse(await readTextFile(expandHome(path))) as CodexCliAuthFile
}

export async function readCodexCliAuthTokens(path = DEFAULT_CODEX_CLI_AUTH_FILE) {
  const authFile = expandHome(path)
  const snapshot = codexCliAuthTokenSnapshot(await readCodexCliAuthFile(authFile), authFile)
  if (!snapshot) throw new Error(`Unsupported Codex CLI auth file at ${authFile}`)
  return snapshot
}

export function codexCliAuthAccountId(auth: CodexCliAuthFile) {
  return cleanToken(auth.tokens?.account_id) || extractAccountId({
    access_token: cleanToken(auth.tokens?.access_token),
    refresh_token: cleanToken(auth.tokens?.refresh_token),
  })
}

export async function pullCodexCliAuthTokens(input: {
  accountId?: string
  accessToken: string
  refreshToken: string
  sourceAuthFile?: string
  sourceAccountKey?: string
  path?: string
  strict?: boolean
}): Promise<AuthFileContent | undefined> {
  const sourceAuthFile = expandHome(input.sourceAuthFile ?? input.path ?? DEFAULT_CODEX_CLI_AUTH_FILE)
  let source: CodexCliTokenSnapshot | undefined
  try {
    source = codexCliAuthTokenSnapshot(await readCodexCliAuthFile(sourceAuthFile), sourceAuthFile)
  } catch (error) {
    if (input.strict) throw error
    return
  }
  if (!source) {
    if (input.strict) throw new Error(`Unsupported Codex CLI auth file at ${sourceAuthFile}`)
    return
  }

  const linkedBySource = Boolean(input.sourceAuthFile)
  if (linkedBySource && !codexSourceMatchesLinkedAccount(input, source)) return
  if (!linkedBySource && (!input.accountId || source.accountId !== input.accountId)) return
  if (!codexSourceAuthChanged(input, source)) return

  return {
    type: "oauth",
    access: source.accessToken,
    refresh: source.refreshToken,
    expires: source.expiresAt,
    accountId: source.accountId ?? input.accountId,
    sourceAuthFile,
    sourceAccountKey: source.key ?? input.sourceAccountKey,
  }
}

export async function syncCodexCliAuthTokens(input: { accountId?: string; accessToken: string; refreshToken: string; path?: string; sourceAccountKey?: string }) {
  if (!input.accountId) return false

  let auth: CodexCliAuthFile
  try {
    auth = await readCodexCliAuthFile(input.path)
  } catch {
    return false
  }

  if (auth.auth_mode && auth.auth_mode !== "chatgpt") return false
  if (!auth.tokens) return false
  const currentAccountKey = codexCliAuthAccountId(auth)
  const expectedAccountKey = input.sourceAccountKey ?? input.accountId
  if (!currentAccountKey || currentAccountKey !== expectedAccountKey) return false

  await writeTextFile(
    expandHome(input.path ?? DEFAULT_CODEX_CLI_AUTH_FILE),
    `${JSON.stringify({
      ...auth,
      tokens: {
        ...auth.tokens,
        account_id: input.accountId,
        access_token: input.accessToken,
        refresh_token: input.refreshToken,
      },
    } satisfies CodexCliAuthFile, null, 2)}\n`,
  )

  return true
}

function codexCliAuthTokenSnapshot(auth: CodexCliAuthFile, path: string): CodexCliTokenSnapshot | undefined {
  if (auth.auth_mode && auth.auth_mode !== "chatgpt") return
  const accessToken = cleanToken(auth.tokens?.access_token)
  const refreshToken = cleanToken(auth.tokens?.refresh_token)
  if (!accessToken || !refreshToken) return
  const accountId = codexCliAuthAccountId(auth)
  return {
    ...(accountId ? { accountId, key: accountId } : {}),
    accessToken,
    refreshToken,
    expiresAt: accessTokenExpiresAt(accessToken),
    path,
  }
}

function codexSourceAuthChanged(current: { accountId?: string; accessToken: string; refreshToken: string }, source: CodexCliTokenSnapshot) {
  return current.accessToken !== source.accessToken
    || current.refreshToken !== source.refreshToken
    || (source.accountId !== undefined && current.accountId !== source.accountId)
}

function codexSourceMatchesLinkedAccount(input: { accountId?: string; accessToken: string; refreshToken: string; sourceAccountKey?: string }, source: CodexCliTokenSnapshot) {
  const expectedAccountKey = input.sourceAccountKey ?? input.accountId
  if (!expectedAccountKey) return false
  if (source.key === expectedAccountKey) return true
  return input.accessToken === source.accessToken || input.refreshToken === source.refreshToken
}

function cleanToken(value?: string) {
  return (value ?? "").trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, "")
}
