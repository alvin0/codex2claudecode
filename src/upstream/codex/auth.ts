import { readTextFile } from "../../core/bun-fs"
import { resolveAuthFile } from "../../core/paths"
import type { AuthFileContent, AuthFileData, TokenResponse } from "./types"

export async function readAuthFile(path: string, account?: string) {
  return selectAuthEntry((await readAuthFileData(path)).data, account, path).auth
}

export async function readAuthFileData(path: string) {
  return {
    path: resolveAuthFile(path),
    data: JSON.parse(await readTextFile(resolveAuthFile(path))) as AuthFileData,
  }
}

export function selectAuthEntry(data: AuthFileData, account?: string, path = "auth-codex.json") {
  const entries = Array.isArray(data) ? data : [data]
  if (!entries.length) throw new Error(`Auth file ${path} does not contain any accounts`)
  const index = account
    ? entries.findIndex((auth, itemIndex) => [auth.name, auth.label, auth.email, auth.accountId, auth.sourceAccountKey, authEntryKey(auth, itemIndex)].includes(account))
    : 0
  if (index < 0) throw new Error(`Auth file ${path} does not contain account ${account}`)
  return {
    auth: validateAuthEntry(entries[index], path),
    index,
    isArray: Array.isArray(data),
  }
}

function authEntryKey(auth: AuthFileContent, index: number) {
  return auth.accountId ?? extractAccountId({ access_token: auth.access, refresh_token: auth.refresh }) ?? auth.email ?? auth.label ?? auth.name ?? `account-${index + 1}`
}

function validateAuthEntry(auth: AuthFileContent, path: string) {
  if (auth.type !== "oauth") throw new Error(`Auth file ${path} is not an oauth auth file`)
  if (!auth.access) throw new Error(`Auth file ${path} is missing access`)
  if (!auth.refresh) throw new Error(`Auth file ${path} is missing refresh`)
  return auth
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as IdTokenClaims
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return claims.chatgpt_account_id || claims["https://api.openai.com/auth"]?.chatgpt_account_id || claims.organizations?.[0]?.id
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

export function accessTokenExpiresAt(accessToken: string) {
  const payload = accessToken.split(".")[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp?: unknown }
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}
