import { OpenAI_Inbound_Provider } from "./index"

export class OpenAI_Copilot_Inbound_Adapter extends OpenAI_Inbound_Provider {
  constructor() {
    super({
      name: "openai-copilot",
      passthrough: false,
      upstreamLogLabel: "Copilot OpenAI",
      upstreamTarget: "upstream",
      expectedUpstreamKind: "copilot",
      routes: [
        { path: "/v1/responses", method: "POST" },
        { path: "/v1/chat/completions", method: "POST" },
        { path: "/v1/embeddings", method: "POST" },
      ],
    })
  }
}
