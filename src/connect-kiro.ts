import { access, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

import { ensureParentDir, resolveKiroAuthFile } from "./paths"
import { readCredentialsFile } from "./llm-connect/kiro/credentials"
import { KiroAuthManager, resolveAuthType } from "./llm-connect/kiro/auth"
import type { KiroCredentialSnapshot } from "./llm-connect/kiro/types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KiroConnectDraft {
  refreshToken: string
  region: string
}

/** One entry in the auth-kiro.json array. */
export interface KiroAuthEntry {
  name?: string
  refreshToken: string
  accessToken?: string
  region: string
  expiresAt?: number
  profileArn?: string
  clientId?: string
  clientSecret?: string
  clientIdHash?: string
  authType: string
}

export type KiroAuthData = KiroAuthEntry | KiroAuthEntry[]

export interface KiroAccountView {
  key: string
  name: string
  authType: string
  region: string
  profileArn?: string
  hasToken: boolean
}

// ---------------------------------------------------------------------------
// Default AWS SSO cache path for Kiro
// ---------------------------------------------------------------------------

export const DEFAULT_KIRO_SSO_CACHE_FILE = path.join(
  homedir(),
  ".aws",
  "sso",
  "cache",
  "kiro-auth-token.json",
)

// ---------------------------------------------------------------------------
// Read / write the multi-account auth file
// ---------------------------------------------------------------------------

export async function readKiroAuthData(authFile?: string): Promise<{ path: string; data: KiroAuthEntry[] }> {
  const filePath = resolveKiroAuthFile(authFile)
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as KiroAuthData
    const entries = Array.isArray(raw) ? raw : [raw]
    return { path: filePath, data: entries }
  } catch {
    return { path: filePath, data: [] }
  }
}

async function writeKiroAuthData(authFile: string, entries: KiroAuthEntry[]) {
  await ensureParentDir(authFile)
  await writeFile(authFile, `${JSON.stringify(entries, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Connect: manual (refreshToken + region)
// ---------------------------------------------------------------------------

export async function connectKiro(draft: KiroConnectDraft, authFile?: string) {
  const refreshToken = draft.refreshToken.trim()
  if (!refreshToken) throw new Error("refreshToken is required")
  const region = draft.region.trim() || "us-east-1"

  const authManager = await KiroAuthManager.fromSources({ refreshToken, region })
  const tokens = await authManager.refresh()

  const entry: KiroAuthEntry = {
    refreshToken: tokens.refreshToken ?? refreshToken,
    accessToken: tokens.accessToken,
    region,
    expiresAt: tokens.expiresAt,
    profileArn: tokens.profileArn,
    authType: tokens.authType,
    name: entryName(tokens.profileArn, tokens.authType, region),
  }

  return saveKiroEntry(authFile, entry)
}

// ---------------------------------------------------------------------------
// Connect: sync from ~/.aws/sso/cache/kiro-auth-token.json
// ---------------------------------------------------------------------------

export async function connectKiroFromSsoCache(authFile?: string, source = DEFAULT_KIRO_SSO_CACHE_FILE) {
  if (!(await pathExists(source))) {
    throw new Error(`Kiro SSO cache file not found: ${source}`)
  }

  const snapshot = await readCredentialsFile(source)
  if (!snapshot.refreshToken && !snapshot.accessToken) {
    throw new Error("Kiro SSO cache file does not contain tokens")
  }

  const region = snapshot.ssoRegion ?? snapshot.detectedApiRegion ?? "us-east-1"
  const authType = resolveAuthType(snapshot)

  const entry: KiroAuthEntry = {
    refreshToken: snapshot.refreshToken ?? "",
    accessToken: snapshot.accessToken,
    region,
    expiresAt: snapshot.expiresAt,
    profileArn: snapshot.profileArn,
    clientId: snapshot.clientId,
    clientSecret: snapshot.clientSecret,
    clientIdHash: snapshot.clientIdHash,
    authType,
    name: entryName(snapshot.profileArn, authType, region),
  }

  return saveKiroEntry(authFile, entry)
}

// ---------------------------------------------------------------------------
// Save entry (upsert by profileArn or name)
// ---------------------------------------------------------------------------

async function saveKiroEntry(authFile: string | undefined, entry: KiroAuthEntry) {
  const file = await readKiroAuthData(authFile)
  const key = entryKey(entry)
  const existingIndex = file.data.findIndex((e) => entryKey(e) === key)
  const nextEntries =
    existingIndex >= 0
      ? file.data.map((e, i) => (i === existingIndex ? { ...e, ...entry } : e))
      : [...file.data, entry]

  await writeKiroAuthData(file.path, nextEntries)

  return {
    key,
    name: entry.name ?? key,
    authType: entry.authType,
    region: entry.region,
    data: nextEntries,
  }
}

// ---------------------------------------------------------------------------
// Account views (for UI)
// ---------------------------------------------------------------------------

export function kiroAuthDataToAccounts(data: KiroAuthEntry[]): KiroAccountView[] {
  return data.map((entry, index) => ({
    key: entryKey(entry) || `kiro-${index + 1}`,
    name: entry.name ?? (entryKey(entry) || `kiro-${index + 1}`),
    authType: entry.authType ?? "kiro_desktop",
    region: entry.region ?? "us-east-1",
    profileArn: entry.profileArn,
    hasToken: Boolean(entry.refreshToken || entry.accessToken),
  }))
}

export function selectedKiroAccountIndex(data: KiroAuthEntry[], account?: string): number {
  if (!account) return 0
  const index = data.findIndex((e, i) => entryKey(e) === account || e.name === account || `kiro-${i + 1}` === account)
  return index >= 0 ? index : 0
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entryKey(entry: KiroAuthEntry): string {
  return entry.profileArn ?? entry.clientIdHash ?? entry.name ?? ""
}

function entryName(profileArn?: string, authType?: string, region?: string): string {
  if (profileArn) {
    // arn:aws:codewhisperer:us-east-1:123456:profile/xxx → extract account
    const parts = profileArn.split(":")
    const awsAccount = parts[4]
    return awsAccount ? `kiro-${awsAccount.slice(0, 8)}` : `kiro-${region ?? "default"}`
  }
  const typeLabel = authType === "aws_sso_oidc" ? "sso" : "desktop"
  return `kiro-${typeLabel}-${region ?? "default"}`
}

async function pathExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}
