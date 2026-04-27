import { Claude_Inbound_Provider } from "./index"
import { claudeSettingsModelResolver } from "./models"

export { handleClaudeCountTokens, handleClaudeMessages } from "./handlers"

export class Claude_Codex_Inbound_Adapter extends Claude_Inbound_Provider {
  constructor(modelResolver: () => Promise<string[]> = claudeSettingsModelResolver) {
    super({
      name: "claude-codex",
      modelResolver,
      upstreamLogLabel: "Codex responses",
      inputTokensLogLabel: "Codex input tokens",
      expectedUpstreamKind: "codex",
    })
  }
}
