import { readProviderSection, updateProviderSection, type EndpointProxyMap, type EndpointProxyTarget, type ProviderMode, type ProxyableEndpoint } from "../core/provider-state"
import type { Inbound_Provider, Route_Descriptor, Upstream_Provider } from "../core/interfaces"
import { Claude_Inbound_Provider } from "../inbound/claude"
import { countKiroClaudeInputTokens } from "../inbound/claude/kiro-count"
import { CLAUDE_PROXY_ROUTES, type ClaudeProxyRoute } from "../inbound/claude/routes"
import { OpenAI_Inbound_Provider } from "../inbound/openai"
import { codexBasePathRoutes, CODEX_MODELS_ROUTE, OPENAI_MODELS_ROUTE, OPENAI_PROXY_ROUTES, type OpenAIProxyRoute } from "../inbound/openai/routes"
import { providerHasConnectedAccounts } from "./provider-runtime"

export type EndpointProxyRoute = ClaudeProxyRoute | OpenAIProxyRoute

export const ENDPOINT_PROXY_ROUTES: EndpointProxyRoute[] = [
  ...CLAUDE_PROXY_ROUTES,
  ...OPENAI_PROXY_ROUTES,
]

export function endpointProxyRoute(endpoint: ProxyableEndpoint): EndpointProxyRoute {
  return ENDPOINT_PROXY_ROUTES.find((route) => route.endpoint === endpoint) ?? ENDPOINT_PROXY_ROUTES[0]
}

export function endpointProxyProviderName(mode: ProviderMode) {
  return mode === "codex" ? "openai" : `openai-${mode}`
}

export function endpointProxyProviderLabel(mode: ProviderMode) {
  return mode === "codex" ? "Codex" : mode === "kiro" ? "Kiro" : "Copilot"
}

export function resolveEndpointProxyStoredTarget(mode: ProviderMode, endpoint: ProxyableEndpoint, proxy?: EndpointProxyMap): EndpointProxyTarget {
  return proxy?.[endpoint] ?? "self"
}

export function normalizeEndpointProxyTarget(mode: ProviderMode, endpoint: ProxyableEndpoint, target?: EndpointProxyTarget): EndpointProxyTarget | undefined {
  if (!target) return

  if (endpoint === "embeddings") {
    if (target === "self") return mode === "copilot" ? "self" : undefined
    if (target === "copilot") return mode === "copilot" ? "self" : "copilot"
    return undefined
  }

  if (target === "self" || target === mode) return "self"
  if (target === "codex" || target === "kiro" || target === "copilot") return target
  return undefined
}

export function normalizeEndpointProxyMap(mode: ProviderMode, proxy?: EndpointProxyMap): EndpointProxyMap {
  const next: EndpointProxyMap = {}
  for (const route of ENDPOINT_PROXY_ROUTES) {
    const normalized = normalizeEndpointProxyTarget(mode, route.endpoint, proxy?.[route.endpoint])
    if (normalized && normalized !== "self") next[route.endpoint] = normalized
  }
  return next
}

export async function readEndpointProxyMap(mode: ProviderMode, filePath?: string): Promise<EndpointProxyMap> {
  const section = await readProviderSection(mode, filePath)
  return normalizeStoredEndpointProxyMap(section?.endpointProxy)
}

export async function writeEndpointProxyMap(mode: ProviderMode, filePath: string | undefined, proxy?: EndpointProxyMap) {
  await updateProviderSection(mode, filePath, async (section) => {
    const normalized = normalizeEndpointProxyMap(mode, proxy)
    return {
      ...(section ?? {}),
      endpointProxy: Object.keys(normalized).length ? normalized : undefined,
    }
  })
}

export function resolveEndpointProxySourceMode(mode: ProviderMode, endpoint: ProxyableEndpoint, proxy?: EndpointProxyMap): ProviderMode | undefined {
  const target = normalizeEndpointProxyTarget(mode, endpoint, resolveEndpointProxyStoredTarget(mode, endpoint, proxy))
  if (!target) return
  if (target === "self") return mode
  return target
}

export function resolveEndpointProxyDisplayValue(mode: ProviderMode, endpoint: ProxyableEndpoint, proxy?: EndpointProxyMap) {
  const sourceMode = resolveEndpointProxySourceMode(mode, endpoint, proxy)
  if (!sourceMode) return "Unavailable"
  return sourceMode === mode ? "self" : endpointProxyProviderLabel(sourceMode)
}

