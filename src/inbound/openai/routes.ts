import type { Route_Descriptor } from "../../core/interfaces"
import type { ProxyableEndpoint } from "../../core/provider-state"

export interface OpenAIProxyRoute {
  family: "openai"
  endpoint: ProxyableEndpoint
  label: string
  path: string
  method: Route_Descriptor["method"]
  routes: Route_Descriptor[]
}

export const OPENAI_PROXY_ROUTES: OpenAIProxyRoute[] = [
  { family: "openai", endpoint: "responses", label: "Responses", path: "/v1/responses", method: "POST", routes: [{ path: "/v1/responses", method: "POST" }] },
  { family: "openai", endpoint: "chat_completions", label: "Chat completions", path: "/v1/chat/completions", method: "POST", routes: [{ path: "/v1/chat/completions", method: "POST" }] },
  { family: "openai", endpoint: "embeddings", label: "Embeddings", path: "/v1/embeddings", method: "POST", routes: [{ path: "/v1/embeddings", method: "POST" }] },
]

export const OPENAI_NON_EMBEDDINGS_ROUTES = OPENAI_PROXY_ROUTES.filter((route) => route.endpoint !== "embeddings")

export function openAIProxyRouteDescriptor(route: OpenAIProxyRoute): Route_Descriptor {
  return { path: route.path, method: route.method }
}
