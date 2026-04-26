import { readProviderConfig, resolveProviderMode } from "../../app/provider-config"
import type { Upstream_Provider } from "../../core/interfaces"
import { buildProviderInfo } from "../provider-info"
import type { ProviderInfo, ProviderMode } from "../types"
import { codexProviderDefinition } from "./codex"
import { kiroProviderDefinition } from "./kiro"
import type { UiProviderDefinition } from "./types"

const PROVIDERS: UiProviderDefinition[] = [codexProviderDefinition, kiroProviderDefinition]

export function providerDefinition(mode: ProviderMode): UiProviderDefinition {
  return PROVIDERS.find((provider) => provider.mode === mode) ?? codexProviderDefinition
}

export function nextProviderDefinition(mode: ProviderMode): UiProviderDefinition {
  const index = PROVIDERS.findIndex((provider) => provider.mode === mode)
  return PROVIDERS[(index + 1) % PROVIDERS.length] ?? codexProviderDefinition
}

export async function resolveInitialProviderMode() {
  const configMode = await readProviderConfig()
  return resolveProviderMode(process.env.UPSTREAM_PROVIDER, configMode)
}

export function fallbackProviderInfo(mode: ProviderMode): ProviderInfo {
  const provider = providerDefinition(mode)
  return buildProviderInfo(mode, {} as Upstream_Provider, provider.authFile())
}
