export type KiroAuthType = "kiro_desktop" | "aws_sso_oidc"

export interface KiroAuthTokenFile {
  accessToken: string
  refreshToken: string
  expiresAt: string
  region: string
  accountId?: string
  label?: string
  name?: string
  email?: string
  sourceAuthFile?: string
  sourceAccountIndex?: number
  sourceAccountKey?: string
  clientIdHash?: string
  clientId?: string
  clientSecret?: string
  profileArn?: string
  [key: string]: unknown
}

export interface KiroManagedAuthFile {
  activeAccount?: string
  accounts: KiroAuthTokenFile[]
  [key: string]: unknown
}

export type KiroAuthFileData = KiroAuthTokenFile | KiroAuthTokenFile[] | KiroManagedAuthFile

export interface KiroDeviceRegistrationFile {
  clientId: string
  clientSecret: string
}

export interface KiroRefreshResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  profileArn?: string
}

export interface SsoOidcRefreshResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export interface KiroConversationState {
  conversationId: string
  currentMessage: KiroCurrentMessage
  chatTriggerType: "MANUAL"
  history?: KiroHistoryEntry[]
}

export interface KiroCurrentMessage {
  userInputMessage: KiroUserInputMessage
}

export interface KiroUserInputMessage {
  content: string
  modelId: string
  origin: "AI_EDITOR"
  userInputMessageContext?: KiroUserInputMessageContext
  images?: KiroImage[]
}

export interface KiroUserInputMessageContext {
  toolResults?: KiroToolResult[]
  tools?: KiroToolSpecification[]
}

export interface KiroAssistantResponseMessage {
  content: string
  toolUses?: KiroToolUse[]
}

export type KiroHistoryEntry =
  | { userInputMessage: KiroUserInputMessage }
  | { assistantResponseMessage: KiroAssistantResponseMessage }

export interface KiroToolSpecification {
  toolSpecification: {
    name: string
    description: string
    inputSchema: { json: Record<string, unknown> }
  }
}

export interface KiroToolUse {
  toolUseId: string
  name: string
  input: Record<string, unknown>
}

export interface KiroToolResult {
  toolUseId: string
  content: Array<{ text: string }>
  status: "success"
}

export interface KiroImage {
  format: string
  source: { bytes: string }
}

export interface KiroGeneratePayload {
  conversationState: KiroConversationState
  profileArn?: string
}

export interface KiroContentEvent {
  content: string
  followupPrompt?: string
}

export interface KiroToolStartEvent {
  name: string
  toolUseId: string
  input: string | Record<string, unknown>
  stop?: boolean
}

export interface KiroToolInputEvent {
  input: string | Record<string, unknown>
}

export interface KiroToolStopEvent {
  stop: boolean
}

export interface KiroUsageEvent {
  usage: number | Record<string, unknown>
}

export interface KiroContextUsageEvent {
  contextUsagePercentage: number
}

export type KiroParsedEvent =
  | KiroContentEvent
  | KiroToolStartEvent
  | KiroToolInputEvent
  | KiroToolStopEvent
  | KiroUsageEvent
  | KiroContextUsageEvent

export interface KiroToolCall {
  callId: string
  name: string
  arguments: string
}

export class ToolNameTooLongError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolNameTooLongError"
  }
}

export class PayloadTooLargeError extends Error {
  readonly status: number

  constructor(message: string, options: { status?: number } = {}) {
    super(message)
    this.name = "PayloadTooLargeError"
    this.status = options.status ?? 413
  }
}

export class KiroHttpError extends Error {
  readonly status: number
  readonly headers: Headers
  readonly body: string

  constructor(status: number, headers: Headers, body: string) {
    super(`Kiro API error: ${status}`)
    this.name = "KiroHttpError"
    this.status = status
    this.headers = headers
    this.body = body
  }
}

export class KiroNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KiroNetworkError"
  }
}

export class KiroMcpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KiroMcpError"
  }
}
