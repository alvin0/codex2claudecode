import { Claude_Inbound_Provider } from "./index"

export class Claude_Kiro_Inbound_Adapter extends Claude_Inbound_Provider {
  constructor(modelResolver: () => Promise<string[]>) {
    super({
      name: "claude-kiro",
      modelResolver,
      upstreamLogLabel: "Kiro messages",
      inputTokensLogLabel: "Kiro input tokens",
    })
  }
}
