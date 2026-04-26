import { OpenAI_Inbound_Provider } from "./index"

export class OpenAI_Kiro_Inbound_Adapter extends OpenAI_Inbound_Provider {
  constructor() {
    super({
      name: "openai-kiro",
      passthrough: false,
      upstreamLogLabel: "Kiro OpenAI",
      upstreamTarget: "upstream",
      routes: [
        { path: "/v1/responses", method: "POST" },
        { path: "/v1/chat/completions", method: "POST" },
      ],
    })
  }
}
