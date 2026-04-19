import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { ensureParentDir } from "../paths"

export const CLAUDE_ENV_FIXED = {
  ANTHROPIC_API_KEY: "",
}

export const CLAUDE_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const

export const CLAUDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  ...CLAUDE_MODEL_ENV_KEYS,
] as const

export type ClaudeModelEnvKey = (typeof CLAUDE_MODEL_ENV_KEYS)[number]
export type ClaudeEnvironmentDraft = Record<ClaudeModelEnvKey, string>
export type ShellKind = "posix" | "powershell"
export type ShellDetection = { kind: ShellKind; name: string } | { kind: "unsupported"; name: string; reason: string }
export interface ClaudeEnvironmentRunOptions {
  authFile?: string
  profileFile?: string
  persist?: boolean
}

const POSIX_PROFILE_BEGIN = "# >>> codex2claudecode >>>"
const POSIX_PROFILE_END = "# <<< codex2claudecode <<<"

export function defaultClaudeEnvironment(): ClaudeEnvironmentDraft {
  return {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "gpt-5.4",
    ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "gpt-5.4_high",
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "gpt-5.3-codex_high",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "gpt-5.4-mini_high",
  }
}

export function claudeEnvironmentConfigPath(authFile: string) {
  return path.join(path.dirname(authFile), ".claude-env.json")
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
  return claudeEnvironmentCommands(draft, baseUrl, "posix")
}

export function claudeEnvironmentCommands(draft: ClaudeEnvironmentDraft, baseUrl: string, shell: ShellKind | ShellDetection = detectShell()) {
  const kind = typeof shell === "string" ? shell : shell.kind
  if (kind === "unsupported") throw new Error(typeof shell === "string" ? "Unsupported shell" : shell.reason)
  if (kind === "powershell") return claudeEnvironmentPowerShellCommands(draft, baseUrl)
  return [
    `export ANTHROPIC_BASE_URL=${quoteShell(baseUrl)}`,
    `export ANTHROPIC_API_KEY=${quoteShell(CLAUDE_ENV_FIXED.ANTHROPIC_API_KEY)}`,
    ...CLAUDE_MODEL_ENV_KEYS.map((key) => `export ${key}=${quoteShell(draft[key])}`),
  ]
}

export function claudeEnvironmentPowerShellCommands(draft: ClaudeEnvironmentDraft, baseUrl: string) {
  return [
    `$env:ANTHROPIC_BASE_URL=${quotePowerShell(baseUrl)}`,
    `$env:ANTHROPIC_API_KEY=${quotePowerShell(CLAUDE_ENV_FIXED.ANTHROPIC_API_KEY)}`,
    ...CLAUDE_MODEL_ENV_KEYS.map((key) => `$env:${key}=${quotePowerShell(draft[key])}`),
  ]
}

export function applyClaudeEnvironment(draft: ClaudeEnvironmentDraft, baseUrl: string) {
  process.env.ANTHROPIC_BASE_URL = baseUrl
  process.env.ANTHROPIC_API_KEY = CLAUDE_ENV_FIXED.ANTHROPIC_API_KEY
  CLAUDE_MODEL_ENV_KEYS.forEach((key) => {
    process.env[key] = draft[key]
  })
}

export function unsetClaudeEnvironment() {
  CLAUDE_ENV_KEYS.forEach((key) => {
    delete process.env[key]
  })
}

export function claudeEnvironmentUnsetCommands(shell: ShellKind | ShellDetection = detectShell()) {
  const kind = typeof shell === "string" ? shell : shell.kind
  if (kind === "unsupported") throw new Error(typeof shell === "string" ? "Unsupported shell" : shell.reason)
  if (kind === "powershell") return CLAUDE_ENV_KEYS.map((key) => `Remove-Item Env:${key} -ErrorAction SilentlyContinue`)
  return [`unset ${CLAUDE_ENV_KEYS.join(" ")}`]
}

export async function echoClaudeEnvironment(draft: ClaudeEnvironmentDraft, baseUrl: string, shell: ShellKind | ShellDetection = detectShell()) {
  const output = claudeEnvironmentCommands(draft, baseUrl, shell).join("\n")
  return echoShellOutput(output, shell)
}

