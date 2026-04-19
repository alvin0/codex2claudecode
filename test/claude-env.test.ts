import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { applyClaudeEnvironment, claudeEnvironmentConfigPath, claudeEnvironmentExports, echoClaudeEnvironment, readClaudeEnvironmentConfig, writeClaudeEnvironmentConfig } from "../src/ui/claude-env"

const keys = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
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
    ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-5.4_high",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "gpt-5.3-codex_high",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "gpt-5.4-mini_high",
  }
  expect(claudeEnvironmentExports(draft, "http://127.0.0.1:8787")).toContain('export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"')
  applyClaudeEnvironment(draft, "http://127.0.0.1:8787")
  expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("gpt-5.4_high")
  await expect(echoClaudeEnvironment(draft, "http://127.0.0.1:8787")).resolves.toContain('export ANTHROPIC_DEFAULT_HAIKU_MODEL="gpt-5.4-mini_high"')
})

test("persists Claude model env defaults and keeps base URL dynamic", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-env-test-"))
  tempDirs.push(dir)
  const authFile = path.join(dir, "auth-codex.json")
  const draft = {
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
