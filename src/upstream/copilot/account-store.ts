import { atomicJsonWrite, pathExists, readTextFile, removePath } from "../../core/bun-fs"
import { expandHome } from "../../core/paths"
import { bunPath as path } from "../../core/paths"
import { appDataDir } from "../../core/paths"
import { isProviderStatePath, readProviderSection, updateProviderSection } from "../../core/provider-state"
import { COPILOT_AUTH_FILE_NAME, COPILOT_CACHE_FILE_NAME } from "./constants"
import { fetchCopilotAccountSnapshot } from "./auth"
import { readCopilotCacheFile, writeCopilotCacheFile, writeCopilotModelCache, writeCopilotTokenCache } from "./cache"
import type { CopilotAccountSnapshot, CopilotAuthFileData, CopilotAuthTokenFile, CopilotAuthType, CopilotManagedAuthFile } from "./types"

export interface ConnectCopilotAccountDraft {
  label?: string
  githubToken: string
  accountType?: string
}

export interface ConnectCopilotAccountOptions {
  fetch?: typeof fetch
  authType?: CopilotAuthType
}

export interface CopilotAuthFileSelection {
  data: CopilotAuthFileData
  credentials: CopilotAuthTokenFile
  filePath: string
  format: "single" | "array" | "managed"
  index: number
  key: string
}

