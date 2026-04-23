import type { ClaudeMcpServer, ClaudeMcpToolset, ClaudeTool, JsonObject } from "../types"

import type { ClaudeServerToolAdapter } from "./server-tool-adapter"

export const MCP_TOOL_RESULT_INCLUDE = "mcp_call.output"
export const MCP_APPROVAL_INCLUDE = "mcp_call.approval_request_id"

export function resolveMcpServers(servers: Array<ClaudeMcpServer> | undefined) {
  const entries = new Map<string, ClaudeMcpServer>()
  for (const server of servers ?? []) {
    if (!server?.name?.trim()) throw new Error("MCP servers require name")
    if (!server?.url?.trim() && !server?.connector_id?.trim()) throw new Error(`MCP server ${server.name} requires url or connector_id`)
    if (server.type !== undefined && server.type !== "url") throw new Error(`Unsupported MCP server type: ${server.type}`)
    if (server.authorization_token !== undefined && typeof server.authorization_token !== "string") {
      throw new Error(`MCP server ${server.name} authorization_token must be a string`)
    }
    if (entries.has(server.name)) throw new Error(`Duplicate MCP server: ${server.name}`)
    entries.set(server.name, server)
  }
  return entries
}

export function claudeMcpToolsetToResponsesTool(tool: ClaudeMcpToolset, server: ClaudeMcpServer) {
  const allowedTools = dedupeStrings(tool.allowed_tools)
  const toolNames = dedupeStrings(tool.tool_names)
  if (allowedTools.length && toolNames.length) throw new Error(`MCP toolset ${tool.mcp_server_name} cannot set both allowed_tools and tool_names`)
  if (tool.require_approval !== undefined && !isValidRequireApproval(tool.require_approval)) {
    throw new Error(`MCP toolset ${tool.mcp_server_name} has invalid require_approval`)
  }

  return {
    type: "mcp",
    server_label: server.name,
    ...(server.url && { server_url: server.url }),
    ...(server.connector_id && { connector_id: server.connector_id }),
    ...(allowedTools.length && { allowed_tools: allowedTools }),
    ...(toolNames.length && { tool_names: toolNames }),
    ...(server.authorization_token && { authorization: server.authorization_token }),
    ...(server.headers && { headers: server.headers }),
    ...(tool.require_approval && { require_approval: tool.require_approval }),
  }
}

export function codexMcpToClaudeBlocks(item: unknown, fallbackOutput?: unknown): JsonObject[] {
  if (!item || typeof item !== "object") return []
  const outputItem = item as {
    type?: unknown
    output?: unknown
    id?: unknown
    name?: unknown
    arguments?: unknown
    server_label?: unknown
    status?: unknown
    error?: unknown
    approval_request_id?: unknown
    tools?: unknown
  }

  if (outputItem.type === "mcp_call") {
    const id = typeof outputItem.id === "string" ? outputItem.id : `mcp_${crypto.randomUUID().replace(/-/g, "")}`
    const name = typeof outputItem.name === "string" ? outputItem.name : "unknown"
    const serverName = typeof outputItem.server_label === "string" ? outputItem.server_label : "unknown"
    const content = mcpOutputToClaudeContent(outputItem.output ?? fallbackOutput)
    return [
      {
        type: "mcp_tool_use",
        id,
        name,
        server_name: serverName,
        input: parseJsonString(typeof outputItem.arguments === "string" ? outputItem.arguments : "{}"),
        ...(typeof outputItem.approval_request_id === "string" ? { approval_request_id: outputItem.approval_request_id } : {}),
      },
      {
        type: "mcp_tool_result",
        tool_use_id: id,
        is_error: outputItem.status === "failed" || Boolean(outputItem.error),
        content,
      },
    ]
  }

  if (outputItem.type === "mcp_list_tools") {
    return [
      {
        type: "text",
        text: JSON.stringify({
          type: "mcp_list_tools",
          server_name: typeof outputItem.server_label === "string" ? outputItem.server_label : "unknown",
          tools: Array.isArray(outputItem.tools) ? outputItem.tools : [],
        }),
      },
    ]
  }

  return []
}

