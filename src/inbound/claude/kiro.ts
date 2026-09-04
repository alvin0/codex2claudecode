import type { Route_Descriptor } from "../../core/interfaces"
import { Claude_Inbound_Provider } from "./index"
import { countKiroClaudeInputTokens } from "./kiro-count"
import type { ModelResolverFn } from "./models"

export class Claude_Kiro_Inbound_Adapter extends Claude_Inbound_Provider {
  constructor(modelResolver: ModelResolverFn, routes?: Route_Descriptor[], featureNotices?: boolean) {
    super({
      featureNotices,
      name: "claude-kiro",
      modelResolver,
      upstreamLogLabel: "Kiro messages",
      inputTokensLogLabel: "Kiro input tokens",
      expectedUpstreamKind: "kiro",
      localCountTokens: true,
      countTokens: countKiroClaudeInputTokens,
      routes,
    })
  }
}
