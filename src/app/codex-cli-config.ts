import { pathExists, readTextFile, removePath, writeTextFile } from "../core/bun-fs"
import { bunPath as path, expandHome } from "../core/paths"
import {
  CODEX_CLI_API_KEY_ENV,
  CODEX_CLI_CONFIG_FILE,
  codexGatewayBaseUrl,
  mergeCodexCliConfig,
  type CodexCliConfigOptions,
} from "../inbound/openai/export-config-codex"

export interface WriteCodexCliConfigOptions extends CodexCliConfigOptions {
  path?: string
}

export interface WriteCodexCliConfigResult {
  path: string
  backupPath?: string
  contents: string
  clearedModelsCache?: boolean
}

/**
 * Codex keeps one `models_cache.json` per CODEX_HOME, not one per provider, so a
 * catalog fetched for any provider blocks every other provider until it expires.
 * Dropping it makes the next session ask this gateway for its models.
 */
export async function clearCodexModelsCache(configPath: string) {
  const cachePath = path.join(path.dirname(configPath), "models_cache.json")
  if (!(await pathExists(cachePath))) return false
  await removePath(cachePath, { force: true })
  return true
}

/**
 * Points the Codex CLI at this gateway by merging managed blocks into
 * `~/.codex/config.toml`. The file is backed up first, and everything the setup
 * adds is delimited by markers so a later run replaces it instead of stacking.
 */
export async function writeCodexCliConfig(options: WriteCodexCliConfigOptions = {}): Promise<WriteCodexCliConfigResult> {
  const configPath = expandHome(options.path ?? CODEX_CLI_CONFIG_FILE)
  const existing = (await pathExists(configPath)) ? await readTextFile(configPath) : ""

  let backupPath: string | undefined
  if (existing) {
    backupPath = `${configPath}.codex2claudecode.bak`
    await writeTextFile(backupPath, existing)
  }

  const contents = mergeCodexCliConfig(existing, options)
  await writeTextFile(configPath, contents)
  const clearedModelsCache = await clearCodexModelsCache(configPath)

  return { path: configPath, ...(backupPath ? { backupPath } : {}), contents, clearedModelsCache }
}

/** `--setup-codex-cli`: point the local Codex CLI at this gateway and report how to use it. */
export async function setupCodexCli(options: { port?: number; path?: string; makeDefault?: boolean } = {}) {
  const port = options.port ?? Number(process.env.PORT || 8787)
  const result = await writeCodexCliConfig({
    baseUrl: codexGatewayBaseUrl(`http://127.0.0.1:${port}`),
    ...(options.makeDefault ? { makeDefault: true } : {}),
    ...(options.path ? { path: options.path } : {}),
  })

  console.log(`Updated ${result.path}`)
  if (result.backupPath) console.log(`Backup: ${result.backupPath}`)
  if (result.clearedModelsCache) console.log(`Cleared models_cache.json so Codex asks this gateway for its catalog`)
  console.log()
  console.log(`export ${CODEX_CLI_API_KEY_ENV}=codex2claudecode`)
  if (options.makeDefault) {
    console.log(`codex   # this gateway is now the default provider`)
  } else {
    console.log(`codex                                  # unchanged: the real Codex models`)
    console.log(`codex -c model_provider=codex2claude   # this gateway: codex2claude-<model>`)
    console.log()
    console.log(`Add --make-default to route plain 'codex' through the gateway instead.`)
  }

  return result
}
