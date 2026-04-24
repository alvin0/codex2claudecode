import type { JsonObject } from "../../core/types"

export interface CodexClientOptions {
  accessToken: string
  refreshToken: string
  expiresAt?: number
  accountId?: string
  clientId?: string
  issuer?: string
  codexEndpoint?: string
  originator?: string
  userAgent?: string
  fetch?: typeof fetch
  authFile?: string
  authAccount?: string
  codexAuthFile?: string
  openAiApiKey?: string
}

export interface TokenResponse {
  id_token?: string
  access_token: string
  refresh_token?: string
  expires_in?: number
}

export interface CodexClientTokens {
  accessToken: string
  refreshToken: string
  expiresAt?: number
  accountId?: string
}

export interface AuthFileContent {
  type: "oauth"
  access: string
  refresh: string
  expires?: number
  accountId?: string
  name?: string
  label?: string
  email?: string
}

export type AuthFileData = AuthFileContent | AuthFileContent[]

export interface ResponsesRequest extends JsonObject {
  model: string
  input: unknown
  stream?: boolean
}

export interface InputTokensRequest extends JsonObject {
  model: string
  input?: unknown
}

export interface ChatCompletionRequest extends JsonObject {
  model: string
  messages: Array<{
    role: "system" | "developer" | "user" | "assistant" | "tool"
    content: unknown
    name?: string
    tool_call_id?: string
  }>
  stream?: boolean
}