export async function readCopilotAuthFileSelection(filePath = path.join(appDataDir(), COPILOT_AUTH_FILE_NAME), account?: string): Promise<CopilotAuthFileSelection> {
  const authFilePath = expandHome(filePath)
  if (isProviderStatePath(authFilePath)) {
    const section = await readProviderSection<CopilotAuthFileData>("copilot", authFilePath)
    const parsed = section?.data ?? { activeAccount: undefined, accounts: [] }
    return selectCopilotAuthEntry(parsed, account ?? section?.activeAccount, authFilePath)
  }

  let raw: string
  try {
    raw = await readTextFile(authFilePath)
  } catch (error) {
    throw new Error(`Copilot auth file not found at ${authFilePath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Failed to parse Copilot auth file ${authFilePath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  return selectCopilotAuthEntry(parsed, account, authFilePath)
}

export async function readCopilotAuthFileData(filePath: string): Promise<CopilotAuthFileData> {
  return (await readCopilotAuthFileSelection(filePath)).data
}

export async function ensureCopilotAuthFile(authFile = path.join(appDataDir(), COPILOT_AUTH_FILE_NAME)) {
  if (await pathExists(authFile)) {
    const data = await readCopilotAuthFileData(authFile).catch(() => ({ activeAccount: undefined, accounts: [] } satisfies CopilotManagedAuthFile))
    if (copilotAuthEntries(data).length) return authFile
  }

  const legacyAuthFile = path.join(appDataDir(), "copilot-auth.json")
  const legacyCacheFile = path.join(appDataDir(), ".copilot-cache.json")

  if (isProviderStatePath(authFile)) {
    if (await pathExists(legacyAuthFile)) {
      const legacyData = await readCopilotAuthFileData(legacyAuthFile)
      await writeCopilotAuthFile(authFile, legacyData)
      if (await pathExists(legacyCacheFile)) {
        const legacyCache = await readCopilotCacheFile(legacyCacheFile)
        await writeCopilotCacheFile(legacyCache)
      }
      await removePath(legacyAuthFile, { force: true }).catch(() => {})
      await removePath(legacyCacheFile, { force: true }).catch(() => {})
      return authFile
    }

    await writeCopilotAuthFile(authFile, { activeAccount: undefined, accounts: [] })
    return authFile
  }

  if (await pathExists(legacyAuthFile)) return legacyAuthFile

  await atomicJsonWrite(authFile, { activeAccount: undefined, accounts: [] }, { mode: 0o600 })
  return authFile
}

export async function connectCopilotAccount(authFile: string, draft: ConnectCopilotAccountDraft, options?: ConnectCopilotAccountOptions) {
  const githubToken = cleanToken(draft.githubToken)
  if (!githubToken) throw new Error("githubToken is required")

  const snapshot = await fetchCopilotAccountSnapshot(githubToken, {
    fetch: options?.fetch,
    accountType: draft.accountType,
    authType: options?.authType,
  })
  const entry = connectedCopilotAuthEntry(draft, snapshot)
  return saveConnectedCopilotAuth(authFile, entry, snapshot)
}

export async function connectCopilotAccountFromGitHubToken(authFile: string, githubToken: string, options?: ConnectCopilotAccountOptions) {
  return connectCopilotAccount(authFile, { githubToken }, options)
}

export async function writeActiveCopilotAccount(authFile: string, data: CopilotAuthFileData, account: string) {
  const selected = selectCopilotAuthEntry(data, account, authFile)
  await writeCopilotAuthFile(authFile, managedCopilotAuthFile(data, selected.key, copilotAuthEntries(data)))
}

export async function saveCopilotCache(authFile: string, accountKey: string, snapshot: CopilotAccountSnapshot) {
  await writeCopilotTokenCache(accountKey, {
    copilotToken: snapshot.copilotToken,
    expiresAt: snapshot.copilotTokenExpiresAt,
    accountType: snapshot.accountType,
  }, cacheFilePath(authFile))
  await writeCopilotModelCache(accountKey, {
    models: [],
    fetchedAt: new Date().toISOString(),
  }, cacheFilePath(authFile))
}

export function selectCopilotAuthEntry(value: unknown, account?: string, filePath = "copilot-auth.json"): CopilotAuthFileSelection {
  const normalized = normalizeCopilotAuthFileData(value, filePath)
  const activeAccount = normalized.format === "managed" ? (normalized.data as CopilotManagedAuthFile).activeAccount : undefined
  const requested = account ?? activeAccount
  const requestedIndex = requested ? normalized.accounts.findIndex((auth, index) => copilotAuthEntryAliases(auth, index).includes(requested)) : -1
  if (account && requestedIndex < 0) throw new Error(`Copilot auth file ${filePath} does not contain account ${account}`)
  const index = requestedIndex >= 0 ? requestedIndex : 0
  const credentials = normalized.accounts[index]
  if (!credentials) throw new Error(`Copilot auth file ${filePath} does not contain any accounts`)

  return {
    data: normalized.data,
    credentials,
    filePath,
    format: normalized.format,
    index,
    key: copilotAccountKey(credentials, index),
  }
}

export function updateCopilotAuthSelection(selection: CopilotAuthFileSelection, credentials: CopilotAuthTokenFile): CopilotAuthFileData {
  if (selection.format === "single") return credentials
  if (selection.format === "array") {
    return (selection.data as CopilotAuthTokenFile[]).map((account, index) => index === selection.index ? credentials : account)
  }
  const data = selection.data as CopilotManagedAuthFile
  return {
    ...data,
    activeAccount: copilotAccountKey(credentials, selection.index),
    accounts: data.accounts.map((account, index) => index === selection.index ? credentials : account),
  }
}

export function copilotAuthEntries(data: CopilotAuthFileData): CopilotAuthTokenFile[] {
  if (Array.isArray(data)) return data
  if (isCopilotManagedAuthFile(data)) return data.accounts
  return [data]
}

export function copilotAccountKey(auth: CopilotAuthTokenFile, index: number) {
  return firstString(auth.accountId, auth.email, auth.label, auth.accountType, auth.sourceAuthFile) ?? `copilot-account-${index + 1}`
}

export function validateCopilotAuthToken(value: unknown, filePath: string): CopilotAuthTokenFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Copilot auth file ${filePath} must contain a JSON object`)
  const item = value as Record<string, unknown>
  if (typeof item.githubToken !== "string") throw new Error(`Copilot auth file ${filePath} is missing string field githubToken`)
  return {
    type: "copilot",
    githubToken: item.githubToken,
    ...(typeof item.label === "string" ? { label: item.label } : {}),
    ...(typeof item.accountId === "string" ? { accountId: item.accountId } : {}),
    ...(typeof item.email === "string" ? { email: item.email } : {}),
    ...(typeof item.plan === "string" ? { plan: item.plan } : {}),
    ...(typeof item.accountType === "string" ? { accountType: item.accountType } : {}),
    ...(typeof item.authType === "string" ? { authType: item.authType as CopilotAuthTokenFile["authType"] } : {}),
    ...(typeof item.sourceAuthFile === "string" ? { sourceAuthFile: item.sourceAuthFile } : {}),
    ...(typeof item.sourceAccountKey === "string" ? { sourceAccountKey: item.sourceAccountKey } : {}),
  }
}

async function saveConnectedCopilotAuth(authFile: string, auth: CopilotAuthTokenFile, snapshot: CopilotAccountSnapshot) {
  const file = await readCopilotAuthFileData(authFile).catch(() => ({ activeAccount: undefined, accounts: [] } satisfies CopilotManagedAuthFile))
  const entries = copilotAuthEntries(file)
  const index = entries.findIndex((entry, itemIndex) => copilotAuthEntryAliases(entry, itemIndex).some((alias) => copilotAuthEntryAliases(auth, itemIndex).includes(alias)))
  const nextEntries = index >= 0 ? entries.map((entry, itemIndex) => itemIndex === index ? { ...entry, ...auth } : entry) : [...entries, auth]
  const accountIndex = index >= 0 ? index : nextEntries.length - 1
  const accountKey = copilotAccountKey(nextEntries[accountIndex], accountIndex)
  const data = managedCopilotAuthFile(file, accountKey, nextEntries)
  await writeCopilotAuthFile(authFile, data)
  await saveCopilotCache(authFile, accountKey, snapshot)
  return { accountKey, data }
}

function connectedCopilotAuthEntry(draft: ConnectCopilotAccountDraft, snapshot: CopilotAccountSnapshot): CopilotAuthTokenFile {
  const label = cleanText(draft.label)
  const accountType = cleanToken(draft.accountType) || snapshot.accountType
  const githubToken = cleanToken(draft.githubToken)
  if (!githubToken) throw new Error("githubToken is required")
  return {
    type: "copilot",
    githubToken,
    ...(label ? { label } : {}),
    ...(snapshot.accountId ? { accountId: snapshot.accountId } : {}),
    ...(snapshot.email ? { email: snapshot.email } : {}),
    ...(snapshot.plan ? { plan: snapshot.plan } : {}),
    ...(accountType ? { accountType } : {}),
    authType: snapshot.authType,
  }
}

export async function writeCopilotAuthFile(authFile: string, data: CopilotAuthFileData) {
  if (isProviderStatePath(authFile)) {
    const activeAccount = Array.isArray(data) ? undefined : (data as CopilotManagedAuthFile).activeAccount
    await updateProviderSection("copilot", authFile, async (section) => ({
      ...(section ?? {}),
      data,
      activeAccount: activeAccount ?? section?.activeAccount,
    }))
    return
  }

  await atomicJsonWrite(expandHome(authFile), data, { mode: 0o600 })
}

export function managedCopilotAuthFile(data: CopilotAuthFileData, activeAccount: string, accounts: CopilotAuthTokenFile[]): CopilotManagedAuthFile {
  if (isCopilotManagedAuthFile(data)) {
    return {
      ...data,
      activeAccount,
      accounts,
    }
  }
  return {
    activeAccount,
    accounts,
  }
}

function normalizeCopilotAuthFileData(value: unknown, filePath: string): { data: CopilotAuthFileData; accounts: CopilotAuthTokenFile[]; format: "single" | "array" | "managed" } {
  if (Array.isArray(value)) {
    const accounts = value.map((entry, index) => validateCopilotAuthToken(entry, `${filePath}[${index}]`))
    return { data: accounts, accounts, format: "array" }
  }
  if (isCopilotManagedAuthFile(value)) {
    const accounts = value.accounts.map((entry, index) => validateCopilotAuthToken(entry, `${filePath}.accounts[${index}]`))
    return { data: { ...value, accounts }, accounts, format: "managed" }
  }
  return { data: validateCopilotAuthToken(value, filePath), accounts: [validateCopilotAuthToken(value, filePath)], format: "single" }
}

function copilotAuthEntryAliases(auth: CopilotAuthTokenFile, index: number) {
  return [
    auth.accountId,
    auth.email,
    auth.label,
    auth.accountType,
    auth.sourceAccountKey,
    copilotAccountKey(auth, index),
  ].filter((value): value is string => typeof value === "string" && value.length > 0)
}

function cacheFilePath(authFile: string) {
  return path.join(path.dirname(expandHome(authFile)), COPILOT_CACHE_FILE_NAME)
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)
}

function cleanToken(value?: string) {
  return value?.trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, "") ?? ""
}

function cleanText(value?: string) {
  const cleaned = value?.trim()
  return cleaned ? cleaned : undefined
}

function isCopilotManagedAuthFile(value: unknown): value is CopilotManagedAuthFile {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as CopilotManagedAuthFile).accounts))
}
