import { readProviderConfig, resolveProviderMode } from "../../app/provider-config"
import type { Upstream_Provider } from "../../core/interfaces"
import { buildProviderInfo } from "../provider-info"
import type { ProviderInfo, ProviderMode } from "../types"
import { copilotProviderDefinition } from "./copilot"
import { codexProviderDefinition } from "./codex"
import { kiroProviderDefinition } from "./kiro"
import type { UiProviderDefinition } from "./types"

const PROVIDERS: UiProviderDefinition[] = [codexProviderDefinition, kiroProviderDefinition, copilotProviderDefinition]

export const PROVIDER_MODE_SEQUENCE: ProviderMode[] = ["codex", "kiro", "copilot"]

export function providerDefinition(mode: ProviderMode): UiProviderDefinition {
  return PROVIDERS.find((provider) => provider.mode === mode) ?? codexProviderDefinition
}

export function nextProviderDefinition(mode: ProviderMode): UiProviderDefinition {
  const index = PROVIDER_MODE_SEQUENCE.indexOf(mode)
  return providerDefinition(PROVIDER_MODE_SEQUENCE[(index + 1) % PROVIDER_MODE_SEQUENCE.length] ?? "codex")
}

export function providerDefinitions() {
  return PROVIDER_MODE_SEQUENCE.map((mode) => providerDefinition(mode))
}

export async function resolveInitialProviderMode() {
  const configMode = await readProviderConfig()
  return resolveProviderMode(process.env.UPSTREAM_PROVIDER, configMode)
}

export function fallbackProviderInfo(mode: ProviderMode): ProviderInfo {
  const provider = providerDefinition(mode)
  return buildProviderInfo(mode, {} as Upstream_Provider, provider.authFile())
}
