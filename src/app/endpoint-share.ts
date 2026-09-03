import { readProviderSection, updateProviderSection, type EndpointProxyMap, type EndpointProxyTarget, type ProviderMode, type ProxyableEndpoint } from "../core/provider-state"
import type { Inbound_Provider, Route_Descriptor, Upstream_Provider } from "../core/interfaces"
import { Claude_Inbound_Provider } from "../inbound/claude"
import { countKiroClaudeInputTokens } from "../inbound/claude/kiro-count"
import { CLAUDE_PROXY_ROUTES, type ClaudeProxyRoute } from "../inbound/claude/routes"
import { OpenAI_Inbound_Provider } from "../inbound/openai"
import { codexBasePathRoutes, CODEX_MODELS_ROUTE, OPENAI_MODELS_ROUTE, OPENAI_PROXY_ROUTES, type OpenAIProxyRoute } from "../inbound/openai/routes"
import { passthroughDecider } from "./passthrough-resolver"
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

/**
 * `passthroughEnabled` is the resolved `NATIVE_PASSTHROUGH` value, and it is **required**: this
 * module no longer reads the flag for itself. `src/app/bootstrap.ts` calls `readNativeFlags()`
 * once and threads the value here (design decision D3), so the flag has exactly one reader and a
 * test covers both states without mutating `process.env`. The flag's own default is off.
 */
export function endpointProxyRouteProvider(sourceMode: ProviderMode, endpoint: ProxyableEndpoint, upstream: Upstream_Provider, passthroughEnabled: boolean) {
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
    // A decider rather than the former bare `sourceMode === "codex"`: the four-way truth table
    // (design decision D4) needs the route path and `stream`, which only exist per request. The
    // two inputs known at composition time are pre-bound here. This closes the gap task 18.1
    // opened by making `normalize.ts` read the option: with the bare boolean now being read, a
    // codex-mode `stream: false` request would be told to forward raw Codex SSE where the client
    // asked for JSON.
    //
    // The decider is bound for codex only, and the non-codex modes keep the literal `false` they
    // effectively had. Not a shortcut around the truth table — `providerKind` is still passed and
    // still checked — but a decider is also read as an instance *capability* by the inbound
    // provider, and that capability is what its lenient branches key off: a malformed JSON body,
    // request-shape validation, and forwarding an upstream error unrendered. Kiro and Copilot must
    // keep rendering the OpenAI error shape with its feature-warning segment, so handing them a
    // decider — capability `true` — would silently turn their errors into raw upstream bytes.
    passthrough: sourceMode === "codex"
      ? passthroughDecider({ providerKind: sourceMode, flagEnabled: passthroughEnabled })
      : false,
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

export function buildEndpointProxyProvider(sourceMode: ProviderMode, endpoint: ProxyableEndpoint, upstream: Upstream_Provider, passthroughEnabled: boolean): Inbound_Provider {
  return bindInboundProvider(endpointProxyRouteProvider(sourceMode, endpoint, upstream, passthroughEnabled), upstream)
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
