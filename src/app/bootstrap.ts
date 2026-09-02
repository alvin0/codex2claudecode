import { Provider_Registry } from "../core/registry"
import type { RuntimeOptions } from "../core/types"
import type { ProviderMode } from "../core/provider-state"
import { Claude_Codex_Inbound_Adapter } from "../inbound/claude/codex"
import { Claude_Copilot_Inbound_Adapter } from "../inbound/claude/copilot"
import { Claude_Kiro_Inbound_Adapter } from "../inbound/claude/kiro"
import { CLAUDE_MODEL_ROUTES } from "../inbound/claude/routes"
import { createProviderRuntime, providerHasConnectedAccounts, type ProviderRuntimeResult } from "./provider-runtime"
import { buildEndpointProxyProvider, ENDPOINT_PROXY_ROUTES, readEndpointProxyMap, resolveEndpointProxySourceMode } from "./endpoint-share"
import { readNativeFlags } from "./native-flags"
import { readProviderConfig, resolveProviderMode } from "./provider-config"

/**
 * The composition root: it decides which concrete providers exist and hands each one the
 * settings it cannot read for itself.
 *
 * `readNativeFlags()` is called **once**, here, and the resolved booleans travel down as plain
 * parameters — nothing under `src/core/`, `src/inbound/`, or `src/upstream/` reads the
 * environment for them (design decision D3). Today only `strict` has a consumer: it reaches
 * `resolveFeature()` through provider construction, which is the single function that interprets
 * it. `passthrough`, `mcpEmulation`, and `kiroWebSearchHeuristics` are read here but have no
 * parameter to travel through yet; their consumers arrive with tasks 19, 35/36, and 27, and no
 * placeholder is invented for them in the meantime.
 *
 * `src/app/runtime.ts` is not involved and is not modified: it routes through the registry and
 * core interfaces only, and `test/architecture.property.test.ts` asserts it keeps zero provider
 * identifiers (Requirements 27.5, 27.6).
 */
export async function bootstrapRuntime(options?: RuntimeOptions & { providerMode?: ProviderMode; providerConfigPath?: string }) {
  const configMode = options?.providerMode ? undefined : await readProviderConfig(options?.providerConfigPath)
  const providerMode = options?.providerMode ?? resolveProviderMode(process.env.UPSTREAM_PROVIDER, configMode)
  const nativeFlags = readNativeFlags()
  const activeRuntime = await createProviderRuntime(providerMode, { ...options, strict: nativeFlags.strict })
  const registry = new Provider_Registry()

  registerClaudeProvider(providerMode, activeRuntime.upstream, registry)
  await registerEndpointProxyProviders(providerMode, activeRuntime, registry, options?.providerConfigPath, nativeFlags.strict)

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

/**
 * `strict` is threaded in rather than re-read so a borrowed upstream resolves features exactly
 * like the active one: one flag read, one value, every provider the process builds.
 */
async function registerEndpointProxyProviders(
  mode: ProviderMode,
  activeRuntime: ProviderRuntimeResult,
  registry: Provider_Registry,
  providerConfigPath?: string,
  strict?: boolean,
) {
  const endpointProxy = await readEndpointProxyMap(mode, providerConfigPath)
  const sourceRuntimeCache = new Map<ProviderMode, ProviderRuntimeResult>()

  for (const route of ENDPOINT_PROXY_ROUTES) {
    const sourceMode = resolveEndpointProxySourceMode(mode, route.endpoint, endpointProxy)
    if (!sourceMode) continue
    if (route.endpoint === "embeddings" && sourceMode !== "copilot") continue

    const sourceRuntime = sourceMode === mode
      ? activeRuntime
      : await loadSourceRuntime(sourceMode, sourceRuntimeCache, strict)

    if (!sourceRuntime) continue
    registry.register(buildEndpointProxyProvider(sourceMode, route.endpoint, sourceRuntime.upstream))
  }
}

async function loadSourceRuntime(mode: ProviderMode, cache: Map<ProviderMode, ProviderRuntimeResult>, strict?: boolean) {
  const cached = cache.get(mode)
  if (cached) return cached
  if (!(await providerHasConnectedAccounts(mode))) return undefined

  try {
    const runtime = await createProviderRuntime(mode, { strict })
    cache.set(mode, runtime)
    return runtime
  } catch {
    return undefined
  }
}
