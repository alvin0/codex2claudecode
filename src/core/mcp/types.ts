/**
 * Provider-agnostic MCP protocol and toolset types.
 *
 * This module is part of `src/core/mcp/`, which imports nothing from
 * `src/inbound/` or `src/upstream/` (Requirement 20.7). Every shape here is
 * described in terms of the MCP wire protocol, not in terms of any one upstream
 * or inbound API.
 */

import type { JsonObject } from "../types"

/**
 * Approval policy for an MCP toolset, exactly as the Responses-style `mcp` tool
 * carries it: the two literals, or an object selecting by read-only-ness or by
 * tool name.
 */
export type McpRequireApproval =
  | "always"
  | "never"
  | { read_only?: boolean; tool_names?: string[] }

/**
 * A single MCP toolset as declared on a request.
 *
 * This is the shape the inbound MCP-toolset converter already produces —
 * snake_case field names included — so an inbound provider hands its output
 * straight to the core executor with no second translation (Requirement 21.1).
 * Optional members are *omitted* by that producer rather than set to
 * `undefined`, and consumers here treat absent and empty alike.
 */
export interface McpToolsetSpec {
  /** `type: "mcp"`, the discriminant the producer always emits. */
  type?: "mcp"
  /** Server name as the client declared it. Used for display and for routing. */
  server_label: string
  /** Remote endpoint. Absent when the toolset is addressed by `connector_id`. */
  server_url?: string
  /** Hosted-connector id, the alternative to `server_url`. */
  connector_id?: string
  /** Allowlist of tool names to expose. Mutually exclusive with `tool_names`. */
  allowed_tools?: string[]
  /** Explicit tool selection. Mutually exclusive with `allowed_tools`. */
  tool_names?: string[]
  /**
   * Bearer material for the remote server, supplied by the client. The core MCP
   * client receives it as a parameter and never reads it from a credential file
   * (Requirement 20.2).
   */
  authorization?: string
  /** Extra request headers the client asked to forward. */
  headers?: Record<string, string>
  /** Approval policy, forwarded verbatim when present. */
  require_approval?: McpRequireApproval
}

/** One tool as advertised by a `tools/list` response. */
export interface McpRemoteTool {
  name: string
  description?: string
  /** JSON Schema for the tool's arguments, as the server published it. */
  inputSchema?: JsonObject
}

/** The outcome of a `tools/call`. */
export interface McpCallResult {
  /**
   * The call's payload. When the server used the text-embedded envelope
   * `{result:{content:[{type:"text",text:"<json>"}]}}` this is the *parsed*
   * embedded JSON; otherwise it is `result.content` as received.
   */
  content: unknown
  /** `true` when the server flagged the call as failed (`result.isError`). */
  isError: boolean
}
