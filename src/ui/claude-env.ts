import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { CLAUDE_CODE_ENV_CONFIG, type ClaudeCodeEditableEnvKey } from "../claude-code-env.config"
import { ensureParentDir } from "../paths"

export const CLAUDE_ENV_FIXED = CLAUDE_CODE_ENV_CONFIG.lockedEnv

export const CLAUDE_MODEL_ENV_KEYS = Object.keys(CLAUDE_CODE_ENV_CONFIG.editableEnvDefaults) as ClaudeCodeEditableEnvKey[]

export const CLAUDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  ...Object.keys(CLAUDE_ENV_FIXED),
  ...CLAUDE_MODEL_ENV_KEYS,
] as const

export type ClaudeModelEnvKey = ClaudeCodeEditableEnvKey
export interface ClaudeEnvironmentDraft extends Record<ClaudeModelEnvKey, string> {
  extraEnv: Record<string, string>
  unsetEnv: string[]
}
export type ClaudeSettingsScope = "user" | "project" | "local"
export type ShellKind = "posix" | "powershell"
export type ShellDetection = { kind: ShellKind; name: string } | { kind: "unsupported"; name: string; reason: string }
export interface ClaudeEnvironmentRunOptions {
  authFile?: string
  persist?: boolean
  settingsFile?: string
}

interface ClaudeSettingsFile {
  env?: Record<string, unknown>
  [key: string]: unknown
}

export function defaultClaudeEnvironment(): ClaudeEnvironmentDraft {
  return {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? CLAUDE_CODE_ENV_CONFIG.editableEnvDefaults.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? CLAUDE_CODE_ENV_CONFIG.editableEnvDefaults.ANTHROPIC_DEFAULT_OPUS_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? CLAUDE_CODE_ENV_CONFIG.editableEnvDefaults.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? CLAUDE_CODE_ENV_CONFIG.editableEnvDefaults.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    extraEnv: { ...CLAUDE_CODE_ENV_CONFIG.defaultExtraEnv },
    unsetEnv: [...CLAUDE_CODE_ENV_CONFIG.defaultUnsetEnv],
  }
}

export function claudeEnvironmentConfigPath(authFile: string) {
  return path.join(path.dirname(authFile), ".claude-env.json")
}

export function claudeSettingsPath(file?: string) {
  return file ?? path.join(homedir(), ".claude", "settings.json")
}

export function claudeSettingsPathForScope(scope: ClaudeSettingsScope, cwd = process.cwd()) {
  if (scope === "project") return path.join(cwd, ".claude", "settings.json")
  if (scope === "local") return path.join(cwd, ".claude", "settings.local.json")
  return claudeSettingsPath()
}

export function claudeSettingsScopeLabel(scope: ClaudeSettingsScope) {
  if (scope === "project") return ".claude/settings.json"
  if (scope === "local") return ".claude/settings.local.json"
  return "~/.claude/settings.json"
}

export async function readClaudeEnvironmentConfig(authFile: string): Promise<ClaudeEnvironmentDraft> {
  try {
    return normalizeClaudeEnvironment(JSON.parse(await readFile(claudeEnvironmentConfigPath(authFile), "utf8")) as Partial<ClaudeEnvironmentDraft>)
  } catch {
    return defaultClaudeEnvironment()
  }
}

export async function writeClaudeEnvironmentConfig(authFile: string, draft: ClaudeEnvironmentDraft) {
  await ensureParentDir(claudeEnvironmentConfigPath(authFile))
  await writeFile(claudeEnvironmentConfigPath(authFile), `${JSON.stringify(normalizeClaudeEnvironment(draft), null, 2)}\n`)
}

export function claudeEnvironmentExports(draft: ClaudeEnvironmentDraft, baseUrl: string) {
  return claudeEnvironmentPreviewLines(draft, baseUrl)
}

export function claudeEnvironmentCommands(draft: ClaudeEnvironmentDraft, baseUrl: string, _shell: ShellKind | ShellDetection = detectShell()) {
  return claudeEnvironmentPreviewLines(draft, baseUrl)
}

export function claudeEnvironmentPowerShellCommands(draft: ClaudeEnvironmentDraft, baseUrl: string) {
  return claudeEnvironmentPreviewLines(draft, baseUrl)
}

export function applyClaudeEnvironment(_draft: ClaudeEnvironmentDraft, _baseUrl: string) {
  return
}

