import { atomicJsonWrite, pathExists, readTextFile, removePath, setFileMode, writeTextFile } from "../../core/bun-fs"
import { appDataDir, expandHome } from "../../core/paths"
import { bunPath as path } from "../../core/paths"
import { isProviderStatePath, readProviderSection, updateProviderSection, writeProviderSection } from "../../core/provider-state"
import { KIRO_AUTH_TOKEN_PATH, KIRO_STATE_FILE_NAME } from "./constants"
import { resolveKiroSourceAuthFile } from "./auth-source"
import type { KiroAuthFileData, KiroAuthTokenFile, KiroManagedAuthFile } from "./types"

const SOURCE_PULL_OPTIONAL_FIELDS = ["profileArn", "clientIdHash", "clientId", "clientSecret", "accountId"] as const
const SOURCE_WRITE_OPTIONAL_FIELDS = ["profileArn", "clientIdHash", "clientId", "clientSecret"] as const

export interface ConnectKiroAccountDraft {
  label: string
  accessToken: string
  refreshToken: string
  region: string
  profileArn: string
}

export type KiroAuthFileFormat = "single" | "array" | "managed"

type NormalizedKiroAuthFileData =
  | { data: KiroAuthTokenFile; accounts: KiroAuthTokenFile[]; format: "single" }
  | { data: KiroAuthTokenFile[]; accounts: KiroAuthTokenFile[]; format: "array" }
  | { data: KiroManagedAuthFile; accounts: KiroAuthTokenFile[]; format: "managed" }

export interface KiroAuthFileSelection {
  data: KiroAuthFileData
  credentials: KiroAuthTokenFile
  filePath: string
  format: KiroAuthFileFormat
  index: number
  key: string
}

interface UpdateKiroAuthSelectionOptions {
  preserveActiveAccount?: boolean
}

