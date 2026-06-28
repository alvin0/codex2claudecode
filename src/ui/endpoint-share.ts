import type { EndpointProxyMap, EndpointProxyTarget, ProxyableEndpoint } from "../core/provider-state"
import { resolveProviderAuthFile } from "../app/provider-runtime"
import { ENDPOINT_PROXY_ROUTES, endpointProxyProviderLabel, resolveEndpointProxyDisplayValue, resolveEndpointProxySourceMode, resolveEndpointProxyStoredTarget } from "../app/endpoint-share"
import { providerDefinition } from "./providers/registry"
import type { ProviderMode } from "./types"

export interface EndpointShareAvailability {
  connected: boolean
  message: string
}

export type EndpointShareAvailabilityMap = Record<ProviderMode, EndpointShareAvailability>

export interface EndpointShareEndpointOption {
  endpoint: ProxyableEndpoint
  label: string
  value: string
}

export interface EndpointShareSourceOption {
  target: EndpointProxyTarget
  label: string
  description: string
  available: boolean
  current?: boolean
}

export interface EndpointShareSummaryLine {
  label: string
  source: string
  path: string
  available: boolean
}

export async function loadEndpointShareAvailability(): Promise<EndpointShareAvailabilityMap> {
  const entries = await Promise.all((["codex", "kiro", "copilot"] as const).map(async (mode) => {
    const provider = providerDefinition(mode)
    const authFile = resolveProviderAuthFile(mode)
    if (!provider.accounts) {
      return [mode, { connected: true, message: provider.label }] as const
    }

    try {
      const state = await provider.accounts.loadState(authFile)
      const accounts = provider.accounts.toAccounts(state.data)
      return [mode, { connected: accounts.length > 0, message: accounts.length > 0 ? `${provider.label} connected` : `${provider.label} needs an account` }] as const
    } catch (error) {
      return [mode, { connected: false, message: error instanceof Error ? error.message : String(error) }] as const
    }
  }))

  return Object.fromEntries(entries) as EndpointShareAvailabilityMap
}

export function endpointShareEndpointOptions(mode: ProviderMode, proxy?: EndpointProxyMap): EndpointShareEndpointOption[] {
  return ENDPOINT_PROXY_ROUTES.map((route) => ({
    endpoint: route.endpoint,
    label: route.label,
    value: resolveEndpointProxyDisplayValue(mode, route.endpoint, proxy),
  }))
}

export function endpointShareSourceOptions(
  mode: ProviderMode,
  endpoint: ProxyableEndpoint,
  availability: EndpointShareAvailabilityMap,
  proxy?: EndpointProxyMap,
): EndpointShareSourceOption[] {
  const currentTarget = resolveEndpointProxyStoredTarget(mode, endpoint, proxy)
  const currentSource = endpoint === "embeddings" && currentTarget === "self" && mode !== "copilot"
    ? undefined
    : currentTarget === "self"
      ? "self"
      : currentTarget

  if (endpoint === "embeddings") {
    if (mode === "copilot") {
      return [sourceOption(mode, endpoint, "self", availability, currentSource)]
    }
    return [sourceOption(mode, endpoint, "copilot", availability, currentSource)]
  }

  return [
    sourceOption(mode, endpoint, "self", availability, currentSource),
    ...(["codex", "kiro", "copilot"] as const)
      .filter((candidate) => candidate !== mode)
      .map((candidate) => sourceOption(mode, endpoint, candidate, availability, currentSource)),
  ]
}

export function endpointShareSummaryLines(mode: ProviderMode, proxy?: EndpointProxyMap): EndpointShareSummaryLine[] {
  return ENDPOINT_PROXY_ROUTES.flatMap((route) => {
    const summary = resolveEndpointProxySummaryValue(mode, route.endpoint, proxy)
    if (!summary.available || summary.source === "self") return []
    return [{
      label: route.label,
      ...summary,
    }]
  })
}

export function endpointShareTargetLabel(target: EndpointProxyTarget, mode: ProviderMode) {
  if (target === "self") return "self"
  return endpointProxyProviderLabel(target === mode ? mode : target)
}

export function endpointShareEndpointValue(mode: ProviderMode, endpoint: ProxyableEndpoint, proxy?: EndpointProxyMap) {
  return resolveEndpointProxyDisplayValue(mode, endpoint, proxy)
}

function sourceOption(
  mode: ProviderMode,
  endpoint: ProxyableEndpoint,
  target: EndpointProxyTarget,
  availability: EndpointShareAvailabilityMap,
  currentTarget?: EndpointProxyTarget,
): EndpointShareSourceOption {
  const sourceAvailability = target === "self" ? undefined : availability[target as ProviderMode]
  const connected = target === "self" ? true : sourceAvailability?.connected ?? false
  return {
    target,
    label: endpointShareTargetLabel(target, mode),
    description: connected ? descriptionForTarget(target, mode) : sourceAvailability?.message ?? "Unavailable",
    available: connected,
    current: currentTarget === target,
  }
}

function descriptionForTarget(target: EndpointProxyTarget, mode: ProviderMode) {
  if (target === "self") return `Use the selected ${endpointProxyProviderLabel(mode)} account`
  return `Use the ${endpointProxyProviderLabel(target)} account`
}

function resolveEndpointProxySummaryValue(mode: ProviderMode, endpoint: ProxyableEndpoint, proxy?: EndpointProxyMap) {
  const endpointPath = ENDPOINT_PROXY_ROUTES.find((route) => route.endpoint === endpoint)?.path ?? ""
  const sourceMode = resolveEndpointProxySourceMode(mode, endpoint, proxy)
  if (!sourceMode) {
    return {
      source: "Unavailable",
      path: endpointPath,
      available: false,
    }
  }
  return {
    source: sourceMode === mode ? "self" : endpointProxyProviderLabel(sourceMode),
    path: endpointPath,
    available: true,
  }
}