export function unsetClaudeEnvironment(_draft: ClaudeEnvironmentDraft = defaultClaudeEnvironment()) {
  return
}

export function claudeEnvironmentUnsetCommands(draft: ClaudeEnvironmentDraft = defaultClaudeEnvironment(), _shell: ShellKind | ShellDetection = detectShell()) {
  return managedEnvironmentKeys(draft).map((key) => `env.${key}`)
}

export async function echoClaudeEnvironment(draft: ClaudeEnvironmentDraft, baseUrl: string, shell: ShellKind | ShellDetection = detectShell()) {
  const output = claudeEnvironmentCommands(draft, baseUrl, shell).join("\n")
  return echoShellOutput(output, shell)
}

export async function runClaudeEnvironmentSet(draft: ClaudeEnvironmentDraft, baseUrl: string, shell: ShellKind | ShellDetection = detectShell(), options?: ClaudeEnvironmentRunOptions) {
  if (options?.persist !== false) await persistClaudeEnvironment(draft, baseUrl, shell, options)
  return appendPersistenceNote(formatManagedEnvironment(managedEnvironmentEntries(draft, baseUrl), options?.settingsFile), options)
}

export async function echoClaudeEnvironmentUnset(draft: ClaudeEnvironmentDraft = defaultClaudeEnvironment(), shell: ShellKind | ShellDetection = detectShell()) {
  const output = claudeEnvironmentUnsetCommands(draft, shell).join("\n")
  return echoShellOutput(output, shell)
}

export async function runClaudeEnvironmentUnset(draft: ClaudeEnvironmentDraft = defaultClaudeEnvironment(), shell: ShellKind | ShellDetection = detectShell(), options?: ClaudeEnvironmentRunOptions) {
  if (options?.persist !== false) await persistClaudeEnvironmentUnset(draft, shell, options)
  return appendPersistenceNote(formatManagedEnvironment([], options?.settingsFile), options)
}

export async function persistClaudeEnvironment(draft: ClaudeEnvironmentDraft, baseUrl: string, _shell: ShellKind | ShellDetection, options?: ClaudeEnvironmentRunOptions) {
  const settings = await readClaudeSettingsFile(options?.settingsFile)
  const nextEnv = {
    ...settings.env,
    ...Object.fromEntries(managedEnvironmentEntries(draft, baseUrl)),
  }
  unsetKeysForSet(draft, baseUrl).forEach((key) => {
    delete nextEnv[key]
  })
  await writeClaudeSettingsFile({ ...settings, env: nextEnv }, options?.settingsFile)
}

export async function persistClaudeEnvironmentUnset(draft: ClaudeEnvironmentDraft = defaultClaudeEnvironment(), _shell: ShellKind | ShellDetection, options?: ClaudeEnvironmentRunOptions) {
  const settings = await readClaudeSettingsFile(options?.settingsFile)
  const nextEnv = { ...settings.env }
  managedEnvironmentKeys(draft).forEach((key) => {
    delete nextEnv[key]
  })
  await writeClaudeSettingsFile({ ...settings, env: nextEnv }, options?.settingsFile)
}

async function echoShellOutput(output: string, shell: ShellKind | ShellDetection) {
  const kind = typeof shell === "string" ? shell : shell.kind
  if (kind === "unsupported") throw new Error(typeof shell === "string" ? "Unsupported shell" : shell.reason)
  return output.trimEnd()
}

export function detectShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform): ShellDetection {
  const override = env.CODEX2CLAUDECODE_SHELL?.toLowerCase()
  if (override === "posix" || override === "powershell") return { kind: override, name: override }
  if (override) return { kind: "unsupported", name: override, reason: `Unsupported shell: ${override}` }
  if (platform === "win32") {
    const processName = (env.PSModulePath || env.POWERSHELL_DISTRIBUTION_CHANNEL ? "powershell" : env.ComSpec || "cmd").toLowerCase()
    if (processName.includes("powershell") || processName.includes("pwsh")) return { kind: "powershell", name: "PowerShell" }
    return { kind: "unsupported", name: "cmd", reason: "Unsupported shell: cmd. Use PowerShell or set CODEX2CLAUDECODE_SHELL=powershell." }
  }
  const shell = (env.SHELL ?? "sh").split("/").pop()?.toLowerCase() ?? "sh"
  if (["sh", "bash", "zsh", "dash", "ksh"].includes(shell)) return { kind: "posix", name: shell }
  return { kind: "unsupported", name: shell, reason: `Unsupported shell: ${shell}. Supported shells: sh, bash, zsh, dash, ksh, PowerShell.` }
}

