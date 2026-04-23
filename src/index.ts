// Types — explicit re-exports from provider directories
export type { HealthStatus, JsonObject, RequestLogEntry, RequestOptions, RequestProxyLog, RuntimeOptions, SseEvent } from "./core/types"
export type { AuthFileContent, AuthFileData, ChatCompletionRequest, CodexClientOptions, CodexClientTokens, ResponsesRequest, TokenResponse } from "./upstream/codex/types"
export type { ClaudeFunctionTool, ClaudeMcpServer, ClaudeMcpToolset, ClaudeMessagesRequest, ClaudeTool } from "./inbound/claude/types"

// Composition root files — moved to src/app/
export * from "./app/cli"
export * from "./app/package-info"
export * from "./app/runtime"

// Provider directory re-exports
export * from "./upstream/codex/account-info"
export * from "./upstream/codex/auth"
export { CodexStandaloneClient } from "./upstream/codex/client"
export { normalizeReasoningBody } from "./core/reasoning"
export { normalizeRequestBody } from "./inbound/openai/normalize"

import { CodexStandaloneClient } from "./upstream/codex/client"
import { resolveAuthFile } from "./core/paths"

export async function runExample() {
  const client = await CodexStandaloneClient.fromAuthFile(resolveAuthFile(process.env.CODEX_AUTH_FILE))

  const response = await client.responses({
    model: "gpt-5.1-codex",
    input: "Say hello in one short sentence.",
  })

  console.log(JSON.stringify(response, null, 2))
  console.log("Updated tokens:", client.tokens)
}
