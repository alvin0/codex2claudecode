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

export interface RequestLogEntry {
  id: string
  at: string
  method: string
  path: string
  status: number
  durationMs: number
  error: string
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

export interface OpenAIChatContentTextBlock {
  type: "text"
  text: string
}

export interface OpenAIChatImageUrlBlock {
  type: "image_url"
  image_url: {
    url: string
    detail?: string
  }
}

export interface OpenAIChatToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAIChatToolDefinition {
  type: "function" | "web_search"
  function?: {
    name: string
    description?: string
    parameters?: JsonObject
    strict?: boolean
  }
  allowed_domains?: string[]
  blocked_domains?: string[]
  user_location?: JsonObject
}

export interface ChatCompletionRequest extends JsonObject {
  model: string
  messages: Array<{
    role: "system" | "developer" | "user" | "assistant" | "tool"
    content: unknown
    name?: string
    tool_call_id?: string
    tool_calls?: OpenAIChatToolCall[]
  }>
  stream?: boolean
  tools?: OpenAIChatToolDefinition[]
  tool_choice?: "auto" | "none" | "required" | { type: "function" | "web_search"; function?: { name: string }; name?: string }
  reasoning_effort?: "none" | "low" | "medium" | "high" | "xhigh"
}

export interface ClaudeToolDefinition {
  name: string
  type?: string
  description?: string
  input_schema?: JsonObject
  max_uses?: number
  allowed_domains?: string[]
  blocked_domains?: string[]
  user_location?: JsonObject
  citations?: JsonObject
  max_content_tokens?: number
}

export interface ClaudeThinkingConfig {
  type?: "enabled"
  budget_tokens?: number
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
  stop_sequences?: string[]
  tools?: ClaudeToolDefinition[]
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string }
  thinking?: ClaudeThinkingConfig
}

export interface SseEvent {
  event?: string
  data: string
}