function normalizeClaudeEnvironment(input: Partial<ClaudeEnvironmentDraft>): ClaudeEnvironmentDraft {
  const defaults = defaultClaudeEnvironment()
  const extraEnv = {
    ...defaults.extraEnv,
    ...normalizeStringMap(input.extraEnv),
  }
  const unsetEnv = [...new Set([...defaults.unsetEnv, ...normalizeStringList(input.unsetEnv)])].filter((key) => !(key in extraEnv))
  return {
    ANTHROPIC_MODEL: input.ANTHROPIC_MODEL ?? defaults.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: input.ANTHROPIC_DEFAULT_OPUS_MODEL ?? defaults.ANTHROPIC_DEFAULT_OPUS_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: input.ANTHROPIC_DEFAULT_SONNET_MODEL ?? defaults.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: input.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? defaults.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    extraEnv,
    unsetEnv,
  }
}

function claudeEnvironmentPreviewLines(draft: ClaudeEnvironmentDraft, baseUrl: string) {
  return [
    `Target file: ${claudeSettingsPath()}`,
    ...managedEnvironmentEntries(draft, baseUrl).map(([key, value]) => `env.${key} = ${JSON.stringify(value)}`),
    ...unsetKeysForSet(draft, baseUrl).map((key) => `delete env.${key}`),
  ]
}

function managedEnvironmentEntries(draft: ClaudeEnvironmentDraft, baseUrl: string): Array<[string, string]> {
  const normalized = normalizeClaudeEnvironment(draft)
  return [
    ["ANTHROPIC_BASE_URL", baseUrl],
    ...Object.entries(CLAUDE_ENV_FIXED),
    ...CLAUDE_MODEL_ENV_KEYS.map((key) => [key, normalized[key]] as [string, string]),
    ...Object.entries(normalized.extraEnv),
  ]
}

function managedEnvironmentKeys(draft: ClaudeEnvironmentDraft) {
  const normalized = normalizeClaudeEnvironment(draft)
  return [...new Set([...CLAUDE_ENV_KEYS, ...Object.keys(normalized.extraEnv), ...normalized.unsetEnv])]
}

function unsetKeysForSet(draft: ClaudeEnvironmentDraft, baseUrl: string) {
  const managedKeys = new Set(managedEnvironmentEntries(draft, baseUrl).map(([key]) => key))
  return normalizeClaudeEnvironment(draft).unsetEnv.filter((key) => !managedKeys.has(key))
}

function normalizeStringMap(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  return Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [key.trim(), value] as const)
      .filter(([key, value]) => key && typeof value === "string"),
  )
}

function normalizeStringList(input: unknown) {
  if (!Array.isArray(input)) return []
  return [...new Set(input.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))]
}

async function readClaudeSettingsFile(file?: string) {
  const settingsFile = claudeSettingsPath(file)
  try {
    const parsed = JSON.parse(await readFile(settingsFile, "utf8")) as ClaudeSettingsFile
    return {
      ...parsed,
      env: normalizeSettingsEnv(parsed.env),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { env: {} } satisfies ClaudeSettingsFile
    }
    throw error
  }
}

async function writeClaudeSettingsFile(settings: ClaudeSettingsFile, file?: string) {
  const settingsFile = claudeSettingsPath(file)
  await ensureParentDir(settingsFile)
  await writeFile(settingsFile, `${JSON.stringify({ ...settings, env: normalizeSettingsEnv(settings.env) }, null, 2)}\n`)
}

function normalizeSettingsEnv(env: unknown) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return {} as Record<string, unknown>
  return { ...env } as Record<string, unknown>
}

function formatManagedEnvironment(entries: Array<[string, string]>, settingsFile?: string) {
  if (!entries.length) return `Updated ${claudeSettingsPath(settingsFile)} env object.`
  return [
    `Updated ${claudeSettingsPath(settingsFile)} env object:`,
    ...entries.map(([key, value]) => `${key}=${value}`),
  ].join("\n")
}

function appendPersistenceNote(output: string, options?: ClaudeEnvironmentRunOptions) {
  if (options?.persist === false) return output
  return `${output}\n\nSaved to ${claudeSettingsPath(options?.settingsFile)}.`
}
