import { readTextFile } from "../../core/bun-fs"
import { bunPath as path } from "../../core/paths"
import { expandHome, homeDir } from "../../core/paths"
import { COPILOT_API_VERSION, COPILOT_AUTH_FILE_NAME, COPILOT_CACHE_FILE_NAME, COPILOT_EDITOR_PLUGIN_VERSION, COPILOT_GITHUB_API_BASE_URL, COPILOT_GITHUB_APP_SCOPES, COPILOT_GITHUB_BASE_URL, COPILOT_GITHUB_CLIENT_ID, COPILOT_GITHUB_VERSION, COPILOT_TOKEN_REFRESH_MARGIN_SECONDS, COPILOT_USER_AGENT } from "./constants"
import { readCopilotTokenCache, writeCopilotTokenCache } from "./cache"
import type { CopilotAccountSnapshot, CopilotAuthFileData, CopilotAuthTokenFile, CopilotAuthType, CopilotUsageResponse } from "./types"
import { copilotAccountKey, readCopilotAuthFileSelection, selectCopilotAuthEntry, updateCopilotAuthSelection, writeCopilotAuthFile } from "./account-store"

export interface CopilotAuthManagerOptions {
  fetch?: typeof fetch
  fingerprint?: string
  copilotVersion?: string
  authAccount?: string
  accountType?: string
}

interface CopilotAuthManagerInternalOptions extends CopilotAuthManagerOptions {
  selection?: ReturnType<typeof selectCopilotAuthEntry>
}

export class Copilot_Auth_Manager {
  private githubToken: string
  private copilotToken: string
  private copilotTokenExpiresAt: string
  private readonly authFilePath: string
  private readonly fetchFn: typeof fetch
  private readonly fingerprint: string
  private readonly copilotVersion: string
  private readonly selection?: ReturnType<typeof selectCopilotAuthEntry>
  private accountType: string
  private accountId?: string
  private email?: string
  private plan?: string
  private authType: CopilotAuthType
  private refreshPromise?: Promise<void>
  private originalCredentials: CopilotAuthTokenFile

  constructor(credentials: CopilotAuthTokenFile, authFilePath: string, options: CopilotAuthManagerInternalOptions = {}) {
    this.githubToken = credentials.githubToken
    this.copilotToken = credentials.githubToken
    this.copilotTokenExpiresAt = credentials.copilotTokenExpiresAt ?? new Date(0).toISOString()
    this.authFilePath = authFilePath
    this.fetchFn = options.fetch ?? fetch
    this.fingerprint = options.fingerprint ?? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    this.copilotVersion = options.copilotVersion ?? COPILOT_GITHUB_VERSION
    this.selection = options.selection
    this.accountType = credentials.accountType ?? options.accountType ?? "individual"
    this.accountId = credentials.accountId
    this.email = credentials.email
    this.plan = credentials.plan
    this.authType = credentials.authType ?? "unknown"
    this.originalCredentials = { ...credentials }
    if (credentials.copilotToken) {
      this.copilotToken = credentials.copilotToken
      this.copilotTokenExpiresAt = credentials.copilotTokenExpiresAt ?? new Date(0).toISOString()
    }
  }

  static async fromAuthFile(filePath = defaultCopilotAuthFile(), options: CopilotAuthManagerOptions = {}) {
    const authFilePath = expandHome(filePath)
    const selection = await readCopilotAuthFileSelection(authFilePath, options.authAccount)
    const manager = new Copilot_Auth_Manager(selection.credentials, authFilePath, { ...options, selection })
    await manager.loadCachedState()
    return manager
  }

  async getAccessToken() {
    if (this.isTokenExpiringSoon()) await this.refresh()
    return this.copilotToken
  }

  getAuthType() {
    return this.authType
  }

  getAccountType() {
    return this.accountType
  }

  getEmail() {
    return this.email
  }

  getPlan() {
    return this.plan
  }

  getAccountId() {
    return this.accountId
  }

  getGitHubToken() {
    return this.githubToken
  }

