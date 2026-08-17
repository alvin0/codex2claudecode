import { pathExists, readTextFile, writeTextFile } from "../core/bun-fs"
import { providerCachePath, type ProviderMode } from "../core/provider-state"
import type { AccountCooldownMap } from "../core/rotation"

interface CooldownCacheFile {
  [mode: string]: { accountCooldowns?: AccountCooldownMap } | undefined
}

let writeQueue: Promise<unknown> = Promise.resolve()

/**
 * Cooldowns live in `provider-cache.json`, not in the auth state: they are runtime
 * observations that must survive a restart but must never travel with credentials.
 */
export async function readAccountCooldowns(mode: ProviderMode, filePath?: string): Promise<AccountCooldownMap> {
  return (await readCacheFile(filePath))[mode]?.accountCooldowns ?? {}
}

export async function writeAccountCooldowns(mode: ProviderMode, cooldowns: AccountCooldownMap, filePath?: string) {
  const path = providerCachePath(filePath)
  const run = writeQueue.then(async () => {
    const file = await readCacheFile(filePath)
    const next: CooldownCacheFile = {
      ...file,
      [mode]: { ...file[mode], accountCooldowns: Object.keys(cooldowns).length ? cooldowns : undefined },
    }
    await writeTextFile(path, `${JSON.stringify(next, null, 2)}\n`)
  })

  writeQueue = run.catch(() => undefined)
  return run
}

async function readCacheFile(filePath?: string): Promise<CooldownCacheFile> {
  const path = providerCachePath(filePath)
  if (!(await pathExists(path))) return {}
  try {
    const parsed = JSON.parse(await readTextFile(path)) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as CooldownCacheFile) : {}
  } catch {
    return {}
  }
}
