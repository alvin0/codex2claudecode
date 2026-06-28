import { OpenAI_Inbound_Provider } from "./index"
import { OPENAI_PROXY_ROUTES, openAIProxyRouteDescriptor } from "./routes"

export class OpenAI_Copilot_Inbound_Adapter extends OpenAI_Inbound_Provider {
  constructor() {
    super({
      name: "openai-copilot",
      passthrough: false,
      upstreamLogLabel: "Copilot OpenAI",
      upstreamTarget: "upstream",
      expectedUpstreamKind: "copilot",
      routes: OPENAI_PROXY_ROUTES.map(openAIProxyRouteDescriptor),
    })
  }
}
