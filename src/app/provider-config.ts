import { errorCode, pathExists, readTextFile, removePath, writeTextFile } from "../core/bun-fs"
import { appDataDir } from "../core/paths"
import { providerStatePath, readProviderStateFile, updateProviderStateFile, isProviderStatePath, type ProviderMode } from "../core/provider-state"
import { bunPath as path } from "../core/paths"

export interface ProviderConfigFile {
  provider: ProviderMode
  [key: string]: unknown
}

export type { ProviderMode } from "../core/provider-state"

export const PROVIDER_CONFIG_PATH = providerStatePath()

function defaultProviderConfigPath() {
  return providerStatePath()
}

export async function readProviderConfig(configPath?: string): Promise<ProviderMode> {
  const resolvedPath = configPath ?? defaultProviderConfigPath()
  if (isProviderStatePath(resolvedPath)) {
    try {
      const state = await readProviderStateFile(resolvedPath)
      if (state.provider === "codex" || state.provider === "kiro" || state.provider === "copilot") return state.provider
      const legacyProvider = await readLegacyProviderConfig(path.dirname(resolvedPath))
      if (legacyProvider) {
        await updateProviderStateFile(resolvedPath, async (current) => {
          current.provider = legacyProvider
          return current
        })
        await cleanupLegacyProviderConfig(path.dirname(resolvedPath))
        return legacyProvider
      }
    } catch (error) {
      console.warn(`Warning: failed to read provider config at ${resolvedPath}: ${errorMessage(error)}`)
      return "codex"
    }
    return "codex"
  }

  let content: string

  try {
    content = await readTextFile(resolvedPath)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "codex"
    console.warn(`Warning: failed to read provider config at ${resolvedPath}: ${errorMessage(error)}`)
    return "codex"
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    console.warn(`Warning: invalid JSON in provider config at ${resolvedPath}: ${errorMessage(error)}`)
    return "codex"
  }

  const provider = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { provider?: unknown }).provider : undefined
  if (provider === "codex" || provider === "kiro" || provider === "copilot") return provider

  console.warn(`Warning: unrecognized provider "${String(provider)}" in ${resolvedPath}, defaulting to codex`)
  return "codex"
}

export async function writeProviderConfig(mode: ProviderMode, configPath?: string): Promise<void> {
  const resolvedPath = configPath ?? defaultProviderConfigPath()
  if (isProviderStatePath(resolvedPath)) {
    await updateProviderStateFile(resolvedPath, async (state) => {
      state.provider = mode
      return state
    })
    await cleanupLegacyProviderConfig(path.dirname(resolvedPath))
    return
  }

  let existing: Record<string, unknown> = {}

  try {
    const content = await readTextFile(resolvedPath)
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>
  } catch (error) {
    if (errorCode(error) !== "ENOENT") existing = {}
  }

  existing.provider = mode

  try {
    await writeTextFile(resolvedPath, `${JSON.stringify(existing, null, 2)}\n`)
  } catch (error) {
    console.warn(`Warning: failed to write provider config to ${resolvedPath}: ${errorMessage(error)}`)
  }
}

async function readLegacyProviderConfig(dir: string): Promise<ProviderMode | undefined> {
  for (const name of ["provider-config.json", ".provider.json"]) {
    const file = path.join(dir, name)
    if (!(await pathExists(file))) continue
    try {
      const parsed = JSON.parse(await readTextFile(file))
      const provider = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { provider?: unknown }).provider : undefined
      if (provider === "codex" || provider === "kiro" || provider === "copilot") return provider
    } catch {
      continue
    }
  }
  return undefined
}

async function cleanupLegacyProviderConfig(dir: string) {
  for (const name of ["provider-config.json", ".provider.json"]) {
    await removePath(path.join(dir, name), { force: true }).catch(() => {})
  }
}

export function resolveProviderMode(envVar?: string, configMode?: ProviderMode): ProviderMode {
  if (envVar) return envVar === "kiro" || envVar === "copilot" ? envVar : "codex"
  return configMode ?? "codex"
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
