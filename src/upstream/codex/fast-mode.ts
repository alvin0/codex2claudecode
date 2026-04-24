import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { ensureParentDir, resolveAuthFile } from "../../core/paths"

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
    const parsed = JSON.parse(await readFile(codexConfigPath(authFile), "utf8")) as CodexConfigFile
    return { enabled: parsed.fastMode?.enabled === true }
  } catch {
    return { enabled: false }
  }
}

export async function writeCodexFastModeConfig(authFile: string | undefined, config: CodexFastModeConfig) {
  const file = codexConfigPath(authFile)
  const current = await readCodexConfigFile(authFile)
  await ensureParentDir(file)
  await writeFile(file, `${JSON.stringify({ ...current, fastMode: { enabled: config.enabled } }, null, 2)}\n`)
}

async function readCodexConfigFile(authFile?: string): Promise<CodexConfigFile> {
  try {
    const parsed = JSON.parse(await readFile(codexConfigPath(authFile), "utf8")) as CodexConfigFile
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
