import { OpenAI_Inbound_Provider } from "./index"
import { OPENAI_NON_EMBEDDINGS_ROUTES, openAIProxyRouteDescriptor } from "./routes"

export class OpenAI_Kiro_Inbound_Adapter extends OpenAI_Inbound_Provider {
  constructor() {
    super({
      name: "openai-kiro",
      passthrough: false,
      upstreamLogLabel: "Kiro OpenAI",
      upstreamTarget: "upstream",
      expectedUpstreamKind: "kiro",
      routes: OPENAI_NON_EMBEDDINGS_ROUTES.map(openAIProxyRouteDescriptor),
    })
  }
}
