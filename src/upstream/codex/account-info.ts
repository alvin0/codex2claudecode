import { readTextFile, writeTextFile } from "../../core/bun-fs"
import { bunPath as path } from "../../core/paths"
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
  try {
    return normalizeAccountInfoFile(JSON.parse(await readTextFile(accountInfoPath(authFile))) as AccountInfoFile | Record<string, AccountInfo>)
  } catch {
    return
  }
}

export async function writeAccountInfoFile(authFile: string, data: AuthFileData, activeAccount?: string) {
  const previous = await readAccountInfoFile(authFile)
  await writeTextFile(accountInfoPath(authFile), `${JSON.stringify(accountInfoFromAuthData(data, activeAccount ?? previous?.activeAccount), null, 2)}\n`)
}

export async function refreshActiveAccountInfo(authFile: string, account?: string) {
  const file = await readAuthFileData(authFile)
  const previous = await readAccountInfoFile(authFile)
  const selected = selectAuthEntry(file.data, account ?? previous?.activeAccount, authFile)
  const key = accountInfoKey(selected.auth, selected.index)
  await writeAccountInfoFile(authFile, file.data, key)
  return accountInfoFromAuth(selected.auth)
}

export async function writeActiveAccountInfo(authFile: string, data: AuthFileData, account: string) {
  const selected = selectAuthEntry(data, account, authFile)
  await writeAccountInfoFile(authFile, data, accountInfoKey(selected.auth, selected.index))
}

export function accountInfoPath(authFile: string) {
  return path.join(path.dirname(authFile), ".account-info.json")
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
