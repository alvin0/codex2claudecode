import { bunPath as path } from "../core/paths"
import { appDataDir, expandHome, resolveAuthFile } from "../core/paths"
import { Provider_Registry } from "../core/registry"
import { providerStatePath } from "../core/provider-state"
import type { RuntimeOptions } from "../core/types"
import { Claude_Codex_Inbound_Adapter } from "../inbound/claude/codex"
import { Claude_Copilot_Inbound_Adapter } from "../inbound/claude/copilot"
import { Claude_Kiro_Inbound_Adapter } from "../inbound/claude/kiro"
import { OpenAI_Inbound_Provider } from "../inbound/openai"
import { OpenAI_Copilot_Inbound_Adapter } from "../inbound/openai/copilot"
import { OpenAI_Kiro_Inbound_Adapter } from "../inbound/openai/kiro"
import { Codex_Upstream_Provider } from "../upstream/codex"
import { ensureCodexAuthFile } from "../upstream/codex/account-info"
import { COPILOT_AUTH_FILE_NAME } from "../upstream/copilot/constants"
import { ensureCopilotAuthFile } from "../upstream/copilot/account-store"
import { ensureKiroAuthFile } from "../upstream/kiro/account-store"
import { KIRO_AUTH_TOKEN_PATH, KIRO_STATE_FILE_NAME } from "../upstream/kiro/constants"
import { Kiro_Upstream_Provider } from "../upstream/kiro"
import { Copilot_Upstream_Provider } from "../upstream/copilot"
import { readProviderConfig, resolveProviderMode, type ProviderMode } from "./provider-config"

export async function bootstrapRuntime(options?: RuntimeOptions & { providerMode?: ProviderMode; providerConfigPath?: string }) {
  const configMode = options?.providerMode ? undefined : await readProviderConfig(options?.providerConfigPath)
  const providerMode = options?.providerMode ?? resolveProviderMode(process.env.UPSTREAM_PROVIDER, configMode)
  const isCopilot = providerMode === "copilot"
  const isKiro = providerMode === "kiro"

  if (isCopilot) {
    const authFile = options?.authFile ?? process.env.COPILOT_AUTH_FILE ?? path.join(appDataDir(), COPILOT_AUTH_FILE_NAME)
    const authAccount = options?.authAccount ?? process.env.COPILOT_AUTH_ACCOUNT
    const ensuredAuthFile = await ensureCopilotAuthFile(authFile)
    const upstream = await Copilot_Upstream_Provider.fromAuthFile(ensuredAuthFile, { authAccount })
    const registry = new Provider_Registry()

    registry.register(new Claude_Copilot_Inbound_Adapter(() => upstream.listModels()))
    registry.register(new OpenAI_Copilot_Inbound_Adapter())

    return {
      authFile: ensuredAuthFile,
      authAccount,
      registry,
      upstream,
    }
  }

  if (isKiro) {
    const authAccount = options?.authAccount ?? process.env.KIRO_AUTH_ACCOUNT
    const requestedAuthFile = expandHome(options?.authFile ?? process.env.KIRO_AUTH_FILE ?? KIRO_AUTH_TOKEN_PATH)
    const runtimeAuthFile = options?.authFile ? requestedAuthFile : path.join(appDataDir(), KIRO_STATE_FILE_NAME)
    const ensuredAuthFile = await ensureKiroAuthFile(runtimeAuthFile)
    const upstream = await Kiro_Upstream_Provider.fromAuthFile(ensuredAuthFile, { authAccount })
    const registry = new Provider_Registry()
    registry.register(new Claude_Kiro_Inbound_Adapter(() => upstream.listModels()))
    registry.register(new OpenAI_Kiro_Inbound_Adapter())

    return {
      authFile: ensuredAuthFile,
      authAccount,
      registry,
      upstream,
    }
  }

  const authFile = options?.authFile ?? (process.env.CODEX_AUTH_FILE ? resolveAuthFile(process.env.CODEX_AUTH_FILE) : providerStatePath())
  const authAccount = options?.authAccount ?? process.env.CODEX_AUTH_ACCOUNT
  await ensureCodexAuthFile(authFile)
  const upstream = await Codex_Upstream_Provider.fromAuthFile(authFile, { authAccount })
  const registry = new Provider_Registry()

  registry.register(new Claude_Codex_Inbound_Adapter(() => upstream.listModels()))
  registry.register(new OpenAI_Inbound_Provider({ expectedUpstreamKind: "codex" }))

  return {
    authFile,
    authAccount,
    registry,
    upstream,
  }
}
