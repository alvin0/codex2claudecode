import { resolveAuthFile } from "../paths"
import { resolveKiroCredsFile } from "./kiro/credentials"

import { CodexProvider } from "./codex-provider"
import { KiroProvider } from "./kiro-provider"
import type { LlmProvider } from "./provider"

export type ProviderName = "codex" | "kiro"

export interface ProviderConfig {
  /** Which backend to use. Defaults to auto-detect. */
  provider?: ProviderName
  /** Codex auth file path. */
  authFile?: string
  /** Codex auth account selector. */
  authAccount?: string
  /** Kiro credentials file path. */
  kiroCredsFile?: string
  /** Kiro account key (profileArn, clientIdHash, or name) to select from multi-account file. */
  kiroAccount?: string
}

/**
 * Create the appropriate LlmProvider based on configuration.
 *
 * Resolution order:
 * 1. Explicit `provider` option
 * 2. `LLM_PROVIDER` env var
 * 3. Auto-detect: if Kiro creds exist → kiro, otherwise → codex
 */
export async function createProvider(config: ProviderConfig = {}): Promise<LlmProvider> {
  const name = resolveProviderName(config)

  if (name === "kiro") {
    return KiroProvider.create({ credsFile: config.kiroCredsFile, account: config.kiroAccount })
  }

  const authFile = resolveAuthFile(config.authFile)
  return CodexProvider.create(authFile, { authAccount: config.authAccount })
}

function envVar(name: string): string | undefined {
  const bun = (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun
  if (bun?.env) return bun.env[name]
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.[name]
}

function resolveProviderName(config: ProviderConfig): ProviderName {
  if (config.provider) return config.provider
  const env = envVar("LLM_PROVIDER")?.toLowerCase()
  if (env === "kiro" || env === "codex") return env
  return "codex"
}

/**
 * Auto-detect which provider to use based on available credentials.
 * Useful when no explicit provider is set.
 */
export async function detectProvider(config: ProviderConfig = {}): Promise<ProviderName> {
  if (config.provider) return config.provider
  const env = envVar("LLM_PROVIDER")?.toLowerCase()
  if (env === "kiro" || env === "codex") return env

  // Check if Kiro creds exist
  const kiroFile = await resolveKiroCredsFile(config.kiroCredsFile)
  if (kiroFile) return "kiro"

  return "codex"
}
