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
  kiroAccount?: string
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

export interface KiroToolSpecification {
  toolSpecification: {
    name: string
    description: string
    inputSchema: {
      json: Record<string, unknown>
    }
  }
}

export interface KiroToolResult {
  content: Array<{ text: string }>
  status: "success" | "error"
  toolUseId: string
}

export interface KiroToolUse {
  name: string
  input: Record<string, unknown>
  toolUseId: string
}

export interface KiroImage {
  format: string
  source: {
    bytes: string
  }
}

export interface KiroUserInputMessage {
  content: unknown
  modelId: string
  origin: "AI_EDITOR"
  images?: KiroImage[]
  userInputMessageContext?: {
    tools?: KiroToolSpecification[]
    toolResults?: KiroToolResult[]
  }
}

export interface KiroAssistantResponseMessage {
  content: string
  toolUses?: KiroToolUse[]
}

export interface KiroConversationHistoryEntry {
  userInputMessage?: KiroUserInputMessage
  assistantResponseMessage?: KiroAssistantResponseMessage
}

export interface KiroMessageInput {
  content?: unknown
  currentMessage?: KiroUserInputMessage
  modelId: string
  history?: KiroConversationHistoryEntry[] | unknown[]
  conversationId?: string
}

export interface KiroGenerateAssistantResponsePayload {
  conversationState: {
    chatTriggerType: "MANUAL"
    conversationId: string
    currentMessage: {
      userInputMessage: KiroUserInputMessage
    }
    history?: KiroConversationHistoryEntry[] | unknown[]
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
