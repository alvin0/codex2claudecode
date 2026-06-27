import { atomicJsonWrite, readTextFile } from "../../core/bun-fs"
import { appDataDir } from "../../core/paths"
import { bunPath as path } from "../../core/paths"
import { COPILOT_CACHE_FILE_NAME } from "./constants"
import type { CopilotCacheFile, CopilotModelCacheEntry, CopilotTokenCacheEntry } from "./types"

export function copilotCacheFilePath(filePath?: string) {
  const resolved = filePath ?? path.join(appDataDir(), COPILOT_CACHE_FILE_NAME)
  return resolved
}

export async function readCopilotCacheFile(filePath?: string): Promise<CopilotCacheFile> {
  const resolved = copilotCacheFilePath(filePath)
  try {
    const parsed = JSON.parse(await readTextFile(resolved)) as Partial<CopilotCacheFile>
    return normalizeCopilotCacheFile(parsed)
  } catch {
    return { tokens: {}, models: {} }
  }
}

export async function writeCopilotCacheFile(file: CopilotCacheFile, filePath?: string) {
  await atomicJsonWrite(copilotCacheFilePath(filePath), normalizeCopilotCacheFile(file), { mode: 0o600 })
}

export async function readCopilotTokenCache(accountKey: string, filePath?: string): Promise<CopilotTokenCacheEntry | undefined> {
  const file = await readCopilotCacheFile(filePath)
  return file.tokens[accountKey]
}

export async function writeCopilotTokenCache(accountKey: string, entry: CopilotTokenCacheEntry, filePath?: string) {
  const file = await readCopilotCacheFile(filePath)
  file.tokens[accountKey] = entry
  await writeCopilotCacheFile(file, filePath)
}

export async function readCopilotModelCache(accountKey: string, filePath?: string): Promise<CopilotModelCacheEntry | undefined> {
  const file = await readCopilotCacheFile(filePath)
  return file.models[accountKey]
}

export async function writeCopilotModelCache(accountKey: string, entry: CopilotModelCacheEntry, filePath?: string) {
  const file = await readCopilotCacheFile(filePath)
  file.models[accountKey] = entry
  await writeCopilotCacheFile(file, filePath)
}

function normalizeCopilotCacheFile(value: Partial<CopilotCacheFile> | undefined): CopilotCacheFile {
  return {
    tokens: value?.tokens && typeof value.tokens === "object" && !Array.isArray(value.tokens) ? value.tokens : {},
    models: value?.models && typeof value.models === "object" && !Array.isArray(value.models) ? value.models : {},
  }
}
