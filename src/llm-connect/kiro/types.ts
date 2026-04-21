export type KiroAuthType = "kiro_desktop" | "aws_sso_oidc"

export type KiroCredentialSource = "json" | "inline"

export interface KiroCredentialSnapshot {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  profileArn?: string
  clientId?: string
  clientSecret?: string
  clientIdHash?: string
  ssoRegion?: string
  detectedApiRegion?: string
  source?: KiroCredentialSource
}

export interface KiroEndpointSet {
  refreshUrl: string
  apiHost: string
  qHost: string
}

export interface KiroCredentialLoadOptions {
  credsFile?: string
  refreshToken?: string
  accessToken?: string
  expiresAt?: number
  profileArn?: string
  clientId?: string
  clientSecret?: string
  clientIdHash?: string
  region?: string
}

export interface KiroAuthManagerOptions extends KiroCredentialLoadOptions {
  apiRegionOverride?: string
  refreshThresholdSeconds?: number
  fetch?: typeof fetch
  userAgent?: string
  fingerprint?: string
}

export interface KiroTokenState {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  profileArn?: string
  authType: KiroAuthType
}

export interface KiroTokenResponseDesktop {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  profileArn?: string
}

export interface KiroTokenResponseOidc {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  tokenType?: string
}

export interface KiroRequestHeaderOptions {
  agentMode?: string
  codewhispererOptout?: boolean
}

export interface KiroMessageInput {
  content: unknown
  modelId: string
  history?: unknown[]
  conversationId?: string
}

export interface KiroGenerateAssistantResponsePayload {
  conversationState: {
    chatTriggerType: "MANUAL"
    conversationId: string
    currentMessage: {
      userInputMessage: {
        content: unknown
        modelId: string
        origin: "AI_EDITOR"
      }
    }
    history?: unknown[]
  }
  profileArn?: string
}

export interface KiroGenerateAssistantResponseOptions extends KiroMessageInput {
  stream?: boolean
}

export interface KiroClientOptions extends KiroAuthManagerOptions {
  authManager?: KiroAuthManagerLike
  fetch?: typeof fetch
  userAgent?: string
  agentMode?: string
  codewhispererOptout?: boolean
}

export interface KiroListModelsResult extends Record<string, unknown> {}

export interface KiroAuthManagerLike {
  readonly authType: KiroAuthType
  readonly profileArn?: string
  readonly apiHost: string
  readonly qHost: string
  readonly tokens: KiroTokenState
  getAccessToken(forceRefresh?: boolean): Promise<string>
  refresh(): Promise<KiroTokenState>
  forceRefresh(): Promise<KiroTokenState>
}
