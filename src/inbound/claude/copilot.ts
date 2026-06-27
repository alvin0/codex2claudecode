import { Claude_Inbound_Provider } from "./index"
import { claudeSettingsModelResolver } from "./models"

export class Claude_Copilot_Inbound_Adapter extends Claude_Inbound_Provider {
  constructor(modelResolver: () => Promise<string[]>) {
    super({
      name: "claude-copilot",
      modelResolver: modelResolver ?? claudeSettingsModelResolver,
      upstreamLogLabel: "Copilot messages",
      inputTokensLogLabel: "Copilot input tokens",
      expectedUpstreamKind: "copilot",
    })
  }
}