export async function runClaudeEnvironmentSet(draft: ClaudeEnvironmentDraft, baseUrl: string, shell: ShellKind | ShellDetection = detectShell(), options?: ClaudeEnvironmentRunOptions) {
  if (options?.persist !== false) await persistClaudeEnvironment(draft, baseUrl, shell, options)
  return appendPersistenceNote(await grepClaudeEnvironment(shell), shell, options)
}

export async function echoClaudeEnvironmentUnset(shell: ShellKind | ShellDetection = detectShell()) {
  const output = claudeEnvironmentUnsetCommands(shell).join("\n")
  return echoShellOutput(output, shell)
}

export async function runClaudeEnvironmentUnset(shell: ShellKind | ShellDetection = detectShell(), options?: ClaudeEnvironmentRunOptions) {
  if (options?.persist !== false) await persistClaudeEnvironmentUnset(shell, options)
  return appendPersistenceNote(await grepClaudeEnvironment(shell), shell, options)
}

export async function persistClaudeEnvironment(draft: ClaudeEnvironmentDraft, baseUrl: string, shell: ShellKind | ShellDetection, options?: ClaudeEnvironmentRunOptions) {
  const kind = typeof shell === "string" ? shell : shell.kind
  if (kind === "unsupported") throw new Error(typeof shell === "string" ? "Unsupported shell" : shell.reason)
  if (kind === "powershell") {
    await runPowerShellUserEnv(claudeEnvironmentPowerShellPersistCommands(draft, baseUrl))
    return
  }
  await writePosixEnvironmentFile(options?.authFile, claudeEnvironmentCommands(draft, baseUrl, "posix").join("\n"))
  await ensurePosixProfileSource(shell, options)
}

export async function persistClaudeEnvironmentUnset(shell: ShellKind | ShellDetection, options?: ClaudeEnvironmentRunOptions) {
  const kind = typeof shell === "string" ? shell : shell.kind
  if (kind === "unsupported") throw new Error(typeof shell === "string" ? "Unsupported shell" : shell.reason)
  if (kind === "powershell") {
    await runPowerShellUserEnv(CLAUDE_ENV_KEYS.map((key) => `[Environment]::SetEnvironmentVariable("${key}", $null, "User")`))
    return
  }
  await writePosixEnvironmentFile(options?.authFile, claudeEnvironmentUnsetCommands("posix").join("\n"))
  await ensurePosixProfileSource(shell, options)
}

