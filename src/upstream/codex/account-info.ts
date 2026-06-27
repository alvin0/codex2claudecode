import { pathExists, readTextFile, removePath, writeTextFile } from "../../core/bun-fs"
import { bunPath as path } from "../../core/paths"
import { isProviderStatePath, readProviderSection, updateProviderSection } from "../../core/provider-state"
import { resolveAuthFile } from "../../core/paths"
import type { AuthFileContent, AuthFileData } from "./types"
import { extractAccountIdFromClaims, parseJwtClaims, readAuthFileData, selectAuthEntry } from "./auth"

export interface AccountInfo {
  name?: string
  email?: string
  plan?: string
  accountId?: string
  updatedAt: string
}

export interface AccountInfoFile {
  activeAccount?: string
  accounts: Record<string, AccountInfo>
}

export async function readAccountInfoFile(authFile: string): Promise<AccountInfoFile | undefined> {
  if (isProviderStatePath(authFile)) {
    const section = await readProviderSection<AuthFileData>("codex", authFile)
    if (!section) return
    return accountInfoFromAuthData(section.data ?? [], section.activeAccount)
  }

  try {
    return normalizeAccountInfoFile(JSON.parse(await readTextFile(accountInfoPath(authFile))) as AccountInfoFile | Record<string, AccountInfo>)
  } catch {
    return
  }
}

export async function writeAccountInfoFile(authFile: string, data: AuthFileData, activeAccount?: string) {
  if (isProviderStatePath(authFile)) {
    await updateProviderSection("codex", authFile, async (section) => ({
      ...(section ?? {}),
      data,
      activeAccount: activeAccount ?? section?.activeAccount,
    }))
    return
  }

  const previous = await readAccountInfoFile(authFile)
  await writeTextFile(accountInfoPath(authFile), `${JSON.stringify(accountInfoFromAuthData(data, activeAccount ?? previous?.activeAccount), null, 2)}\n`)
}

export async function refreshActiveAccountInfo(authFile: string, account?: string) {
  if (isProviderStatePath(authFile)) {
    const section = await readProviderSection<AuthFileData>("codex", authFile)
    const data = section?.data ?? []
    const selected = selectAuthEntry(data, account ?? section?.activeAccount, authFile)
    const key = accountInfoKey(selected.auth, selected.index)
    await updateProviderSection("codex", authFile, async (current) => ({
      ...(current ?? {}),
      data,
      activeAccount: key,
    }))
    return accountInfoFromAuth(selected.auth)
  }

  const file = await readAuthFileData(authFile)
  const previous = await readAccountInfoFile(authFile)
  const selected = selectAuthEntry(file.data, account ?? previous?.activeAccount, authFile)
  const key = accountInfoKey(selected.auth, selected.index)
  await writeAccountInfoFile(authFile, file.data, key)
  return accountInfoFromAuth(selected.auth)
}

export async function writeActiveAccountInfo(authFile: string, data: AuthFileData, account: string) {
  if (isProviderStatePath(authFile)) {
    const selected = selectAuthEntry(data, account, authFile)
    await updateProviderSection("codex", authFile, async (section) => ({
      ...(section ?? {}),
      data,
      activeAccount: accountInfoKey(selected.auth, selected.index),
    }))
    return
  }

  const selected = selectAuthEntry(data, account, authFile)
  await writeAccountInfoFile(authFile, data, accountInfoKey(selected.auth, selected.index))
}

export function accountInfoPath(authFile: string) {
  if (isProviderStatePath(authFile)) return authFile
  return path.join(path.dirname(authFile), ".account-info.json")
}

export async function ensureCodexAuthFile(authFile: string) {
  if (await pathExists(authFile)) {
    const data = await readAuthFileData(authFile).catch(() => undefined)
    const entries = data ? (Array.isArray(data.data) ? data.data : [data.data]) : []
    if (entries.length) return authFile
  }

  if (isProviderStatePath(authFile)) {
    const legacyAuthFile = resolveAuthFile()
    if (legacyAuthFile !== authFile && await pathExists(legacyAuthFile)) {
      const legacyData = await readAuthFileData(legacyAuthFile)
      const legacyInfo = await readAccountInfoFile(legacyAuthFile)
      await writeAccountInfoFile(authFile, legacyData.data, legacyInfo?.activeAccount)
      await removePath(legacyAuthFile, { force: true }).catch(() => {})
      await removePath(accountInfoPath(legacyAuthFile), { force: true }).catch(() => {})
      return authFile
    }

    await writeAccountInfoFile(authFile, [], undefined)
    return authFile
  }

  await writeTextFile(authFile, "[]\n", { mode: 0o600 })
  return authFile
}

export function accountInfoFromAuthData(data: AuthFileData, activeAccount?: string): AccountInfoFile {
  const accounts = Object.fromEntries((Array.isArray(data) ? data : [data]).map((auth, index) => [accountInfoKey(auth, index), accountInfoFromAuth(auth)]))
  return {
    activeAccount: activeAccount && accounts[activeAccount] ? activeAccount : Object.keys(accounts)[0],
    accounts,
  }
}

export function accountInfoFromAuth(auth: AuthFileContent): AccountInfo {
  const claims = parseJwtClaims(auth.access) as
    | {
        email?: string
        chatgpt_account_id?: string
        "https://api.openai.com/profile"?: { email?: string }
        "https://api.openai.com/auth"?: {
          chatgpt_account_id?: string
          chatgpt_plan_type?: string
        }
      }
    | undefined
  return {
    ...(auth.name || auth.label ? { name: auth.name ?? auth.label } : {}),
    ...(auth.email || claims?.email || claims?.["https://api.openai.com/profile"]?.email
      ? { email: auth.email ?? claims?.email ?? claims?.["https://api.openai.com/profile"]?.email }
      : {}),
    ...(claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type ? { plan: claims["https://api.openai.com/auth"].chatgpt_plan_type } : {}),
    ...(auth.accountId || claims ? { accountId: auth.accountId ?? (claims ? extractAccountIdFromClaims(claims) : undefined) } : {}),
    updatedAt: new Date().toISOString(),
  }
}

export function accountInfoKey(auth: AuthFileContent, index: number) {
  return accountInfoFromAuth(auth).accountId ?? auth.email ?? auth.label ?? auth.name ?? `account-${index + 1}`
}

function normalizeAccountInfoFile(file: AccountInfoFile | Record<string, AccountInfo>): AccountInfoFile {
  if (
    "accounts" in file &&
    file.accounts &&
    typeof file.accounts === "object" &&
    !Array.isArray(file.accounts)
  ) {
    return file as AccountInfoFile
  }
  const accounts = file as Record<string, AccountInfo>
  return {
    activeAccount: Object.keys(accounts)[0],
    accounts,
  }
}
