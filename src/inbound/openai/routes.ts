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

/**
 * Everything OpenAI-shaped is also served under `/codex`, so a client can point at
 * `http://host:port/codex/v1` and never collide with the Anthropic routes.
 */
export const CODEX_BASE_PATH = "/codex"

/**
 * `GET /v1/models` is already served in Anthropic shape for Claude Code, so on the
 * bare path the OpenAI-shaped listing is discriminated by `originator` — a header
 * Codex CLI and the Codex IDE send on every request and Claude Code never sends.
 * Under `/codex` there is nothing to disambiguate.
 */
export const OPENAI_MODELS_ROUTE: Route_Descriptor = {
  path: "/v1/models",
  method: "GET",
  headerDiscriminator: { name: "originator", mode: "presence" },
}

export const CODEX_MODELS_ROUTE: Route_Descriptor = {
  path: "/v1/models",
  method: "GET",
  basePath: CODEX_BASE_PATH,
}

/** The same routes again under `/codex`, for clients that use the dedicated base path. */
export function codexBasePathRoutes(routes: Route_Descriptor[]): Route_Descriptor[] {
  return routes.map((route) => ({ ...route, basePath: CODEX_BASE_PATH }))
}

export function openAIProxyRouteDescriptor(route: OpenAIProxyRoute): Route_Descriptor {
  return { path: route.path, method: route.method }
}
