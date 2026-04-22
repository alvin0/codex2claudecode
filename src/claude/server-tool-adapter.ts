import type { ClaudeMcpServer, ClaudeMessagesRequest, ClaudeTool, JsonObject } from "../types"

export interface ServerToolResolutionContext {
  body: ClaudeMessagesRequest
  mcpServers: Map<string, ClaudeMcpServer>
}

export interface ResolvedServerTool {
  tool: JsonObject
  include?: string[]
  toolChoiceName: string
  toolChoice: JsonObject
  hasWebTool?: boolean
}

export interface ServerToolContent {
  content: JsonObject[]
  blocks: JsonObject[]
  textBlocks?: JsonObject[]
}

export interface ServerToolUsageCounts {
  webSearchRequests: number
  webFetchRequests: number
  mcpCalls: number
}

export interface ClaudeServerToolAdapter {
  name: string
  matchesTool(tool: ClaudeTool): boolean
  resolveTool(tool: ClaudeTool, context: ServerToolResolutionContext): ResolvedServerTool
  matchesOutputItem(item: unknown): boolean
  outputItemToBlocks(item: unknown, fallbackOutput?: unknown): JsonObject[]
  outputToContent(output: unknown): ServerToolContent
  countCalls(output: unknown): Partial<ServerToolUsageCounts>
}

export function codexMessageContentToClaudeTextBlocks(content: unknown): JsonObject[] {
  if (!content || typeof content !== "object") return []
  const item = content as { type?: unknown; text?: unknown }
  if (item.type !== "output_text" || typeof item.text !== "string") return []
  return [{ type: "text", text: item.text }]
}

export function codexMessageOutputToClaudeTextBlocks(output: unknown) {
  if (!Array.isArray(output)) return []
  return output.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const outputItem = item as { type?: unknown; content?: unknown }
    if (outputItem.type !== "message" || !Array.isArray(outputItem.content)) return []
    return outputItem.content.flatMap((content) => codexMessageContentToClaudeTextBlocks(content))
  })
}
