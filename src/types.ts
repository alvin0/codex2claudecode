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
  codexAuthFile?: string
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

export interface RequestOptions {
  headers?: HeadersInit
  signal?: AbortSignal
}

export interface RuntimeOptions {
  authFile?: string
  authAccount?: string
  kiroAccount?: string
  hostname?: string
  port?: number
  provider?: "codex" | "kiro"
  healthIntervalMs?: number
  healthTimeoutMs?: number
  logBody?: boolean
  quiet?: boolean
  onRequestLogStart?: (entry: RequestLogEntry) => void
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
  responseBody?: string
}

export interface RequestLogEntry {
  id: string
  state?: "pending" | "complete"
  at: string
  method: string
  path: string
  status: number
  durationMs: number
  error: string
  requestHeaders: Record<string, string>
  requestBody?: string
  responseBody?: string
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

export interface ClaudeMcpServer extends JsonObject {
  name: string
  url: string
  type?: "url" | string
  authorization_token?: string
  tool_configuration?: JsonObject
  connector_id?: string
  headers?: JsonObject
}

export interface ClaudeFunctionTool extends JsonObject {
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
}

export interface ClaudeMcpToolset extends JsonObject {
  name?: string
  type: "mcp_toolset"
  mcp_server_name: string
  allowed_tools?: string[]
  tool_names?: string[]
  require_approval?: "always" | "never" | JsonObject | string
  disable_parallel_tool_use?: boolean
}

export type ClaudeTool = ClaudeFunctionTool | ClaudeMcpToolset

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
  metadata?: JsonObject
  mcp_servers?: ClaudeMcpServer[]
  tools?: ClaudeTool[]
  tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string; disable_parallel_tool_use?: boolean }
  thinking?: { type: "enabled" | "disabled" | "adaptive"; budget_tokens?: number } | JsonObject
}

export interface SseEvent {
  event?: string
  data: string
}
