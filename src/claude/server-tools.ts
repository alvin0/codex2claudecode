import type { ClaudeMessagesRequest, ClaudeTool, JsonObject } from "../types"

import { resolveMcpServers } from "./mcp"
import { codexMessageOutputToClaudeTextBlocks } from "./server-tool-adapter"
import { mcpServerToolAdapter } from "./mcp"
import { webServerToolAdapter } from "./web"

export interface ResolvedClaudeTools {
  tools?: JsonObject[]
  include?: string[]
  hasWebTool: boolean
  toolChoiceNames: Set<string>
  toolChoices: Map<string, JsonObject>
}

const SERVER_TOOL_ADAPTERS = [webServerToolAdapter, mcpServerToolAdapter]

export function resolveClaudeTools(body: ClaudeMessagesRequest): ResolvedClaudeTools {
  const mcpServers = resolveMcpServers(body.mcp_servers)
  const mappedTools: JsonObject[] = []
  const include = new Set<string>()
  const toolChoiceNames = new Set<string>()
  const toolChoices = new Map<string, JsonObject>()
  let hasWebTool = false

  for (const tool of body.tools ?? []) {
    const adapter = SERVER_TOOL_ADAPTERS.find((item) => item.matchesTool(tool))
    if (adapter) {
      const resolved = adapter.resolveTool(tool, { body, mcpServers })
      mappedTools.push(resolved.tool)
      resolved.include?.forEach((value) => include.add(value))
      toolChoiceNames.add(resolved.toolChoiceName)
      toolChoices.set(resolved.toolChoiceName, resolved.toolChoice)
      hasWebTool = hasWebTool || Boolean(resolved.hasWebTool)
      continue
    }

    const toolName = tool.name
    if (typeof toolName !== "string") throw new Error("Function tools require name")
    mappedTools.push(claudeFunctionToolToResponsesTool(tool))
    toolChoiceNames.add(toolName)
    toolChoices.set(toolName, { type: "function", name: toolName })
  }

  return {
    ...(mappedTools.length && { tools: dedupeTools(mappedTools) }),
    ...(include.size && { include: [...include] }),
    hasWebTool,
    toolChoiceNames,
    toolChoices,
  }
}

export function claudeToolChoiceToResponsesToolChoice(
  toolChoice: NonNullable<ClaudeMessagesRequest["tool_choice"]>,
  resolvedTools: ResolvedClaudeTools,
) {
  if (toolChoice.type === "none") return "none"
  if (toolChoice.type === "any") return "required"
  if (toolChoice.type !== "tool") return "auto"
  if (!toolChoice.name) return "auto"
  if (!resolvedTools.toolChoiceNames.has(toolChoice.name)) throw new Error(`Unknown tool_choice name: ${toolChoice.name}`)
  return resolvedTools.toolChoices.get(toolChoice.name) ?? "auto"
}

export function codexServerToolCallToClaudeBlocks(item: unknown, fallbackOutput?: unknown): JsonObject[] {
  const adapter = SERVER_TOOL_ADAPTERS.find((entry) => entry.matchesOutputItem(item))
  return adapter ? adapter.outputItemToBlocks(item, fallbackOutput) : []
}

export function codexOutputItemsToClaudeContent(output: unknown) {
  const adapterContent = SERVER_TOOL_ADAPTERS.map((adapter) => adapter.outputToContent(output))
  const hasMcp = adapterContent.some((entry) => entry.blocks.some((block) => block.type === "mcp_tool_use" || block.type === "mcp_tool_result"))
  if (!hasMcp) {
    const webContent = adapterContent.flatMap((entry) => entry.content)
    return webContent.length ? webContent : codexMessageOutputToClaudeTextBlocks(output)
  }

  const blocks = adapterContent.flatMap((entry) => entry.blocks)
  const textBlocks = [...adapterContent.flatMap((entry) => entry.textBlocks ?? []), ...codexMessageOutputToClaudeTextBlocks(output)]
  return [...blocks, ...textBlocks]
}

export function countClaudeServerToolCalls(output: unknown) {
  return SERVER_TOOL_ADAPTERS.reduce(
    (acc, adapter) => ({ ...acc, ...adapter.countCalls(output) }),
    { webSearchRequests: 0, webFetchRequests: 0, mcpCalls: 0 },
  )
}

export function isServerToolOutputItem(item: unknown) {
  return SERVER_TOOL_ADAPTERS.some((adapter) => adapter.matchesOutputItem(item))
}

function claudeFunctionToolToResponsesTool(tool: ClaudeTool) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema ?? { type: "object", properties: {} },
    strict: tool.strict ?? false,
  }
}

function dedupeTools(tools: JsonObject[]) {
  return tools.filter((tool, index, mapped) => {
    if (tool.type === "web_search") return mapped.findIndex((item) => item.type === "web_search") === index
    if (tool.type === "mcp" && typeof tool.server_label === "string") {
      return mapped.findIndex((item) => item.type === "mcp" && item.server_label === tool.server_label) === index
    }
    return true
  })
}
