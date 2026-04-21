export type JsonObject = Record<string, unknown>

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
}

export interface TokenResponse {
  id_token?: string
  access_token: string
  refresh_token: string
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

export interface RequestOptions {
  headers?: HeadersInit
  signal?: AbortSignal
}

export interface RuntimeOptions {
  authFile?: string
  authAccount?: string
  hostname?: string
  port?: number
  healthIntervalMs?: number
  healthTimeoutMs?: number
  logBody?: boolean
  quiet?: boolean
  onRequestLog?: (entry: RequestLogEntry) => void
}

export interface RequestProxyLog {
  label: string
  method: string
  target: string
  status: number
  durationMs: number
  error: string
  requestBody?: string
}

export interface RequestLogEntry {
  id: string
  at: string
  method: string
  path: string
  status: number
  durationMs: number
  error: string
  requestHeaders: Record<string, string>
  requestBody?: string
  proxy?: RequestProxyLog
}

export interface HealthStatus {
  ok: boolean
  checkedAt?: string
  latencyMs?: number
  status?: number
  error?: string
}

export interface ResponsesRequest extends JsonObject {
  model: string
  input: unknown
  stream?: boolean
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

export interface ClaudeMessagesRequest extends JsonObject {
  model: string
  max_tokens?: number
  messages: Array<{
    role: "user" | "assistant"
    content: unknown
  }>
  system?: unknown
  stream?: boolean
  temperature?: number
  top_p?: number
  output_config?: {
    effort?: "none" | "low" | "medium" | "high" | "xhigh" | string
    format?: {
      type?: "json_schema" | string
      name?: string
      schema?: JsonObject
      strict?: boolean
    }
  }
  stop_sequences?: string[]
  tools?: Array<{
    name: string
    type?: string
    strict?: boolean
    description?: string
    input_schema?: JsonObject
    max_uses?: number
    allowed_domains?: string[]
    blocked_domains?: string[]
    user_location?: JsonObject
    citations?: JsonObject
    max_content_tokens?: number
  }>
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string }
}

export interface SseEvent {
  event?: string
  data: string
}
