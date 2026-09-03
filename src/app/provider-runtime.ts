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
import { readAccountRoster } from "./account-roster"
import { readRotationConfig } from "./rotation-config"
import { Rotating_Upstream_Provider } from "./rotating-upstream"

export interface ProviderRuntimeOptions {
  authFile?: string
  authAccount?: string
  rotateAccounts?: boolean
  /**
   * Whether a `degrade` outcome escalates to a 400, handed to every provider this module
   * constructs.
   *
   * A plain boolean, never an environment read: `src/app/bootstrap.ts` calls
   * `readNativeFlags()` once and passes the resolved value here, so `NATIVE_STRICT` has exactly
   * one reader (design decision D3). Omitted means off, which is the behavior every caller had
   * before the flag existed.
   */
  strict?: boolean
  /**
   * Whether the Kiro web-search heuristics run — `KIRO_WEB_SEARCH_HEURISTICS`, resolved once by
   * `readNativeFlags()` in `src/app/bootstrap.ts` and threaded through here exactly as `strict`
   * is (design decision D3). Consumed only by the `kiro` branch below, because only the Kiro
   * provider ever had these heuristics; the other two providers are handed nothing. Omitted
   * means off, which is the native-mode default (Requirements 17.3, 17.4).
   */
  kiroWebSearchHeuristics?: boolean
  /**
   * Whether an upstream declaring `mcpToolset: "emulate"` may emulate a client-declared MCP toolset
   * — `NATIVE_MCP_EMULATION`, resolved once by `readNativeFlags()` in `src/app/bootstrap.ts` and
   * threaded through here exactly as `strict` is (design decision D3). Consumed only by the `kiro`
   * branch below: Codex forwards MCP toolsets natively and takes zero emulation paths
   * (Requirement 22.9), and Copilot declares no emulation either, so neither is handed the flag.
   * Omitted means off, and off keeps the existing 400 for an MCP-bearing Kiro request
   * (Requirement 22.5).
   */
  mcpEmulation?: boolean
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
    const create = (account?: string) => Copilot_Upstream_Provider.fromAuthFile(ensuredAuthFile, { authAccount: account, strict: options?.strict })
    const upstream = await withAccountRotation(mode, ensuredAuthFile, authAccount, options, create)
    return { authFile: ensuredAuthFile, authAccount, upstream }
  }

  if (mode === "kiro") {
    const authFile = resolveProviderAuthFile(mode, options)
    const ensuredAuthFile = await ensureKiroAuthFile(authFile)
    const create = (account?: string) => Kiro_Upstream_Provider.fromAuthFile(ensuredAuthFile, { authAccount: account, strict: options?.strict, webSearchHeuristics: options?.kiroWebSearchHeuristics, mcpEmulation: options?.mcpEmulation })
    const upstream = await withAccountRotation(mode, ensuredAuthFile, authAccount, options, create)
    return { authFile: ensuredAuthFile, authAccount, upstream }
  }

  const authFile = resolveProviderAuthFile(mode, options)
  await ensureCodexAuthFile(authFile)
  const create = (account?: string) => Codex_Upstream_Provider.fromAuthFile(authFile, { authAccount: account, strict: options?.strict })
  const upstream = await withAccountRotation(mode, authFile, authAccount, options, create)
  return { authFile, authAccount, upstream }
}

/**
 * Installs the rotating wrapper whenever the provider has several accounts, so the
 * rotation screen can turn it on and off without restarting the runtime. The stored
 * setting only decides whether it starts enabled.
 */
async function withAccountRotation(
  mode: ProviderMode,
  authFile: string,
  authAccount: string | undefined,
  options: ProviderRuntimeOptions | undefined,
  create: (account?: string) => Promise<Upstream_Provider>,
): Promise<Upstream_Provider> {
  const upstream = await create(authAccount)

  const roster = await readAccountRoster(mode, authFile).catch(() => undefined)
  if (!roster || roster.accounts.length < 2) return upstream

  const enabled = options?.rotateAccounts ?? (await readRotationConfig(mode)).enabled
  const active = authAccount ?? roster.activeAccount ?? roster.accounts[0]!
  return Rotating_Upstream_Provider.create({ mode, roster, enabled, create: (account) => create(account) }, active, upstream)
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
