import type { JsonObject } from "../../../types"
import type { KiroConversationHistoryEntry, KiroUserInputMessage } from "../types"

export type KiroGatewayRole = "user" | "assistant"

export type KiroGatewayBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64" | "url"; media_type?: string; data?: string; url?: string } }
  | { type: "tool_use"; id: string; name: string; input: JsonObject }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: "thinking"; thinking: string }

export interface KiroGatewayTool {
  type: "function" | "web_search" | "web_fetch" | "mcp"
  name: string
  description?: string
  input_schema?: JsonObject
  allowed_domains?: string[]
  blocked_domains?: string[]
  user_location?: JsonObject
  server?: string
}

export interface KiroThinkingConfig {
  enabled: boolean
  budgetTokens?: number
}

export interface KiroGatewayMessage {
  role: KiroGatewayRole
  content: KiroGatewayBlock[]
}

export interface KiroGatewayInput {
  modelId: string
  stream: boolean
  conversationId?: string
  currentMessage: KiroUserInputMessage
  history?: KiroConversationHistoryEntry[]
  system?: string
  tools?: KiroGatewayTool[]
  toolChoice?: string | JsonObject
  thinking?: KiroThinkingConfig
}

export type KiroParsedEvent =
  | { type: "content"; content: string }
  | { type: "thinking"; thinking: string; isFirst?: boolean; isLast?: boolean }
  | { type: "tool_use"; toolUse: { id: string; name: string; input: JsonObject } }
  | { type: "usage"; usage: Record<string, unknown> }
  | { type: "context_usage"; contextUsagePercentage: number }
  | {
      type: "web_search"
      toolUseId: string
      query: string
      results: Array<{ url: string; title: string; encrypted_content?: string; text?: string }>
      summary?: string
    }

export interface KiroCollectedResponse {
  content: string
  thinking?: string
  toolUses?: Array<{ id: string; name: string; input: JsonObject }>
  webSearches?: Array<{ toolUseId: string; query: string; results: Array<{ url: string; title: string; encrypted_content?: string; text?: string }>; summary?: string }>
  usage?: Record<string, unknown>
  contextUsagePercentage?: number
  completed?: boolean
  events?: KiroParsedEvent[]
}
