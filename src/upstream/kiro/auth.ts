import { readTextFile, setFileMode, writeTextFile } from "../../core/bun-fs"
import { expandHome } from "../../core/paths"
import { bunPath as path, homeDir } from "../../core/paths"
import { KIRO_AUTH_TOKEN_PATH, KIRO_DESKTOP_REFRESH_TEMPLATE, SSO_OIDC_ENDPOINT_TEMPLATE, TOKEN_REFRESH_THRESHOLD_SECONDS } from "./constants"
import { kiroAccountKey, pullKiroSourceAuth, readKiroAuthFileSelection, syncKiroSourceAuth, updateKiroAuthSelection, type KiroAuthFileSelection } from "./account-store"
import type { KiroAuthTokenFile, KiroAuthType, KiroDeviceRegistrationFile, KiroRefreshResponse, SsoOidcRefreshResponse } from "./types"

export interface KiroAuthManagerOptions {
  fetch?: typeof fetch
  fingerprint?: string
  kiroVersion?: string
  authAccount?: string
}

interface KiroAuthManagerInternalOptions extends KiroAuthManagerOptions {
  selection?: KiroAuthFileSelection
}

export class Kiro_Auth_Manager {
  private accessToken: string
  private refreshToken: string
  private expiresAt: string
  private readonly region: string
  private profileArn?: string
  private clientId?: string
  private clientSecret?: string
  private authType: KiroAuthType
  private refreshPromise?: Promise<void>
  private readonly authFilePath: string
  private originalCredentials: KiroAuthTokenFile
  private readonly fetchFn: typeof fetch
  private readonly fingerprint: string
  private readonly kiroVersion: string
  private readonly selection?: KiroAuthFileSelection

  constructor(credentials: KiroAuthTokenFile, authFilePath: string, options: KiroAuthManagerInternalOptions = {}) {
    this.accessToken = credentials.accessToken
    this.refreshToken = credentials.refreshToken
    this.expiresAt = credentials.expiresAt
    this.region = credentials.region
    this.profileArn = credentials.profileArn
    this.clientId = credentials.clientId
    this.clientSecret = credentials.clientSecret
    this.authType = this.clientId && this.clientSecret ? "aws_sso_oidc" : "kiro_desktop"
    this.authFilePath = authFilePath
    this.originalCredentials = { ...credentials }
    this.fetchFn = options.fetch ?? fetch
    this.fingerprint = options.fingerprint ?? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    this.kiroVersion = options.kiroVersion ?? "unknown"
    this.selection = options.selection
  }

  static async fromAuthFile(filePath = KIRO_AUTH_TOKEN_PATH, options: KiroAuthManagerOptions = {}) {
    const authFilePath = expandHome(filePath)
    const selection = await readKiroAuthFileSelection(authFilePath, options.authAccount)
    const credentials = selection.credentials
    const companion = credentials.clientIdHash ? await readDeviceRegistrationFile(path.join(homeDir(), ".aws", "sso", "cache", `${credentials.clientIdHash}.json`)) : undefined
    const manager = new Kiro_Auth_Manager(credentials, authFilePath, { ...options, selection })
    manager.applyCompanionCredentials(companion)
    return manager
  }

  async getAccessToken() {
    if (this.isTokenExpiringSoon()) await this.refresh()
    return this.accessToken
  }

  isTokenExpiringSoon() {
    const time = Date.parse(this.expiresAt)
    if (Number.isNaN(time)) return true
    return Date.now() >= time - TOKEN_REFRESH_THRESHOLD_SECONDS * 1000
  }

  isTokenExpired() {
    const time = Date.parse(this.expiresAt)
    if (Number.isNaN(time)) return true
    return Date.now() >= time
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.currentCredentials().sourceAuthFile ? this.refreshWithSourceSync() : this.refreshUpstreamAndWriteBack()
    this.refreshPromise = this.refreshPromise.finally(() => {
      this.refreshPromise = undefined
    })
    return this.refreshPromise
  }

  getRegion() {
    return this.region
  }

  getProfileArn() {
    return this.profileArn
  }

  getAuthType() {
    return this.authType
  }

  private applyCompanionCredentials(companion?: KiroDeviceRegistrationFile) {
    if (this.clientId && this.clientSecret) return
    if (!companion) return
    this.clientId = companion.clientId
    this.clientSecret = companion.clientSecret
    this.authType = "aws_sso_oidc"
  }

