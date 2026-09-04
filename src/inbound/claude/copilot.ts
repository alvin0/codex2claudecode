import type { Route_Descriptor } from "../../core/interfaces"
import { Claude_Inbound_Provider } from "./index"
import { claudeSettingsModelResolver } from "./models"

export class Claude_Copilot_Inbound_Adapter extends Claude_Inbound_Provider {
  constructor(modelResolver: () => Promise<string[]>, routes?: Route_Descriptor[], featureNotices?: boolean) {
    super({
      featureNotices,
      name: "claude-copilot",
      modelResolver: modelResolver ?? claudeSettingsModelResolver,
      upstreamLogLabel: "Copilot messages",
      inputTokensLogLabel: "Copilot input tokens",
      expectedUpstreamKind: "copilot",
      routes,
    })
  }
}
