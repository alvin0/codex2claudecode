import { collectCodexResponse, streamCodexResponse } from "../../upstream/codex/parse"
import type { CodexStandaloneClient } from "../../upstream/codex/client"
import { Claude_Inbound_Provider } from "./index"
import type { CodexProxyFn } from "./handlers"
import { claudeSettingsModelResolver } from "./models"

export { handleClaudeCountTokens, handleClaudeMessages } from "./handlers"
export type { CodexProxyFn } from "./handlers"

/**
 * Wrap a CodexStandaloneClient as a CodexProxyFn so that the cross-layer
 * import (upstream/codex/parse) stays in this adapter file rather than
 * leaking into the handler.
 */
export function codexProxyFn(client: CodexStandaloneClient): CodexProxyFn {
  return {
    proxy: (body, options) => client.proxy(body, options),
    collectResponse: (response, model) => collectCodexResponse(response, model),
    streamResponse: (response, model) => streamCodexResponse(response, model),
  }
}

export class Claude_Codex_Inbound_Adapter extends Claude_Inbound_Provider {
  constructor(modelResolver?: () => Promise<string[]>) {
    super({
      name: "claude-codex",
      modelResolver: modelResolver ?? claudeSettingsModelResolver,
      upstreamLogLabel: "Codex responses",
      inputTokensLogLabel: "Codex input tokens",
      expectedUpstreamKind: "codex",
    })
  }
}