  isTokenExpiringSoon() {
    const time = Date.parse(this.copilotTokenExpiresAt)
    if (Number.isNaN(time)) return true
    return Date.now() >= time - COPILOT_TOKEN_REFRESH_MARGIN_SECONDS * 1000
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.refreshWithGitHubToken().finally(() => {
      this.refreshPromise = undefined
    })
    return this.refreshPromise
  }

  async refreshAndPersist() {
    await this.refresh()
    await this.writeBackCredentials()
  }

  private async loadCachedState() {
    const accountKey = this.currentAccountKey()
    const cache = await readCopilotTokenCache(accountKey, cacheFilePath(this.authFilePath))
    if (cache?.copilotToken && cache?.expiresAt) {
      this.copilotToken = cache.copilotToken
      this.copilotTokenExpiresAt = cache.expiresAt
      this.accountType = cache.accountType || this.accountType
      return
    }
    await this.refresh()
    await this.writeBackCredentials()
  }

  private async refreshWithGitHubToken() {
    const snapshot = await fetchCopilotAccountSnapshot(this.githubToken, {
      fetch: this.fetchFn,
      accountType: this.accountType,
      authType: this.authType === "unknown" ? undefined : this.authType,
      fingerprint: this.fingerprint,
      copilotVersion: this.copilotVersion,
    })
    this.applySnapshot(snapshot)
    await this.persistCache(snapshot)
  }

  private applySnapshot(snapshot: CopilotAccountSnapshot) {
    this.copilotToken = snapshot.copilotToken
    this.copilotTokenExpiresAt = snapshot.copilotTokenExpiresAt
    this.accountType = snapshot.accountType
    this.authType = snapshot.authType
    this.accountId = snapshot.accountId ?? this.accountId
    this.email = snapshot.email ?? this.email
    this.plan = snapshot.plan ?? this.plan
  }

  private async persistCache(snapshot: CopilotAccountSnapshot) {
    await writeCopilotTokenCache(this.currentAccountKey(), {
      copilotToken: snapshot.copilotToken,
      expiresAt: snapshot.copilotTokenExpiresAt,
      accountType: snapshot.accountType,
    }, cacheFilePath(this.authFilePath))
  }

  private async writeBackCredentials() {
    const next = this.currentCredentials()
    const payload = this.selection ? updateCopilotAuthSelection(this.selection, next) : next
    await writeCopilotAuthFile(this.authFilePath, payload)
  }

  private currentCredentials(): CopilotAuthTokenFile {
    return {
      ...this.originalCredentials,
      githubToken: this.githubToken,
      accountType: this.accountType,
      ...(this.accountId !== undefined ? { accountId: this.accountId } : {}),
      ...(this.email !== undefined ? { email: this.email } : {}),
      ...(this.plan !== undefined ? { plan: this.plan } : {}),
      authType: this.authType,
      copilotToken: this.copilotToken,
      copilotTokenExpiresAt: this.copilotTokenExpiresAt,
    }
  }

  private currentAccountKey() {
    return copilotAccountKey(this.currentCredentials(), this.selection?.index ?? 0)
  }
}

export async function fetchCopilotAccountSnapshot(githubToken: string, options: CopilotAuthManagerOptions & { authType?: CopilotAuthType } = {}): Promise<CopilotAccountSnapshot> {
  const fetchFn = options.fetch ?? fetch
  const accountType = cleanAccountType(options.accountType) ?? "individual"
  const copilotToken = await getValidTempToken(githubToken, { fetch: fetchFn, fingerprint: options.fingerprint, copilotVersion: options.copilotVersion, accountType })
  const usage = await getCopilotUsage(githubToken, { fetch: fetchFn, copilotVersion: options.copilotVersion })
  return {
    copilotToken,
    copilotTokenExpiresAt: tokenExpiresAt(copilotToken),
    accountType,
    authType: options.authType ?? "github_token",
    email: usage.userInfo?.email,
    plan: usage.copilot_plan,
    accountId: usage.userInfo?.userId,
  }
}

export async function getCopilotUsage(githubToken: string, options: { fetch?: typeof fetch; copilotVersion?: string } = {}): Promise<CopilotUsageResponse> {
  const fetchFn = options.fetch ?? fetch
  const response = await fetchFn(`${COPILOT_GITHUB_API_BASE_URL}/copilot_internal/user`, {
    headers: githubHeaders(githubToken, options.copilotVersion),
  })
  if (!response.ok) throw new Error(`Failed to get Copilot usage: ${response.status} ${await response.text()}`)
  return await response.json() as CopilotUsageResponse
}

