import { Provider_Registry } from "../core/registry"
import type { RuntimeOptions } from "../core/types"
import type { ProviderMode } from "../core/provider-state"
import { Claude_Codex_Inbound_Adapter } from "../inbound/claude/codex"
import { Claude_Copilot_Inbound_Adapter } from "../inbound/claude/copilot"
import { Claude_Kiro_Inbound_Adapter } from "../inbound/claude/kiro"
import { CLAUDE_MODEL_ROUTES } from "../inbound/claude/routes"
import { createProviderRuntime, providerHasConnectedAccounts, type ProviderRuntimeResult } from "./provider-runtime"
import { buildEndpointProxyProvider, ENDPOINT_PROXY_ROUTES, readEndpointProxyMap, resolveEndpointProxySourceMode } from "./endpoint-share"
import { readProviderConfig, resolveProviderMode } from "./provider-config"

export async function bootstrapRuntime(options?: RuntimeOptions & { providerMode?: ProviderMode; providerConfigPath?: string }) {
  const configMode = options?.providerMode ? undefined : await readProviderConfig(options?.providerConfigPath)
  const providerMode = options?.providerMode ?? resolveProviderMode(process.env.UPSTREAM_PROVIDER, configMode)
  const activeRuntime = await createProviderRuntime(providerMode, options)
  const registry = new Provider_Registry()

  registerClaudeProvider(providerMode, activeRuntime.upstream, registry)
  await registerEndpointProxyProviders(providerMode, activeRuntime, registry, options?.providerConfigPath)

  return {
    authFile: activeRuntime.authFile,
    authAccount: activeRuntime.authAccount,
    registry,
    upstream: activeRuntime.upstream,
  }
}

function registerClaudeProvider(mode: ProviderMode, upstream: ProviderRuntimeResult["upstream"], registry: Provider_Registry) {
  const upstreamWithModels = upstream as typeof upstream & { listModels: () => Promise<string[]> }

  if (mode === "copilot") {
    registry.register(new Claude_Copilot_Inbound_Adapter(() => upstreamWithModels.listModels(), CLAUDE_MODEL_ROUTES))
    return
  }

  if (mode === "kiro") {
    registry.register(new Claude_Kiro_Inbound_Adapter(
      () => upstreamWithModels.listModelDescriptors?.() ?? upstreamWithModels.listModels(),
      CLAUDE_MODEL_ROUTES,
    ))
    return
  }

  registry.register(new Claude_Codex_Inbound_Adapter(
    () => upstreamWithModels.listModelDescriptors?.() ?? upstreamWithModels.listModels(),
    CLAUDE_MODEL_ROUTES,
  ))
}

async function registerEndpointProxyProviders(
  mode: ProviderMode,
  activeRuntime: ProviderRuntimeResult,
  registry: Provider_Registry,
  providerConfigPath?: string,
) {
  const endpointProxy = await readEndpointProxyMap(mode, providerConfigPath)
  const sourceRuntimeCache = new Map<ProviderMode, ProviderRuntimeResult>()

  for (const route of ENDPOINT_PROXY_ROUTES) {
    const sourceMode = resolveEndpointProxySourceMode(mode, route.endpoint, endpointProxy)
    if (!sourceMode) continue
    if (route.endpoint === "embeddings" && sourceMode !== "copilot") continue

    const sourceRuntime = sourceMode === mode
      ? activeRuntime
      : await loadSourceRuntime(sourceMode, sourceRuntimeCache)

    if (!sourceRuntime) continue
    registry.register(buildEndpointProxyProvider(sourceMode, route.endpoint, sourceRuntime.upstream))
  }
}

async function loadSourceRuntime(mode: ProviderMode, cache: Map<ProviderMode, ProviderRuntimeResult>) {
  const cached = cache.get(mode)
  if (cached) return cached
  if (!(await providerHasConnectedAccounts(mode))) return undefined

  try {
    const runtime = await createProviderRuntime(mode)
    cache.set(mode, runtime)
    return runtime
  } catch {
    return undefined
  }
}
