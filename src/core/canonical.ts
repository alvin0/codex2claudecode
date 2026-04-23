import type { JsonObject } from "./types"

export interface Canonical_Request {
  model: string
  instructions?: string
  input: Canonical_InputMessage[]
  tools?: JsonObject[]
  toolChoice?: JsonObject | string
  include?: string[]
  textFormat?: JsonObject
  reasoningEffort?: string
  stream: boolean
  passthrough: boolean
  metadata: Record<string, unknown>
}

export interface Canonical_InputMessage {
  role: "user" | "assistant" | "tool"
  content: JsonObject[]
}

export interface Canonical_Response {
  type: "canonical_response"
  id: string
  model: string
  stopReason: string
  content: Canonical_ContentBlock[]
  usage: Canonical_Usage
}

export type Canonical_ContentBlock =
  | Canonical_TextBlock
  | Canonical_ToolCallBlock
  | Canonical_ServerToolBlock
  | Canonical_ThinkingBlock

export interface Canonical_TextBlock {
  type: "text"
  text: string
  annotations?: JsonObject[]
}

export interface Canonical_ToolCallBlock {
  type: "tool_call"
  id: string
  callId: string
  name: string
  arguments: string
}

export interface Canonical_ServerToolBlock {
  type: "server_tool"
  blocks: JsonObject[]
}

export interface Canonical_ThinkingBlock {
  type: "thinking"
  thinking: string
  signature: string
}

export interface Canonical_Usage {
  inputTokens: number
  outputTokens: number
  serverToolUse?: {
    webSearchRequests?: number
    webFetchRequests?: number
    mcpCalls?: number
  }
}

export interface Canonical_StreamResponse {
  type: "canonical_stream"
  status: number
  id: string
  model: string
  events: AsyncIterable<Canonical_Event>
}

export type Canonical_Event =
  | { type: "text_delta"; delta: string }
  | { type: "text_done"; text: string }
  | { type: "tool_call_delta"; callId: string; name: string; argumentsDelta: string }
  | { type: "tool_call_done"; callId: string; name: string; arguments: string }
  | { type: "server_tool_block"; blocks: JsonObject[] }
  | { type: "thinking_delta"; label?: string; text?: string }
  | { type: "thinking_signature"; signature: string }
  | { type: "usage"; usage: Partial<Canonical_Usage> }
  | { type: "content_block_start"; blockType: string; index: number; block?: JsonObject }
  | { type: "content_block_stop"; index: number }
  | { type: "message_start"; id: string; model: string }
  | { type: "message_stop"; stopReason: string }
  | { type: "error"; message: string }
  | { type: "completion"; output?: unknown; usage?: Canonical_Usage; stopReason?: string; incompleteReason?: string }
  | { type: "lifecycle"; label: string }
  | { type: "message_item_done"; item: JsonObject }

export interface Canonical_ErrorResponse {
  type: "canonical_error"
  status: number
  headers: Headers
  body: string
}

export interface Canonical_PassthroughResponse {
  type: "canonical_passthrough"
  status: number
  statusText: string
  headers: Headers
  body: ReadableStream<Uint8Array> | Uint8Array | string | null
}
