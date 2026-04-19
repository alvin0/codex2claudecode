import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  applyClaudeEnvironment,
  claudeEnvironmentCommands,
  claudeEnvironmentConfigPath,
  claudeEnvironmentExports,
  claudeEnvironmentPowerShellCommands,
  echoClaudeEnvironment,
  echoClaudeEnvironmentUnset,
  detectShell,
  persistClaudeEnvironment,
  persistClaudeEnvironmentUnset,
  readClaudeEnvironmentConfig,
  runClaudeEnvironmentSet,
  runClaudeEnvironmentUnset,
  unsetClaudeEnvironment,
  writeClaudeEnvironmentConfig,
  claudeEnvironmentUnsetCommands,
} from "../src/ui/claude-env"

const keys = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
]
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const tempDirs: string[] = []

afterEach(async () => {
  keys.forEach((key) => {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  })
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("formats, applies, and echoes Claude environment exports", async () => {
  const draft = {
    ANTHROPIC_MODEL: "gpt-5.4",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-5.4_high",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "gpt-5.3-codex_high",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "gpt-5.4-mini_high",
  }
  expect(claudeEnvironmentExports(draft, "http://127.0.0.1:8787")).toContain('export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"')
  expect(claudeEnvironmentCommands(draft, "http://127.0.0.1:8787", "posix")).toContain('export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"')
  expect(claudeEnvironmentPowerShellCommands(draft, "http://127.0.0.1:8787")).toContain('$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8787"')
  expect(claudeEnvironmentCommands(draft, "http://127.0.0.1:8787", "posix")).toContain('export ANTHROPIC_MODEL="gpt-5.4"')
  expect(claudeEnvironmentCommands(draft, "http://127.0.0.1:8787", "powershell")).toContain('$env:ANTHROPIC_DEFAULT_OPUS_MODEL="gpt-5.4_high"')
  applyClaudeEnvironment(draft, "http://127.0.0.1:8787")
  expect(process.env.ANTHROPIC_MODEL).toBe("gpt-5.4")
  expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("gpt-5.4_high")
  await expect(echoClaudeEnvironment(draft, "http://127.0.0.1:8787")).resolves.toContain('export ANTHROPIC_DEFAULT_HAIKU_MODEL="gpt-5.4-mini_high"')
  await expect(runClaudeEnvironmentSet(draft, "http://127.0.0.1:8787", "posix", { persist: false })).resolves.toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:8787")
})

test("unsets and echoes Claude environment commands", async () => {
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8787"
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "gpt"
  unsetClaudeEnvironment()
  expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
  expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
  expect(claudeEnvironmentUnsetCommands("posix")).toEqual([
    "unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL",
  ])
  expect(claudeEnvironmentUnsetCommands("powershell")).toContain("Remove-Item Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue")
  await expect(echoClaudeEnvironmentUnset("posix")).resolves.toContain("unset ANTHROPIC_BASE_URL")
  await expect(runClaudeEnvironmentUnset("posix", { persist: false })).resolves.toBe("No ANTHROPIC environment variables found.")
})

test("detects supported and unsupported shells", () => {
  expect(detectShell({ SHELL: "/bin/zsh" }, "darwin")).toEqual({ kind: "posix", name: "zsh" })
  expect(detectShell({ CODEX2CLAUDECODE_SHELL: "powershell" }, "linux")).toEqual({ kind: "powershell", name: "powershell" })
  expect(detectShell({ SHELL: "/usr/bin/fish" }, "linux")).toMatchObject({ kind: "unsupported", name: "fish" })
  expect(detectShell({ CODEX2CLAUDECODE_SHELL: "cmd" }, "win32")).toMatchObject({ kind: "unsupported", name: "cmd" })
})

test("persists Claude model env defaults and keeps base URL dynamic", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-env-test-"))
  tempDirs.push(dir)
  const authFile = path.join(dir, "auth-codex.json")
  const draft = {
    ANTHROPIC_MODEL: "model_custom",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "opus_custom",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet_custom",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku_custom",
  }

  await writeClaudeEnvironmentConfig(authFile, draft)
  await expect(readClaudeEnvironmentConfig(authFile)).resolves.toEqual(draft)
  expect(claudeEnvironmentConfigPath(authFile)).toBe(path.join(dir, ".claude-env.json"))
  expect(await readFile(path.join(dir, ".claude-env.json"), "utf8")).toContain("opus_custom")
  expect(claudeEnvironmentExports(draft, "http://127.0.0.1:8786")).toContain('export ANTHROPIC_BASE_URL="http://127.0.0.1:8786"')
})

test("persists POSIX shell integration files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-env-profile-test-"))
  tempDirs.push(dir)
  const authFile = path.join(dir, "auth-codex.json")
  const profileFile = path.join(dir, ".zshrc")
  const draft = {
    ANTHROPIC_MODEL: "gpt-5.4",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "opus_custom",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet_custom",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku_custom",
  }

  await persistClaudeEnvironment(draft, "http://127.0.0.1:8787", { kind: "posix", name: "zsh" }, { authFile, profileFile })
  expect(await readFile(path.join(dir, ".claude-env.sh"), "utf8")).toContain('export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"')
  expect(await readFile(profileFile, "utf8")).toContain("codex2claudecode")
  await persistClaudeEnvironmentUnset({ kind: "posix", name: "zsh" }, { authFile, profileFile })
  expect(await readFile(path.join(dir, ".claude-env.sh"), "utf8")).toContain("unset ANTHROPIC_BASE_URL")
})

test("updates an existing POSIX profile block when the auth directory changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-env-profile-replace-test-"))
  tempDirs.push(dir)
  const authFile = path.join(dir, "auth-codex.json")
  const profileFile = path.join(dir, ".zshrc")
  const draft = {
    ANTHROPIC_MODEL: "gpt-5.4",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "opus_custom",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet_custom",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku_custom",
  }

  await persistClaudeEnvironment(draft, "http://127.0.0.1:8787", { kind: "posix", name: "zsh" }, { authFile: path.join(dir, "old", "auth-codex.json"), profileFile })
  await persistClaudeEnvironment(draft, "http://127.0.0.1:8787", { kind: "posix", name: "zsh" }, { authFile, profileFile })
  expect(await readFile(profileFile, "utf8")).toContain(path.join(dir, ".claude-env.sh"))
  expect(await readFile(profileFile, "utf8")).not.toContain(path.join(dir, "old", ".claude-env.sh"))
})
