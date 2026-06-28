import { appDataDir, expandHome, resolveAuthFile, bunPath as path } from "../core/paths"
import type { Upstream_Provider } from "../core/interfaces"
import { providerStatePath, type ProviderMode } from "../core/provider-state"
import { Copilot_Upstream_Provider } from "../upstream/copilot"
import { ensureCopilotAuthFile } from "../upstream/copilot/account-store"
import { COPILOT_AUTH_FILE_NAME } from "../upstream/copilot/constants"
import { Codex_Upstream_Provider } from "../upstream/codex"
import { ensureCodexAuthFile } from "../upstream/codex/account-info"
import { readAuthFileData } from "../upstream/codex/auth"
import { Kiro_Upstream_Provider } from "../upstream/kiro"
import { ensureKiroAuthFile } from "../upstream/kiro/account-store"
import { kiroAuthEntries, readKiroAuthFileData } from "../upstream/kiro/account-store"
import { KIRO_AUTH_TOKEN_PATH, KIRO_STATE_FILE_NAME } from "../upstream/kiro/constants"
import { copilotAuthEntries, readCopilotAuthFileData } from "../upstream/copilot/account-store"

export interface ProviderRuntimeOptions {
  authFile?: string
  authAccount?: string
}

export interface ProviderRuntimeResult {
  authFile: string
  authAccount?: string
  upstream: Upstream_Provider
}

export function resolveProviderAuthFile(mode: ProviderMode, options?: ProviderRuntimeOptions) {
  if (mode === "codex") {
    return options?.authFile ? expandHome(options.authFile) : process.env.CODEX_AUTH_FILE ? resolveAuthFile(process.env.CODEX_AUTH_FILE) : providerStatePath()
  }

  if (mode === "kiro") {
    return options?.authFile ? expandHome(options.authFile) : path.join(appDataDir(), KIRO_STATE_FILE_NAME)
  }

  return options?.authFile ? expandHome(options.authFile) : process.env.COPILOT_AUTH_FILE ?? path.join(appDataDir(), COPILOT_AUTH_FILE_NAME)
}

export function resolveProviderAuthAccount(mode: ProviderMode, options?: ProviderRuntimeOptions) {
  if (mode === "codex") return options?.authAccount ?? process.env.CODEX_AUTH_ACCOUNT
  if (mode === "kiro") return options?.authAccount ?? process.env.KIRO_AUTH_ACCOUNT
  return options?.authAccount ?? process.env.COPILOT_AUTH_ACCOUNT
}

export async function createProviderRuntime(mode: ProviderMode, options?: ProviderRuntimeOptions): Promise<ProviderRuntimeResult> {
  const authAccount = resolveProviderAuthAccount(mode, options)

  if (mode === "copilot") {
    const authFile = resolveProviderAuthFile(mode, options)
    const ensuredAuthFile = await ensureCopilotAuthFile(authFile)
    const upstream = await Copilot_Upstream_Provider.fromAuthFile(ensuredAuthFile, { authAccount })
    return { authFile: ensuredAuthFile, authAccount, upstream }
  }

  if (mode === "kiro") {
    const authFile = resolveProviderAuthFile(mode, options)
    const ensuredAuthFile = await ensureKiroAuthFile(authFile)
    const upstream = await Kiro_Upstream_Provider.fromAuthFile(ensuredAuthFile, { authAccount })
    return { authFile: ensuredAuthFile, authAccount, upstream }
  }

  const authFile = resolveProviderAuthFile(mode, options)
  await ensureCodexAuthFile(authFile)
  const upstream = await Codex_Upstream_Provider.fromAuthFile(authFile, { authAccount })
  return { authFile, authAccount, upstream }
}

export async function providerHasConnectedAccounts(mode: ProviderMode, options?: ProviderRuntimeOptions) {
  const authFile = resolveProviderAuthFile(mode, options)

  try {
    if (mode === "codex") {
      const data = await readAuthFileData(authFile)
      return Array.isArray(data.data) ? data.data.length > 0 : Boolean(data.data)
    }
    if (mode === "kiro") {
      const data = await readKiroAuthFileData(authFile)
      return kiroAuthEntries(data).length > 0
    }
    const data = await readCopilotAuthFileData(authFile)
    return copilotAuthEntries(data).length > 0
  } catch {
    return false
  }
}
