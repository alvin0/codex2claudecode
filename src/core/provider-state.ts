import { atomicJsonWrite, pathExists, readTextFile } from "./bun-fs"
import { appDataDir, bunPath as path, expandHome } from "./paths"

export type ProviderMode = "codex" | "kiro" | "copilot"

export const PROVIDER_STATE_FILE_NAME = "provider-state.json"
export const PROVIDER_CACHE_FILE_NAME = "provider-cache.json"

export const PROVIDER_STATE_PATH = path.join(appDataDir(), PROVIDER_STATE_FILE_NAME)
export const PROVIDER_CACHE_PATH = path.join(appDataDir(), PROVIDER_CACHE_FILE_NAME)

export interface ProviderStateSection<T = unknown> {
  activeAccount?: string
  data?: T
  [key: string]: unknown
}

export interface ProviderStateFile {
  provider?: ProviderMode
  codex?: ProviderStateSection
  kiro?: ProviderStateSection
  copilot?: ProviderStateSection
  [key: string]: unknown
}

const writeQueues = new Map<string, Promise<void>>()

export function providerStatePath(filePath?: string) {
  return filePath ? expandHome(filePath) : path.join(appDataDir(), PROVIDER_STATE_FILE_NAME)
}

export function providerCachePath(filePath?: string) {
  return filePath ? expandHome(filePath) : path.join(appDataDir(), PROVIDER_CACHE_FILE_NAME)
}

export function isProviderStatePath(filePath: string) {
  return fileName(expandHome(filePath)) === PROVIDER_STATE_FILE_NAME
}

export function isProviderCachePath(filePath: string) {
  return fileName(expandHome(filePath)) === PROVIDER_CACHE_FILE_NAME
}

export async function readProviderStateFile(filePath?: string): Promise<ProviderStateFile> {
  const resolved = providerStatePath(filePath)
  if (!(await pathExists(resolved))) return {}

  const parsed = JSON.parse(await readTextFile(resolved)) as unknown
  return normalizeProviderStateFile(parsed, resolved)
}

export async function writeProviderStateFile(state: ProviderStateFile, filePath?: string) {
  const resolved = providerStatePath(filePath)
  await queueWrite(resolved, () => atomicJsonWrite(resolved, normalizeProviderStateFile(state, resolved), { mode: 0o600 }))
}

export async function updateProviderStateFile(filePath: string | undefined, updater: (state: ProviderStateFile) => ProviderStateFile | Promise<ProviderStateFile>) {
  const resolved = providerStatePath(filePath)
  await queueWrite(resolved, async () => {
    const next = await updater(await readProviderStateFile(resolved))
    await atomicJsonWrite(resolved, normalizeProviderStateFile(next, resolved), { mode: 0o600 })
  })
}

export async function readProviderSection<T = unknown>(mode: ProviderMode, filePath?: string): Promise<ProviderStateSection<T> | undefined> {
  const state = await readProviderStateFile(filePath)
  const section = state[mode]
  return normalizeProviderSection<T>(section, mode, providerStatePath(filePath))
}

export async function writeProviderSection<T = unknown>(mode: ProviderMode, section: ProviderStateSection<T>, filePath?: string) {
  await updateProviderStateFile(filePath, async (state) => {
    state[mode] = normalizeProviderSection(section, mode, providerStatePath(filePath)) ?? { data: section.data }
    return state
  })
}

export async function updateProviderSection<T = unknown>(
  mode: ProviderMode,
  filePath: string | undefined,
  updater: (section: ProviderStateSection<T> | undefined) => ProviderStateSection<T> | Promise<ProviderStateSection<T>> | undefined | Promise<undefined>,
) {
  await updateProviderStateFile(filePath, async (state) => {
    const nextSection = await updater(normalizeProviderSection<T>(state[mode], mode, providerStatePath(filePath)))
    if (nextSection === undefined) {
      delete state[mode]
      return state
    }
    state[mode] = normalizeProviderSection(nextSection, mode, providerStatePath(filePath)) ?? nextSection
    return state
  })
}

async function queueWrite(file: string, task: () => Promise<void>) {
  const current = writeQueues.get(file) ?? Promise.resolve()
  const chain = current.then(task)
  const next = chain.finally(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file)
  })
  writeQueues.set(file, next)
  return next
}

function normalizeProviderStateFile(value: unknown, filePath: string): ProviderStateFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Provider state file ${filePath} must contain a JSON object`)
  }
  return value as ProviderStateFile
}

function normalizeProviderSection<T = unknown>(value: unknown, mode: ProviderMode, filePath: string): ProviderStateSection<T> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Provider state file ${filePath} has invalid ${mode} section`)
  }
  return value as ProviderStateSection<T>
}

function fileName(filePath: string) {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1)
}
