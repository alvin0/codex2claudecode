import { pathExists } from "../../core/bun-fs"
import { expandHome } from "../../core/paths"
import { KIRO_AUTH_TOKEN_CLI_PATH, KIRO_AUTH_TOKEN_PATH } from "./constants"

// Default Kiro IDE auth token caches, in priority order. The desktop cache is
// preferred, with the CLI cache (`kiro-auth-token-cli.json`) used as a fallback
// so accounts logged in through the Kiro CLI are discovered automatically.
const DEFAULT_KIRO_SOURCE_PATHS = [KIRO_AUTH_TOKEN_PATH, KIRO_AUTH_TOKEN_CLI_PATH]

/**
 * Returns the candidate Kiro source auth files in priority order.
 * An explicit `KIRO_AUTH_FILE` override takes precedence over the defaults.
 */
export function kiroSourceAuthCandidates(env: Record<string, string | undefined> = process.env): string[] {
  if (env.KIRO_AUTH_FILE) return [expandHome(env.KIRO_AUTH_FILE)]
  return DEFAULT_KIRO_SOURCE_PATHS.map((candidate) => expandHome(candidate))
}

/**
 * Returns the candidate Kiro source auth files that currently exist on disk,
 * in priority order.
 */
export async function existingKiroSourceAuthFiles(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const existing: string[] = []
  for (const candidate of kiroSourceAuthCandidates(env)) {
    if (await pathExists(candidate)) existing.push(candidate)
  }
  return existing
}

/**
 * Resolves the Kiro source auth file to read from: the first existing candidate,
 * falling back to the highest-priority candidate when none exist yet so error
 * messages point at the expected default location.
 */
export async function resolveKiroSourceAuthFile(env: Record<string, string | undefined> = process.env): Promise<string> {
  const candidates = kiroSourceAuthCandidates(env)
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate
  }
  return candidates[0]
}
