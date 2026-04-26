import { errorCode, readTextFile, writeTextFile } from "../core/bun-fs"
import { appDataDir } from "../core/paths"
import { bunPath as path } from "../core/paths"

export type ProviderMode = "codex" | "kiro"

export interface ProviderConfigFile {
  provider: ProviderMode
  [key: string]: unknown
}

export const PROVIDER_CONFIG_PATH = path.join(appDataDir(), "provider-config.json")

export async function readProviderConfig(configPath?: string): Promise<ProviderMode> {
  const resolvedPath = configPath ?? PROVIDER_CONFIG_PATH
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
  if (provider === "codex" || provider === "kiro") return provider

  console.warn(`Warning: unrecognized provider "${String(provider)}" in ${resolvedPath}, defaulting to codex`)
  return "codex"
}

export async function writeProviderConfig(mode: ProviderMode, configPath?: string): Promise<void> {
  const resolvedPath = configPath ?? PROVIDER_CONFIG_PATH
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

export function resolveProviderMode(envVar?: string, configMode?: ProviderMode): ProviderMode {
  if (envVar) return envVar === "kiro" ? "kiro" : "codex"
  return configMode ?? "codex"
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