export async function readKiroAuthFileSelection(filePath = KIRO_AUTH_TOKEN_PATH, account?: string): Promise<KiroAuthFileSelection> {
  const authFilePath = expandHome(filePath)
  if (isProviderStatePath(authFilePath)) {
    const section = await readProviderSection<KiroAuthFileData>("kiro", authFilePath)
    const parsed = section?.data ?? { activeAccount: undefined, accounts: [] }
    return selectKiroAuthEntry(parsed, account ?? section?.activeAccount, authFilePath)
  }

  let raw: string
  try {
    raw = await readTextFile(authFilePath)
  } catch (error) {
    throw new Error(`Kiro auth token file not found at ${authFilePath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Failed to parse Kiro auth token file ${authFilePath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  return selectKiroAuthEntry(parsed, account, authFilePath)
}

export async function readKiroAuthFileData(filePath: string): Promise<KiroAuthFileData> {
  if (isProviderStatePath(filePath)) {
    const section = await readProviderSection<KiroAuthFileData>("kiro", filePath)
    return section?.data ?? { activeAccount: undefined, accounts: [] }
  }

  return (await readKiroAuthFileSelection(filePath)).data
}

export async function ensureKiroAuthFile(authFile = path.join(appDataDir(), KIRO_STATE_FILE_NAME)) {
  if (await pathExists(authFile)) {
    const data = await readKiroAuthFileData(authFile).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes("does not contain any accounts")) throw error
      return { activeAccount: undefined, accounts: [] } satisfies KiroAuthFileData
    })
    if (kiroAuthEntries(data).length) return authFile
  }

  if (isProviderStatePath(authFile)) {
    for (const legacyName of ["kiro-state.json", "auth-kiro.json"]) {
      const legacyPath = path.join(path.dirname(authFile), legacyName)
      if (!(await pathExists(legacyPath))) continue
      const legacyData = await readKiroAuthFileData(legacyPath).catch(() => undefined)
      if (!legacyData || !kiroAuthEntries(legacyData).length) continue
      const selected = selectKiroAuthEntry(legacyData, undefined, legacyPath)
      await writeActiveKiroAccount(authFile, legacyData, selected.key)
      await removePath(legacyPath, { force: true }).catch(() => {})
      return authFile
    }
  }

  const sourceAuthFile = await resolveKiroSourceAuthFile()
  if (isProviderStatePath(authFile)) {
    if (sourceAuthFile !== authFile && await pathExists(sourceAuthFile)) {
      await connectKiroAccountFromKiroAuth(authFile, sourceAuthFile)
      return authFile
    }
    await writeProviderSection("kiro", { data: { activeAccount: undefined, accounts: [] } }, authFile)
    return authFile
  }

  if (await pathExists(sourceAuthFile)) {
    return sourceAuthFile
  }

  await atomicJsonWrite(authFile, { activeAccount: undefined, accounts: [] }, { mode: 0o600 })
  return authFile
}

export async function connectKiroAccount(authFile: string, draft: ConnectKiroAccountDraft) {
  return saveConnectedKiroAuth(authFile, connectedKiroAuthEntry(draft))
}

export async function connectKiroAccountFromKiroAuth(authFile: string, source = KIRO_AUTH_TOKEN_PATH) {
  const selected = await readKiroAuthFileSelection(source)
  return saveConnectedKiroAuth(authFile, {
    ...stripSourceMetadata(selected.credentials),
    sourceAuthFile: selected.filePath,
    sourceAccountIndex: selected.index,
    sourceAccountKey: selected.key,
  })
}

/**
 * Imports the active account from each provided Kiro source auth file into the
 * managed auth file. Sources are processed in order; unreadable sources are
 * skipped. Throws when none of the sources can be imported.
 */
export async function connectKiroAccountsFromKiroAuth(authFile: string, sources: string[]) {
  let result: { accountKey: string; data: KiroAuthFileData } | undefined
  const failures: string[] = []
  for (const source of sources) {
    try {
      result = await connectKiroAccountFromKiroAuth(authFile, source)
    } catch (error) {
      failures.push(`${source}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!result) {
    const detail = failures.length ? `:\n${failures.join("\n")}` : ""
    throw new Error(`No Kiro auth token files could be imported${detail}`)
  }
  return result
}

export async function writeActiveKiroAccount(authFile: string, data: KiroAuthFileData, account: string) {
  const selected = selectKiroAuthEntry(data, account, authFile)
  await writeKiroManagedAuthFile(authFile, managedKiroAuthFile(data, selected.key, kiroAuthEntries(data)))
}

export function selectKiroAuthEntry(value: unknown, account?: string, filePath = "kiro-auth-token.json"): KiroAuthFileSelection {
  const normalized = normalizeKiroAuthFileData(value, filePath)
  const activeAccount = normalized.format === "managed" ? normalized.data.activeAccount : undefined
  const requested = account ?? activeAccount
  const requestedIndex = requested ? normalized.accounts.findIndex((auth, index) => kiroAuthEntryAliases(auth, index).includes(requested)) : -1

  if (account && requestedIndex < 0) throw new Error(`Kiro auth token file ${filePath} does not contain account ${account}`)
  const index = requestedIndex >= 0 ? requestedIndex : 0
  const credentials = normalized.accounts[index]
  if (!credentials) throw new Error(`Kiro auth token file ${filePath} does not contain any accounts`)

  return {
    data: normalized.data,
    credentials,
    filePath,
    format: normalized.format,
    index,
    key: kiroAccountKey(credentials, index),
  }
}

export function updateKiroAuthSelection(selection: KiroAuthFileSelection, credentials: KiroAuthTokenFile, options: UpdateKiroAuthSelectionOptions = {}): KiroAuthFileData {
  if (selection.format === "single") return credentials

  if (selection.format === "array") {
    return (selection.data as KiroAuthTokenFile[]).map((account, index) => index === selection.index ? credentials : account)
  }

  const data = selection.data as { activeAccount?: string; accounts: KiroAuthTokenFile[]; [key: string]: unknown }
  const accounts = data.accounts.map((account, index) => index === selection.index ? credentials : account)
  return {
    ...data,
    activeAccount: options.preserveActiveAccount ? preserveKiroActiveAccount(data.activeAccount, selection, credentials) : kiroAccountKey(credentials, selection.index),
    accounts,
  }
}

export async function syncKiroSourceAuth(authFile: string, credentials: KiroAuthTokenFile) {
  if (!credentials.sourceAuthFile) return
  const sourceAuthFile = expandHome(credentials.sourceAuthFile)
  if (sourceAuthFile === expandHome(authFile)) return

  const sourceSelection = await readKiroSourceAuthSelection(sourceAuthFile, credentials)
  if (!sourceSelection) return
  const sourceCredentials = sourceWritableCredentials(credentials)
  const payload = updateKiroAuthSelection(sourceSelection, {
    ...sourceSelection.credentials,
    ...sourceCredentials,
  }, {
    preserveActiveAccount: true,
  })

  await writeKiroAuthFile(sourceAuthFile, payload)
}

export async function pullKiroSourceAuth(authFile: string, credentials: KiroAuthTokenFile): Promise<KiroAuthTokenFile | undefined> {
  if (!credentials.sourceAuthFile) return
  const sourceAuthFile = expandHome(credentials.sourceAuthFile)
  if (sourceAuthFile === expandHome(authFile)) return

  const sourceSelection = await readKiroSourceAuthSelection(sourceAuthFile, credentials)
  if (!sourceSelection) return
  if (!sourceAuthChanged(credentials, sourceSelection.credentials)) return

  return {
    ...credentials,
    ...sourceManagedCredentials(credentials, sourceSelection.credentials),
    sourceAuthFile,
    sourceAccountIndex: sourceSelection.index,
    sourceAccountKey: sourceSelection.key,
  }
}

export function kiroAuthEntries(data: KiroAuthFileData): KiroAuthTokenFile[] {
  if (Array.isArray(data)) return data
  if (isKiroManagedAuthFile(data)) return data.accounts
  return [data]
}

export function kiroAccountKey(auth: KiroAuthTokenFile, index: number) {
  return firstString(auth.accountId, auth.profileArn, auth.email, auth.label, auth.name, auth.clientIdHash) ?? `${auth.region}:account-${index + 1}`
}

export function validateKiroAuthToken(value: unknown, filePath: string): KiroAuthTokenFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Kiro auth token file ${filePath} must contain a JSON object`)
  const item = value as Record<string, unknown>
  for (const field of ["accessToken", "refreshToken", "expiresAt", "region"]) {
    if (typeof item[field] !== "string") throw new Error(`Kiro auth token file ${filePath} is missing string field ${field}`)
  }
  if (!isAwsRegion(item.region)) throw new Error(`Kiro auth token file ${filePath} contains invalid AWS region`)
  return item as unknown as KiroAuthTokenFile
}

async function saveConnectedKiroAuth(authFile: string, auth: KiroAuthTokenFile) {
  const file = await readKiroAuthFileData(authFile).catch(() => ({ activeAccount: undefined, accounts: [] }))
  const entries = kiroAuthEntries(file)
  const index = entries.findIndex((entry, itemIndex) => kiroAuthEntryAliases(entry, itemIndex).some((alias) => kiroAuthEntryAliases(auth, itemIndex).includes(alias)))
  const nextEntries = index >= 0 ? entries.map((entry, itemIndex) => itemIndex === index ? { ...entry, ...auth } : entry) : [...entries, auth]
  const accountIndex = index >= 0 ? index : nextEntries.length - 1
  const accountKey = kiroAccountKey(nextEntries[accountIndex], accountIndex)

  const data = managedKiroAuthFile(file, accountKey, nextEntries)

  await writeKiroManagedAuthFile(authFile, data)

  return { accountKey, data }
}

function connectedKiroAuthEntry(draft: ConnectKiroAccountDraft): KiroAuthTokenFile {
  const accessToken = cleanToken(draft.accessToken)
  const refreshToken = cleanToken(draft.refreshToken)
  const region = cleanToken(draft.region)
  const label = cleanText(draft.label)
  const profileArn = cleanText(draft.profileArn)

  if (!accessToken) throw new Error("accessToken is required")
  if (!refreshToken) throw new Error("refreshToken is required")
  if (!region) throw new Error("region is required")
  if (!isAwsRegion(region)) throw new Error("region must be a valid AWS region")

  return {
    ...(label ? { label } : {}),
    accessToken,
    refreshToken,
    expiresAt: new Date(0).toISOString(),
    region,
    ...(profileArn ? { profileArn } : {}),
  }
}

async function writeKiroManagedAuthFile(authFile: string, data: { activeAccount?: string; accounts: KiroAuthTokenFile[] }) {
  await writeKiroAuthFile(authFile, data)
}

async function writeKiroAuthFile(authFile: string, data: KiroAuthFileData) {
  if (isProviderStatePath(authFile)) {
    const activeAccount = !Array.isArray(data) && isKiroManagedAuthFile(data) ? data.activeAccount : undefined
    await updateProviderSection("kiro", authFile, async (section) => ({
      ...(section ?? {}),
      data,
      activeAccount: activeAccount ?? section?.activeAccount,
    }))
    return
  }

  await writeTextFile(authFile, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  await setFileMode(authFile, 0o600).catch(() => {})
}

async function readKiroAuthFileSelectionAtIndex(filePath: string, index: number) {
  const selection = await readKiroAuthFileSelection(filePath)
  const entries = kiroAuthEntries(selection.data)
  const credentials = entries[index]
  if (!credentials) throw new Error(`Kiro auth token file ${filePath} does not contain account index ${index}`)
  return {
    ...selection,
    credentials,
    index,
    key: kiroAccountKey(credentials, index),
  }
}

async function readKiroSourceAuthSelection(filePath: string, credentials: KiroAuthTokenFile) {
  if (credentials.sourceAccountKey) {
    const selected = await readKiroAuthFileSelection(filePath, credentials.sourceAccountKey).catch(() => undefined)
    if (selected) return selected
  }
  const fallback = await readKiroAuthFileSelectionAtIndex(filePath, credentials.sourceAccountIndex ?? 0)
  if (!credentials.sourceAccountKey || kiroSourceLooksLikeSameAccount(credentials, fallback.credentials)) return fallback
}

function stripSourceMetadata(credentials: KiroAuthTokenFile): KiroAuthTokenFile {
  const {
    sourceAuthFile: _sourceAuthFile,
    sourceAccountIndex: _sourceAccountIndex,
    sourceAccountKey: _sourceAccountKey,
    ...sourceCredentials
  } = credentials
  return sourceCredentials
}

function sourceManagedCredentials(current: KiroAuthTokenFile, source: KiroAuthTokenFile): KiroAuthTokenFile {
  const sourceCredentials = stripSourceMetadata(source)
  for (const field of SOURCE_PULL_OPTIONAL_FIELDS) {
    if (source[field] === undefined && current[field] !== undefined) sourceCredentials[field] = undefined
  }
  return sourceCredentials
}

function sourceWritableCredentials(credentials: KiroAuthTokenFile): KiroAuthTokenFile {
  const sourceCredentials: KiroAuthTokenFile = {
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
    region: credentials.region,
  }

  for (const field of SOURCE_WRITE_OPTIONAL_FIELDS) {
    sourceCredentials[field] = credentials[field]
  }

  return sourceCredentials
}

function sourceAuthChanged(current: KiroAuthTokenFile, source: KiroAuthTokenFile) {
  return sourceSyncFields(current, source).some((field) => current[field] !== source[field])
}

function kiroSourceLooksLikeSameAccount(current: KiroAuthTokenFile, source: KiroAuthTokenFile) {
  return current.accessToken === source.accessToken
    || current.refreshToken === source.refreshToken
    || (current.accountId !== undefined && current.accountId === source.accountId)
    || (current.email !== undefined && current.email === source.email)
    || (current.clientIdHash !== undefined && current.clientIdHash === source.clientIdHash)
}

function sourceSyncFields(current: KiroAuthTokenFile, source: KiroAuthTokenFile): Array<keyof KiroAuthTokenFile> {
  const required: Array<keyof KiroAuthTokenFile> = ["accessToken", "refreshToken", "expiresAt", "region"]
  return [
    ...required,
    ...SOURCE_PULL_OPTIONAL_FIELDS.filter((field) => current[field] !== undefined || source[field] !== undefined),
  ]
}

function managedKiroAuthFile(data: KiroAuthFileData, activeAccount: string, accounts: KiroAuthTokenFile[]) {
  return {
    ...(isKiroManagedAuthFile(data) ? data : {}),
    activeAccount,
    accounts,
  }
}

function preserveKiroActiveAccount(activeAccount: string | undefined, selection: KiroAuthFileSelection, credentials: KiroAuthTokenFile) {
  if (!activeAccount) return activeAccount
  const previousKey = kiroAccountKey(selection.credentials, selection.index)
  if (activeAccount !== previousKey) return activeAccount
  return kiroAccountKey(credentials, selection.index)
}

function normalizeKiroAuthFileData(value: unknown, filePath: string): NormalizedKiroAuthFileData {
  if (Array.isArray(value)) {
    const accounts = value.map((entry) => validateKiroAuthToken(entry, filePath))
    return { data: accounts, accounts, format: "array" }
  }

  if (isKiroManagedAuthFile(value)) {
    const accounts = value.accounts.map((entry) => validateKiroAuthToken(entry, filePath))
    return { data: { ...value, accounts }, accounts, format: "managed" }
  }

  const credentials = validateKiroAuthToken(value, filePath)
  return { data: credentials, accounts: [credentials], format: "single" }
}

function isKiroManagedAuthFile(value: unknown): value is { activeAccount?: string; accounts: KiroAuthTokenFile[]; [key: string]: unknown } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { accounts?: unknown }).accounts))
}

function kiroAuthEntryAliases(auth: KiroAuthTokenFile, index: number) {
  return [
    kiroAccountKey(auth, index),
    firstString(auth.accountId),
    firstString(auth.profileArn),
    firstString(auth.email),
    firstString(auth.label),
    firstString(auth.name),
    firstString(auth.clientIdHash),
    `${auth.region}:account-${index + 1}`,
  ].filter((value): value is string => Boolean(value))
}

function cleanToken(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, "")
}

function cleanText(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "")
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)
}

function isAwsRegion(value: unknown): value is string {
  return typeof value === "string" && /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(value)
}
