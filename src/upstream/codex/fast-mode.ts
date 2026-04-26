import { readTextFile, writeTextFile } from "../../core/bun-fs"
import { resolveAuthFile } from "../../core/paths"
import { bunPath as path } from "../../core/paths"

export interface CodexFastModeConfig {
  enabled: boolean
}

interface CodexConfigFile {
  fastMode?: CodexFastModeConfig
}

export function codexConfigPath(authFile = resolveAuthFile()) {
  return path.join(path.dirname(authFile), ".codex-config.json")
}

export async function readCodexFastModeConfig(authFile?: string): Promise<CodexFastModeConfig> {
  try {
    const parsed = JSON.parse(await readTextFile(codexConfigPath(authFile))) as CodexConfigFile
    return { enabled: parsed.fastMode?.enabled === true }
  } catch {
    return { enabled: false }
  }
}

export async function writeCodexFastModeConfig(authFile: string | undefined, config: CodexFastModeConfig) {
  const file = codexConfigPath(authFile)
  const current = await readCodexConfigFile(authFile)
  await writeTextFile(file, `${JSON.stringify({ ...current, fastMode: { enabled: config.enabled } }, null, 2)}\n`)
}

async function readCodexConfigFile(authFile?: string): Promise<CodexConfigFile> {
  try {
    const parsed = JSON.parse(await readTextFile(codexConfigPath(authFile))) as CodexConfigFile
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
