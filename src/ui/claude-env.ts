import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { ensureParentDir } from "../paths"

export const CLAUDE_ENV_FIXED = {
  ANTHROPIC_AUTH_TOKEN: "",
  ANTHROPIC_API_KEY: "",
}

export const CLAUDE_MODEL_ENV_KEYS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const

export type ClaudeModelEnvKey = (typeof CLAUDE_MODEL_ENV_KEYS)[number]
export type ClaudeEnvironmentDraft = Record<ClaudeModelEnvKey, string>

export function defaultClaudeEnvironment(): ClaudeEnvironmentDraft {
  return {
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
  return [
    `export ANTHROPIC_AUTH_TOKEN=${quoteShell(CLAUDE_ENV_FIXED.ANTHROPIC_AUTH_TOKEN)}`,
    `export ANTHROPIC_BASE_URL=${quoteShell(baseUrl)}`,
    `export ANTHROPIC_API_KEY=${quoteShell(CLAUDE_ENV_FIXED.ANTHROPIC_API_KEY)}`,
    ...CLAUDE_MODEL_ENV_KEYS.map((key) => `export ${key}=${quoteShell(draft[key])}`),
  ]
}

export function applyClaudeEnvironment(draft: ClaudeEnvironmentDraft, baseUrl: string) {
  process.env.ANTHROPIC_AUTH_TOKEN = CLAUDE_ENV_FIXED.ANTHROPIC_AUTH_TOKEN
  process.env.ANTHROPIC_BASE_URL = baseUrl
  process.env.ANTHROPIC_API_KEY = CLAUDE_ENV_FIXED.ANTHROPIC_API_KEY
  CLAUDE_MODEL_ENV_KEYS.forEach((key) => {
    process.env[key] = draft[key]
  })
}

export async function echoClaudeEnvironment(draft: ClaudeEnvironmentDraft, baseUrl: string) {
  const lines = claudeEnvironmentExports(draft, baseUrl)
  const proc = Bun.spawn(["echo", lines.join("\n")], {
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

function normalizeClaudeEnvironment(input: Partial<ClaudeEnvironmentDraft>): ClaudeEnvironmentDraft {
  const defaults = defaultClaudeEnvironment()
  return {
    ANTHROPIC_DEFAULT_OPUS_MODEL: input.ANTHROPIC_DEFAULT_OPUS_MODEL ?? defaults.ANTHROPIC_DEFAULT_OPUS_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: input.ANTHROPIC_DEFAULT_SONNET_MODEL ?? defaults.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: input.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? defaults.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  }
}
