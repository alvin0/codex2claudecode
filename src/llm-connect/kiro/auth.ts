import type {
  KiroAuthManagerOptions,
  KiroAuthType,
  KiroCredentialSnapshot,
  KiroEndpointSet,
  KiroTokenResponseDesktop,
  KiroTokenResponseOidc,
  KiroTokenState,
} from "./types"
import { DEFAULT_KIRO_REGION, loadKiroCredentials } from "./credentials"

const TOKEN_REFRESH_THRESHOLD_SECONDS = 600
const REFRESH_EXPIRY_BUFFER_SECONDS = 60
const DESKTOP_REFRESH_UA = "KiroIDE-0.7.45-bun"

const COMMON_KIRO_API_REGIONS = ["us-east-1", "eu-central-1"] as const

function kiroApiRegionOverride() {
  const bun = (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun
  return bun?.env?.KIRO_API_REGION
}

export class KiroAuthManager {
  private accessToken?: string
  private refreshToken?: string
  private expiresAt?: number
  private profileArnInternal?: string
  private clientId?: string
  private clientSecret?: string
  private readonly region: string
  private readonly fetchFn: typeof fetch
  private readonly refreshThresholdSeconds: number
  private readonly userAgent: string
  private readonly fingerprint: string
  private readonly endpointSet: KiroEndpointSet
  private readonly detectedApiRegion?: string
  private readonly ssoRegion?: string
  private readonly candidateApiHostsInternal: string[]
  private refreshPromise?: Promise<KiroTokenState>

  readonly authType: KiroAuthType

  private constructor(options: KiroAuthManagerOptions, snapshot: KiroCredentialSnapshot) {
    this.accessToken = snapshot.accessToken
    this.refreshToken = snapshot.refreshToken
    this.expiresAt = snapshot.expiresAt
    this.profileArnInternal = snapshot.profileArn
    this.clientId = snapshot.clientId
    this.clientSecret = snapshot.clientSecret
    this.detectedApiRegion = snapshot.detectedApiRegion
    this.ssoRegion = snapshot.ssoRegion
    this.region = options.region ?? snapshot.ssoRegion ?? DEFAULT_KIRO_REGION
    this.fetchFn = options.fetch ?? fetch
    this.refreshThresholdSeconds = options.refreshThresholdSeconds ?? TOKEN_REFRESH_THRESHOLD_SECONDS
    this.userAgent = options.userAgent ?? DESKTOP_REFRESH_UA
    this.fingerprint = options.fingerprint ?? "bun"
    this.authType = this.clientId && this.clientSecret ? "aws_sso_oidc" : "kiro_desktop"
    this.candidateApiHostsInternal = buildCandidateApiHosts({
      defaultRegion: this.region,
      ssoRegion: this.ssoRegion,
      detectedApiRegion: this.detectedApiRegion,
      apiRegionOverride: options.apiRegionOverride ?? kiroApiRegionOverride(),
    })
    this.endpointSet = resolveEndpoints({
      defaultRegion: this.region,
      ssoRegion: this.ssoRegion,
      detectedApiRegion: this.detectedApiRegion,
      apiRegionOverride: options.apiRegionOverride ?? kiroApiRegionOverride(),
      authType: this.authType,
    })
  }

  static async fromSources(options: KiroAuthManagerOptions = {}) {
    const { snapshot } = await loadKiroCredentials(options)
    return new KiroAuthManager(options, snapshot)
  }

  get apiHost() {
    return this.endpointSet.apiHost
  }

  get qHost() {
    return this.endpointSet.qHost
  }

  get refreshUrl() {
    return this.endpointSet.refreshUrl
  }

  get profileArn() {
    return this.profileArnInternal
  }

  get candidateApiHosts() {
    return [...this.candidateApiHostsInternal]
  }

  get tokens(): KiroTokenState {
    return {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
      profileArn: this.profileArnInternal,
      authType: this.authType,
    }
  }

  async getAccessToken(forceRefresh = false) {
    if (!forceRefresh) {
      if (!this.accessToken) await this.refresh()
      else await this.refreshIfExpiringSoon()
    } else {
      await this.refresh()
    }
    if (!this.accessToken) throw new Error("Kiro access token is not available")
    return this.accessToken
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.refreshInternal().finally(() => {
      this.refreshPromise = undefined
    })
    return this.refreshPromise
  }

  async forceRefresh() {
    return this.refresh()
  }

  private async refreshIfExpiringSoon() {
    if (!this.expiresAt) return
    if (this.expiresAt - this.refreshThresholdSeconds * 1000 > Date.now()) return
    await this.refresh()
  }

  private async refreshInternal() {
    if (this.authType === "aws_sso_oidc") await this.refreshAwsSsoOidc()
    else await this.refreshKiroDesktop()
    return this.tokens
  }

  private async refreshKiroDesktop() {
    if (!this.refreshToken) throw new Error("Refresh token is not set")
    const response = await this.fetchFn(this.refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
      },
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    })
    if (!response.ok) throw new Error(`Kiro desktop token refresh failed: ${response.status} ${await response.text()}`)
    const data = (await response.json()) as KiroTokenResponseDesktop
    if (!data.accessToken) throw new Error("Kiro desktop refresh response is missing accessToken")
    this.accessToken = data.accessToken
    if (data.refreshToken) this.refreshToken = data.refreshToken
    if (data.profileArn) this.profileArnInternal = data.profileArn
    this.expiresAt = expiresAtFromNow(data.expiresIn)
  }

  private async refreshAwsSsoOidc() {
    if (!this.refreshToken) throw new Error("Refresh token is not set")
    if (!this.clientId) throw new Error("Client ID is not set")
    if (!this.clientSecret) throw new Error("Client secret is not set")
    const response = await this.fetchFn(this.refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grantType: "refresh_token",
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: this.refreshToken,
      }),
    })
    if (!response.ok) throw new Error(`AWS SSO OIDC token refresh failed: ${response.status} ${await response.text()}`)
    const data = (await response.json()) as KiroTokenResponseOidc
    if (!data.accessToken) throw new Error("AWS SSO OIDC refresh response is missing accessToken")
    this.accessToken = data.accessToken
    if (data.refreshToken) this.refreshToken = data.refreshToken
    this.expiresAt = expiresAtFromNow(data.expiresIn)
  }

  get fingerprintValue() {
    return this.fingerprint
  }
}