export function isMcpOutputItem(item: unknown) {
  if (!item || typeof item !== "object") return false
  const outputItem = item as { type?: unknown }
  return outputItem.type === "mcp_call" || outputItem.type === "mcp_list_tools"
}

export function countMcpCalls(output: unknown) {
  if (!Array.isArray(output)) return 0
  return output.reduce((acc, item) => {
    if (!item || typeof item !== "object") return acc
    return (item as { type?: unknown }).type === "mcp_call" ? acc + 1 : acc
  }, 0)
}

export const mcpServerToolAdapter: ClaudeServerToolAdapter = {
  name: "mcp",
  matchesTool(tool): tool is ClaudeMcpToolset {
    return isClaudeMcpToolset(tool)
  },
  resolveTool(tool, context) {
    if (!isClaudeMcpToolset(tool)) throw new Error("Invalid MCP tool")
    const server = context.mcpServers.get(tool.mcp_server_name)
    if (!server) throw new Error(`Unknown MCP server: ${tool.mcp_server_name}`)
    return {
      tool: claudeMcpToolsetToResponsesTool(tool, server),
      include: [MCP_TOOL_RESULT_INCLUDE, MCP_APPROVAL_INCLUDE],
      toolChoiceName: `mcp__${tool.mcp_server_name}`,
      toolChoice: { type: "mcp", server_label: tool.mcp_server_name },
    }
  },
  matchesOutputItem(item) {
    return isMcpOutputItem(item)
  },
  outputItemToBlocks(item, fallbackOutput) {
    return codexMcpToClaudeBlocks(item, fallbackOutput)
  },
  outputToContent(output) {
    if (!Array.isArray(output)) return { content: [], blocks: [] }
    const content = output.flatMap((item) => {
      if (!isMcpOutputItem(item)) return []
      return codexMcpToClaudeBlocks(item)
    })
    return {
      content,
      blocks: content.filter((block) => block.type !== "text"),
      textBlocks: content.filter((block) => block.type === "text"),
    }
  },
  countCalls(output) {
    return { mcpCalls: countMcpCalls(output) }
  },
}

function dedupeStrings(values: unknown) {
  if (!Array.isArray(values)) return []
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).filter((value, index, arr) => arr.indexOf(value) === index)
}

function isValidRequireApproval(value: unknown) {
  if (value === "always" || value === "never") return true
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as JsonObject
  const hasKnownField = item.read_only !== undefined || item.tool_names !== undefined
  if (!hasKnownField) return false
  const readOnlyOk = item.read_only === undefined || typeof item.read_only === "boolean"
  const toolNamesOk = item.tool_names === undefined || (Array.isArray(item.tool_names) && item.tool_names.every((name) => typeof name === "string" && name.trim().length > 0))
  return readOnlyOk && toolNamesOk
}

function mcpOutputToClaudeContent(output: unknown) {
  if (typeof output === "string") return [{ type: "text", text: output }]
  if (Array.isArray(output)) {
    return output.flatMap((item) => {
      if (typeof item === "string") return [{ type: "text", text: item }]
      if (!item || typeof item !== "object") return []
      const part = item as { type?: unknown; text?: unknown }
      if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }]
      return [{ type: "text", text: JSON.stringify(item) }]
    })
  }
  if (output && typeof output === "object") return [{ type: "text", text: JSON.stringify(output) }]
  return []
}

function parseJsonString(value: string) {
  try {
    return JSON.parse(value) as JsonObject
  } catch {
    return {}
  }
}

function isClaudeMcpToolset(tool: ClaudeTool): tool is ClaudeMcpToolset {
  return tool?.type === "mcp_toolset"
}
