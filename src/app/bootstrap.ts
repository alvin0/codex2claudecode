import { pathExists } from "../core/bun-fs"
import { bunPath as path } from "../core/paths"
import { appDataDir, expandHome, resolveAuthFile } from "../core/paths"
import { Provider_Registry } from "../core/registry"
import type { RuntimeOptions } from "../core/types"
import { Claude_Codex_Inbound_Adapter } from "../inbound/claude/codex"
import { Claude_Kiro_Inbound_Adapter } from "../inbound/claude/kiro"
import { OpenAI_Inbound_Provider } from "../inbound/openai"
import { Codex_Upstream_Provider } from "../upstream/codex"
import { KIRO_AUTH_TOKEN_PATH, KIRO_STATE_FILE_NAME } from "../upstream/kiro/constants"
import { Kiro_Upstream_Provider } from "../upstream/kiro"
import { readProviderConfig, resolveProviderMode, type ProviderMode } from "./provider-config"

export async function bootstrapRuntime(options?: RuntimeOptions & { providerMode?: ProviderMode; providerConfigPath?: string }) {
  const configMode = options?.providerMode ? undefined : await readProviderConfig(options?.providerConfigPath)
  const providerMode = options?.providerMode ?? resolveProviderMode(process.env.UPSTREAM_PROVIDER, configMode)
  const isKiro = providerMode === "kiro"

  if (isKiro) {
    const authAccount = options?.authAccount ?? process.env.KIRO_AUTH_ACCOUNT
    const requestedAuthFile = expandHome(options?.authFile ?? process.env.KIRO_AUTH_FILE ?? KIRO_AUTH_TOKEN_PATH)
    const fallbackAuthFile = expandHome(process.env.KIRO_AUTH_FILE ?? KIRO_AUTH_TOKEN_PATH)
    const upstreamAuthFile = await fileExists(requestedAuthFile) ? requestedAuthFile : fallbackAuthFile
    const upstream = await Kiro_Upstream_Provider.fromAuthFile(upstreamAuthFile, { authAccount })
    const runtimeAuthFile = options?.authFile ? requestedAuthFile : path.join(appDataDir(), KIRO_STATE_FILE_NAME)
    const registry = new Provider_Registry()
    registry.register(new Claude_Kiro_Inbound_Adapter(() => upstream.listModels()))

    return {
      authFile: runtimeAuthFile,
      authAccount,
      registry,
      upstream,
    }
  }

  const authFile = resolveAuthFile(options?.authFile ?? process.env.CODEX_AUTH_FILE)
  const authAccount = options?.authAccount ?? process.env.CODEX_AUTH_ACCOUNT
  const upstream = await Codex_Upstream_Provider.fromAuthFile(authFile, { authAccount })
  const registry = new Provider_Registry()

  registry.register(new Claude_Codex_Inbound_Adapter())
  registry.register(new OpenAI_Inbound_Provider())

  return {
    authFile,
    authAccount,
    registry,
    upstream,
  }
}

async function fileExists(file: string) {
  return pathExists(file)
}