  private async refreshDesktopAuth() {
    const response = await this.fetchFn(KIRO_DESKTOP_REFRESH_TEMPLATE.replace("{region}", this.region), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `KiroIDE-${this.kiroVersion}-${this.fingerprint}`,
      },
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    })
    if (!response.ok) throw new Error(`Kiro Desktop Auth refresh failed: ${response.status} ${await response.text()}`)
    const payload = (await response.json()) as KiroRefreshResponse
    this.applyRefreshResponse(payload)
    if (typeof payload.profileArn === "string") this.profileArn = payload.profileArn
  }

  private async refreshSsoOidc() {
    if (!this.clientId || !this.clientSecret) throw new Error("Kiro SSO OIDC refresh requested without client credentials")
    const response = await this.fetchFn(SSO_OIDC_ENDPOINT_TEMPLATE.replace("{region}", this.region), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grantType: "refresh_token",
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: this.refreshToken,
      }),
    })
    if (!response.ok) throw new Error(`Kiro SSO OIDC refresh failed: ${response.status} ${await response.text()}`)
    this.applyRefreshResponse((await response.json()) as SsoOidcRefreshResponse)
  }

  private applyRefreshResponse(payload: KiroRefreshResponse | SsoOidcRefreshResponse) {
    this.accessToken = payload.accessToken
    this.refreshToken = payload.refreshToken
    this.expiresAt = new Date(Date.now() + payload.expiresIn * 1000).toISOString()
  }

  private async refreshWithSourceSync() {
    const sourceChanged = await this.syncFromSourceBeforeRefresh()
    if (!(sourceChanged && !this.isTokenExpiringSoon())) await this.refreshUpstream()
    await this.writeBackCredentials({ syncSource: true })
  }

  private async refreshUpstreamAndWriteBack() {
    await this.refreshUpstream()
    await this.writeBackCredentials({ syncSource: true })
  }

  private refreshUpstream() {
    return this.authType === "aws_sso_oidc" ? this.refreshSsoOidc() : this.refreshDesktopAuth()
  }

  private async syncFromSourceBeforeRefresh() {
    const sourceCredentials = await pullKiroSourceAuth(this.authFilePath, this.currentCredentials())
    if (!sourceCredentials) return false

    this.applyCredentials(sourceCredentials)
    if (sourceCredentials.clientIdHash) {
      this.applyCompanionCredentials(await readDeviceRegistrationFile(path.join(homeDir(), ".aws", "sso", "cache", `${sourceCredentials.clientIdHash}.json`)))
    }
    await this.writeBackCredentials({ syncSource: false })
    return true
  }

  private applyCredentials(credentials: KiroAuthTokenFile) {
    this.originalCredentials = { ...credentials }
    this.accessToken = credentials.accessToken
    this.refreshToken = credentials.refreshToken
    this.expiresAt = credentials.expiresAt
    this.profileArn = credentials.profileArn
    this.clientId = credentials.clientId
    this.clientSecret = credentials.clientSecret
    this.authType = this.clientId && this.clientSecret ? "aws_sso_oidc" : "kiro_desktop"
  }

  private currentCredentials(): KiroAuthTokenFile {
    const credentials: KiroAuthTokenFile = {
      ...this.originalCredentials,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
      ...(this.profileArn !== undefined ? { profileArn: this.profileArn } : {}),
    }
    if (!credentials.sourceAuthFile) return credentials

    const sourceAccountIndex = credentials.sourceAccountIndex ?? 0
    return {
      ...credentials,
      sourceAccountIndex,
      sourceAccountKey: refreshedSourceAccountKey(credentials, sourceAccountIndex),
    }
  }

  private async writeBackCredentials(options: { syncSource?: boolean } = {}) {
    const next = this.currentCredentials()
    const payload = this.selection ? updateKiroAuthSelection(this.selection, next) : next
    if (options.syncSource) {
      await syncKiroSourceAuth(this.authFilePath, {
        ...next,
        sourceAccountKey: this.originalCredentials.sourceAccountKey ?? next.sourceAccountKey,
      })
    }
    await writeTextFile(this.authFilePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    await setFileMode(this.authFilePath, 0o600)
  }
}

function refreshedSourceAccountKey(credentials: KiroAuthTokenFile, sourceAccountIndex: number) {
  return firstString(credentials.accountId, credentials.profileArn, credentials.email, credentials.clientIdHash, credentials.sourceAccountKey)
    ?? kiroAccountKey(credentials, sourceAccountIndex)
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)
}

async function readDeviceRegistrationFile(filePath: string): Promise<KiroDeviceRegistrationFile | undefined> {
  let raw: string
  try {
    raw = await readTextFile(filePath)
  } catch (error) {
    console.warn(`Kiro device registration file ${filePath} is unavailable; SSO OIDC refresh will not be available: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  try {
    const parsed = JSON.parse(raw) as Partial<KiroDeviceRegistrationFile>
    if (typeof parsed.clientId === "string" && typeof parsed.clientSecret === "string") return { clientId: parsed.clientId, clientSecret: parsed.clientSecret }
    console.warn(`Kiro device registration file ${filePath} is missing clientId/clientSecret; falling back to Desktop Auth`)
  } catch (error) {
    console.warn(`Failed to parse Kiro device registration file ${filePath}; falling back to Desktop Auth: ${error instanceof Error ? error.message : String(error)}`)
  }
}
