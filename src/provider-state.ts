import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { ProviderName } from "./llm-connect/factory"
import { appDataDir, ensureParentDir } from "./paths"

const STATE_FILE_NAME = ".provider.json"

interface ProviderState {
  provider: ProviderName
  kiroAccount?: string
}

function stateFilePath() {
  return path.join(appDataDir(), STATE_FILE_NAME)
}

export async function readProviderState(): Promise<ProviderState | undefined> {
  try {
    const data = JSON.parse(await readFile(stateFilePath(), "utf8")) as Partial<ProviderState>
    if (data.provider === "codex" || data.provider === "kiro") {
      return { provider: data.provider, kiroAccount: typeof data.kiroAccount === "string" ? data.kiroAccount : undefined }
    }
    return undefined
  } catch {
    return undefined
  }
}

export async function writeProviderState(state: ProviderState): Promise<void> {
  const filePath = stateFilePath()
  await ensureParentDir(filePath)
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`)
}