async function grepClaudeEnvironment(shell: ShellKind | ShellDetection) {
  const kind = typeof shell === "string" ? shell : shell.kind
  if (kind === "unsupported") throw new Error(typeof shell === "string" ? "Unsupported shell" : shell.reason)
  const proc = Bun.spawn(grepCommand(kind), {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (exitCode !== 0) throw new Error(stderr || `env check exited with ${exitCode}`)
  return stdout.trimEnd() || "No ANTHROPIC environment variables found."
}

async function echoShellOutput(output: string, shell: ShellKind | ShellDetection) {
  const kind = typeof shell === "string" ? shell : shell.kind
  if (kind === "unsupported") throw new Error(typeof shell === "string" ? "Unsupported shell" : shell.reason)
  const proc = Bun.spawn(echoCommand(output, kind), {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (exitCode !== 0) throw new Error(stderr || `echo exited with ${exitCode}`)
  return stdout.trimEnd()
}

function quoteShell(value: string) {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`
}

function quotePowerShell(value: string) {
  return `"${value.replace(/[`"$]/g, (match) => `\`${match}`)}"`
}

function claudeEnvironmentPowerShellPersistCommands(draft: ClaudeEnvironmentDraft, baseUrl: string) {
  const values = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: CLAUDE_ENV_FIXED.ANTHROPIC_API_KEY,
    ...Object.fromEntries(CLAUDE_MODEL_ENV_KEYS.map((key) => [key, draft[key]])),
  }
  return Object.entries(values).map(([key, value]) => `[Environment]::SetEnvironmentVariable("${key}", ${quotePowerShell(value)}, "User")`)
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

function echoCommand(output: string, shell: ShellKind) {
  if (shell === "powershell") return ["powershell", "-NoProfile", "-Command", `Write-Output @'\n${output}\n'@`]
  return ["echo", output]
}

async function writePosixEnvironmentFile(authFile: string | undefined, contents: string) {
  const file = posixEnvironmentFile(authFile)
  await ensureParentDir(file)
  await writeFile(file, `${contents}\n`)
}

function posixEnvironmentFile(authFile: string | undefined) {
  return path.join(path.dirname(authFile ?? path.join(homedir(), ".codex2claudecode", "auth-codex.json")), ".claude-env.sh")
}

async function ensurePosixProfileSource(shell: ShellKind | ShellDetection, options?: ClaudeEnvironmentRunOptions) {
  await Promise.all(posixProfileFiles(shell, options).map(async (profile) => {
    const current = existsSync(profile) ? await readFile(profile, "utf8") : ""
    await ensureParentDir(profile)
    await writeFile(profile, upsertPosixProfileBlock(current, posixProfileBlock(options?.authFile)))
  }))
}

function posixProfileFiles(shell: ShellKind | ShellDetection, options?: ClaudeEnvironmentRunOptions) {
  if (options?.profileFile) return [options.profileFile]
  const name = typeof shell === "string" ? shell : shell.name
  const files = name === "zsh"
    ? [{ file: ".zshrc", create: true }, { file: ".zprofile", create: false }, { file: ".profile", create: false }]
    : name === "bash"
      ? [{ file: ".bashrc", create: true }, { file: ".bash_profile", create: false }, { file: ".profile", create: true }]
      : [{ file: ".profile", create: true }]
  return [...new Set(files.map((item) => path.join(homedir(), item.file)).filter((file, index) => files[index]?.create || existsSync(file)))]
}

function posixProfileBlock(authFile: string | undefined) {
  const file = posixEnvironmentFile(authFile)
  return `${POSIX_PROFILE_BEGIN}\n[ -f "${file}" ] && . "${file}"\n${POSIX_PROFILE_END}`
}

function upsertPosixProfileBlock(current: string, block: string) {
  const pattern = new RegExp(`\\n?${escapeRegExp(POSIX_PROFILE_BEGIN)}[\\s\\S]*?${escapeRegExp(POSIX_PROFILE_END)}\\n?`, "m")
  if (pattern.test(current)) return `${current.replace(pattern, `\n${block}\n`).replace(/\s*$/, "")}\n`
  const trimmed = current.replace(/\s*$/, "")
  return `${trimmed}${trimmed ? "\n" : ""}${block}\n`
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function appendPersistenceNote(output: string, shell: ShellKind | ShellDetection, options?: ClaudeEnvironmentRunOptions) {
  if (options?.persist === false) return output
  const kind = typeof shell === "string" ? shell : shell.kind
  if (kind === "powershell") return `${output}\n\nPersisted to PowerShell user environment. Open a new terminal to load it.`
  if (kind === "unsupported") return output
  return `${output}\n\nPersisted for new POSIX terminals via ${posixEnvironmentFile(options?.authFile)}. Open a new terminal or source your shell profile.`
}

async function runPowerShellUserEnv(commands: string[]) {
  const proc = Bun.spawn(["powershell", "-NoProfile", "-Command", commands.join("; ")], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (exitCode !== 0) throw new Error(stderr || `PowerShell exited with ${exitCode}`)
}

function grepCommand(shell: ShellKind) {
  if (shell === "powershell") {
    return ["powershell", "-NoProfile", "-Command", "Get-ChildItem Env:ANTHROPIC* | ForEach-Object { \"$($_.Name)=$($_.Value)\" }"]
  }
  return ["sh", "-c", "env | grep ANTHROPIC || true"]
}

function normalizeClaudeEnvironment(input: Partial<ClaudeEnvironmentDraft>): ClaudeEnvironmentDraft {
  const defaults = defaultClaudeEnvironment()
  return {
    ANTHROPIC_MODEL: input.ANTHROPIC_MODEL ?? defaults.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: input.ANTHROPIC_DEFAULT_OPUS_MODEL ?? defaults.ANTHROPIC_DEFAULT_OPUS_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: input.ANTHROPIC_DEFAULT_SONNET_MODEL ?? defaults.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: input.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? defaults.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  }
}
