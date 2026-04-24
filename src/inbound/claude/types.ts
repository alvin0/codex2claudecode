import type { JsonObject } from "../../core/types"

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