function resolveEndpoints(options: {
  defaultRegion: string
  ssoRegion?: string
  detectedApiRegion?: string
  apiRegionOverride?: string
  authType: KiroAuthType
}): KiroEndpointSet {
  const [apiHost] = buildCandidateApiHosts(options)
  const refreshRegion = options.ssoRegion ?? options.defaultRegion
  return {
    refreshUrl: resolveKiroRefreshUrl(refreshRegion, options.authType),
    apiHost,
    qHost: apiHost,
  }
}

function buildCandidateApiHosts(options: {
  defaultRegion: string
  ssoRegion?: string
  detectedApiRegion?: string
  apiRegionOverride?: string
}) {
  const orderedRegions = [
    options.apiRegionOverride,
    options.detectedApiRegion,
    ...COMMON_KIRO_API_REGIONS,
    options.ssoRegion,
    options.defaultRegion,
  ].filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index)

  return orderedRegions.map((region) => `https://q.${region}.amazonaws.com`)
}

function expiresAtFromNow(expiresIn = 3600) {
  return Date.now() + Math.max(expiresIn - REFRESH_EXPIRY_BUFFER_SECONDS, 0) * 1000
}

export function resolveAuthType(snapshot: Pick<KiroCredentialSnapshot, "clientId" | "clientSecret">): KiroAuthType {
  return snapshot.clientId && snapshot.clientSecret ? "aws_sso_oidc" : "kiro_desktop"
}

export function resolveKiroRefreshUrl(region: string, authType: KiroAuthType) {
  return authType === "aws_sso_oidc"
    ? `https://oidc.${region}.amazonaws.com/token`
    : `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`
}