export interface CopilotDeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export type CopilotDeviceTokenResponse =
  | {
      access_token: string
      token_type: string
      scope: string
    }
  | {
      error: string
      error_description?: string
      error_uri?: string
      interval?: number
    }

export async function getCopilotDeviceCode(options: { fetch?: typeof fetch } = {}): Promise<CopilotDeviceCodeResponse> {
  const response = await (options.fetch ?? fetch)(`${COPILOT_GITHUB_BASE_URL}/login/device/code`, {
    method: "POST",
    headers: standardHeaders(),
    body: JSON.stringify({
      client_id: COPILOT_GITHUB_CLIENT_ID,
      scope: COPILOT_GITHUB_APP_SCOPES,
    }),
  })
  if (!response.ok) {
    const details = await response.text().catch(() => "")
    throw new Error(`Failed to get device code (status ${response.status})${details ? `: ${details}` : ""}`)
  }
  return await response.json() as CopilotDeviceCodeResponse
}

export async function pollCopilotDeviceToken(deviceCode: string, options: { fetch?: typeof fetch } = {}): Promise<CopilotDeviceTokenResponse> {
  const response = await (options.fetch ?? fetch)(`${COPILOT_GITHUB_BASE_URL}/login/oauth/access_token`, {
    method: "POST",
    headers: standardHeaders(),
    body: JSON.stringify({
      client_id: COPILOT_GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  })
  if (!response.ok) {
    const details = await response.text().catch(() => "")
    throw new Error(`Failed to exchange device code (status ${response.status})${details ? `: ${details}` : ""}`)
  }
  return await response.json() as CopilotDeviceTokenResponse
}

async function getValidTempToken(githubToken: string, options: { fetch?: typeof fetch; fingerprint?: string; copilotVersion?: string; accountType?: string }) {
  const response = await (options.fetch ?? fetch)(`${COPILOT_GITHUB_API_BASE_URL}/copilot_internal/v2/token`, {
    method: "GET",
    headers: githubHeaders(githubToken, options.copilotVersion, options.fingerprint, options.accountType),
  })
  if (!response.ok) throw new Error(`Unable to generate Copilot token: ${response.status} ${await response.text()}`)
  const json = await response.json() as { token?: string }
  if (!json.token) throw new Error("Unable to generate new short-lived Copilot token")
  return json.token
}

function githubHeaders(githubToken: string, copilotVersion = COPILOT_GITHUB_VERSION, fingerprint = crypto.randomUUID().replace(/-/g, "").slice(0, 12), accountType = "individual") {
  return {
    ...standardHeaders(),
    authorization: `token ${githubToken}`,
    "editor-version": `vscode/1.112.0`,
    "editor-plugin-version": COPILOT_EDITOR_PLUGIN_VERSION,
    "user-agent": COPILOT_USER_AGENT,
    "x-github-api-version": COPILOT_API_VERSION,
    "x-vscode-user-agent-library-version": "electron-fetch",
    "x-copilot-account-type": accountType,
    "x-request-id": crypto.randomUUID(),
    "x-copilot-version": copilotVersion,
    "x-copilot-fingerprint": fingerprint,
  }
}

function standardHeaders() {
  return {
    "content-type": "application/json",
    accept: "application/json",
  }
}

function cleanAccountType(value?: string) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function tokenExpiresAt(token: string) {
  const parts = token.split(";")
  for (const part of parts) {
    if (part.startsWith("exp=")) {
      const seconds = Number.parseInt(part.slice(4), 10)
      if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000).toISOString()
    }
  }
  return new Date(Date.now() + 15 * 60_000).toISOString()
}

function cacheFilePath(authFile: string) {
  return path.join(path.dirname(expandHome(authFile)), COPILOT_CACHE_FILE_NAME)
}

function defaultCopilotAuthFile() {
  return path.join(homeDir(), ".codex2claudecode", COPILOT_AUTH_FILE_NAME)
}