export function endpointProxyRouteProvider(sourceMode: ProviderMode, endpoint: ProxyableEndpoint, upstream: Upstream_Provider) {
  const route = endpointProxyRoute(endpoint)
  const upstreamLabels = {
    codex: {
      messages: "Codex messages",
      count_tokens: "Codex input tokens",
      openai: "Codex responses",
    },
    kiro: {
      messages: "Kiro messages",
      count_tokens: "Kiro input tokens",
      openai: "Kiro OpenAI",
    },
    copilot: {
      messages: "Copilot messages",
      count_tokens: "Copilot input tokens",
      openai: "Copilot OpenAI",
    },
  }[sourceMode]

  if (route.family === "claude") {
    const upstreamWithModels = upstream as Upstream_Provider & { listModels: () => Promise<string[]> }
    return new Claude_Inbound_Provider({
      name: `claude-${sourceMode}`,
      modelResolver: () => upstreamWithModels.listModels(),
      upstreamLogLabel: route.endpoint === "messages" ? upstreamLabels.messages : upstreamLabels.count_tokens,
      inputTokensLogLabel: upstreamLabels.count_tokens,
      expectedUpstreamKind: sourceMode,
      localCountTokens: sourceMode === "kiro",
      countTokens: sourceMode === "kiro" ? countKiroClaudeInputTokens : undefined,
      routes: route.routes,
    })
  }

  const upstreamWithModels = upstream as Upstream_Provider & { listModels: () => Promise<string[]> }

  return new OpenAI_Inbound_Provider({
    name: endpointProxyProviderName(sourceMode),
    passthrough: sourceMode === "codex",
    upstreamLogLabel: upstreamLabels.openai,
    upstreamTarget: "upstream",
    expectedUpstreamKind: sourceMode,
    // The Codex model list rides along with the responses endpoint so it is
    // registered exactly once, whichever providers share endpoints. Every route is
    // mirrored under /codex so a client can use that base path instead.
    routes: [
      ...route.routes,
      ...codexBasePathRoutes(route.routes),
      ...(route.endpoint === "responses" ? [OPENAI_MODELS_ROUTE, CODEX_MODELS_ROUTE] : []),
    ],
    modelResolver: () => upstreamWithModels.listModelDescriptors?.() ?? upstreamWithModels.listModels(),
  })
}

export function bindInboundProvider(provider: Inbound_Provider, upstream: Upstream_Provider): Inbound_Provider {
  return new BoundInboundProvider(provider, upstream)
}

export function buildEndpointProxyProvider(sourceMode: ProviderMode, endpoint: ProxyableEndpoint, upstream: Upstream_Provider): Inbound_Provider {
  return bindInboundProvider(endpointProxyRouteProvider(sourceMode, endpoint, upstream), upstream)
}

export async function canUseEndpointProxySource(mode: ProviderMode, endpoint: ProxyableEndpoint, proxy?: EndpointProxyMap) {
  const sourceMode = resolveEndpointProxySourceMode(mode, endpoint, proxy)
  if (!sourceMode) return false
  if (endpoint === "embeddings" && sourceMode !== "copilot") return false
  return providerHasConnectedAccounts(sourceMode)
}

function normalizeStoredEndpointProxyMap(proxy?: EndpointProxyMap): EndpointProxyMap {
  if (!proxy) return {}
  const next: EndpointProxyMap = {}
  for (const route of ENDPOINT_PROXY_ROUTES) {
    const value = proxy[route.endpoint]
    if (value === "self" || value === "codex" || value === "kiro" || value === "copilot") next[route.endpoint] = value
  }
  return next
}

class BoundInboundProvider implements Inbound_Provider {
  readonly name: string

  constructor(
    private readonly provider: Inbound_Provider,
    private readonly upstream: Upstream_Provider,
  ) {
    this.name = provider.name
  }

  routes(): Route_Descriptor[] {
    return this.provider.routes()
  }

  handle(request: Request, route: Route_Descriptor, _upstream: Upstream_Provider, context: Parameters<Inbound_Provider["handle"]>[3]) {
    return this.provider.handle(request, route, this.upstream, context)
  }
}
