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
 * it, and `passthrough`: it reaches the passthrough decider through `buildEndpointProxyProvider()`,
 * which no longer reads the environment for itself. The flag's default is **off**, so the canonical
 * path is taken even when the other three conditions of design decision D4 hold.
 * `kiroWebSearchHeuristics` travels the same route as `strict` — through
 * `createProviderRuntime()` into `Kiro_Upstream_Provider`, which gates the web-search intent
 * preflight and the synthesized client tool calls on it (task 27.1); default off means the
 * gateway stops guessing unless the operator asks for the old behavior back.
 * `mcpEmulation` now travels the same route as the other two — through `createProviderRuntime()`
 * into `Kiro_Upstream_Provider`, which pairs it with the declared `mcpToolset` cell before taking
 * any emulation path (tasks 35.2, 35.3). Default off means an MCP-bearing request keeps getting the
 * 400 it got before the flag existed. Only Kiro consumes it: Codex forwards MCP toolsets natively.
 *
 * `src/app/runtime.ts` is not involved and is not modified: it routes through the registry and
 * core interfaces only, and `test/architecture.property.test.ts` asserts it keeps zero provider
 * identifiers (Requirements 27.5, 27.6).
 */
export async function bootstrapRuntime(options?: RuntimeOptions & { providerMode?: ProviderMode; providerConfigPath?: string }) {
  const configMode = options?.providerMode ? undefined : await readProviderConfig(options?.providerConfigPath)
  const providerMode = options?.providerMode ?? resolveProviderMode(process.env.UPSTREAM_PROVIDER, configMode)
  const nativeFlags = readNativeFlags()
  const activeRuntime = await createProviderRuntime(providerMode, {
    ...options,
    strict: nativeFlags.strict,
    kiroWebSearchHeuristics: nativeFlags.kiroWebSearchHeuristics,
    mcpEmulation: nativeFlags.mcpEmulation,
  })
  const registry = new Provider_Registry()

  registerClaudeProvider(providerMode, activeRuntime.upstream, registry)
  await registerEndpointProxyProviders(providerMode, activeRuntime, registry, options?.providerConfigPath, {
    strict: nativeFlags.strict,
    passthrough: nativeFlags.passthrough,
    kiroWebSearchHeuristics: nativeFlags.kiroWebSearchHeuristics,
    mcpEmulation: nativeFlags.mcpEmulation,
  })

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
 * `strict`, `passthrough`, `kiroWebSearchHeuristics`, and `mcpEmulation` are threaded in rather than
 * re-read so a borrowed upstream resolves features, decides passthrough, guesses (or does not guess)
 * web search, and emulates (or refuses) an MCP toolset exactly like the active one: one flag read,
 * one value, every provider the process builds.
 * An object rather than four positional booleans, because same-typed positions next to each other
 * are the kind of thing a later edit swaps silently.
 */
async function registerEndpointProxyProviders(
  mode: ProviderMode,
  activeRuntime: ProviderRuntimeResult,
  registry: Provider_Registry,
  providerConfigPath?: string,
  flags: { strict?: boolean; passthrough?: boolean; kiroWebSearchHeuristics?: boolean; mcpEmulation?: boolean } = {},
) {
  const { strict, passthrough = false, kiroWebSearchHeuristics, mcpEmulation } = flags
  const endpointProxy = await readEndpointProxyMap(mode, providerConfigPath)
  const sourceRuntimeCache = new Map<ProviderMode, ProviderRuntimeResult>()

  for (const route of ENDPOINT_PROXY_ROUTES) {
    const sourceMode = resolveEndpointProxySourceMode(mode, route.endpoint, endpointProxy)
    if (!sourceMode) continue
    if (route.endpoint === "embeddings" && sourceMode !== "copilot") continue

    const sourceRuntime = sourceMode === mode
      ? activeRuntime
      : await loadSourceRuntime(sourceMode, sourceRuntimeCache, { strict, kiroWebSearchHeuristics, mcpEmulation })

    if (!sourceRuntime) continue
    registry.register(buildEndpointProxyProvider(sourceMode, route.endpoint, sourceRuntime.upstream, passthrough))
  }
}

async function loadSourceRuntime(
  mode: ProviderMode,
  cache: Map<ProviderMode, ProviderRuntimeResult>,
  flags: { strict?: boolean; kiroWebSearchHeuristics?: boolean; mcpEmulation?: boolean } = {},
) {
  const cached = cache.get(mode)
  if (cached) return cached
  if (!(await providerHasConnectedAccounts(mode))) return undefined

  try {
    const runtime = await createProviderRuntime(mode, { strict: flags.strict, kiroWebSearchHeuristics: flags.kiroWebSearchHeuristics, mcpEmulation: flags.mcpEmulation })
    cache.set(mode, runtime)
    return runtime
  } catch {
    return undefined
  }
}
