import { expect, test } from "bun:test"

import { CLAUDE_CODE_ENV_CONFIG } from "../src/inbound/claude/claude-code-env.config"
import {
  claudeEnvironmentCommands,
  claudeEnvironmentConfigPath,
  claudeEnvironmentExports,
  claudeEnvironmentPowerShellCommands,
  claudeEnvironmentUnsetCommands,
  claudeSettingsPath,
  claudeSettingsPathForScope,
  claudeSettingsScopeLabel,
  defaultClaudeEnvironment,
  detectShell,
  echoClaudeEnvironment,
  echoClaudeEnvironmentUnset,
  persistClaudeEnvironment,
  persistClaudeEnvironmentUnset,
  readClaudeEnvironmentConfig,
  readClaudeSettingsEnvAsDraft,
  recommendedClaudeEnvironment,
  runClaudeEnvironmentSet,
  runClaudeEnvironmentUnset,
  writeClaudeEnvironmentConfig,
} from "../src/ui/claude-env"
import { mkdtemp, path, readFile, rm, tmpdir, writeFile } from "./helpers"

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function draft(overrides?: Partial<ReturnType<typeof defaultClaudeEnvironment>>) {
  return {
    ANTHROPIC_MODEL: CLAUDE_CODE_ENV_CONFIG.editableEnvDefaults.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: CLAUDE_CODE_ENV_CONFIG.editableEnvDefaults.ANTHROPIC_DEFAULT_OPUS_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: CLAUDE_CODE_ENV_CONFIG.editableEnvDefaults.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_CODE_ENV_CONFIG.editableEnvDefaults.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    extraEnv: { ...CLAUDE_CODE_ENV_CONFIG.defaultExtraEnv },
    unsetEnv: [...CLAUDE_CODE_ENV_CONFIG.defaultUnsetEnv],
    ...overrides,
  }
}

test("formats preview lines for Claude settings updates", async () => {
  const value = draft()

  expect(claudeEnvironmentExports(value, "http://127.0.0.1:8787")).toContain(`Target file: ${claudeSettingsPath()}`)
  expect(claudeEnvironmentCommands(value, "http://127.0.0.1:8787", "posix")).toContain('ANTHROPIC_BASE_URL = "http://127.0.0.1:8787"')
  expect(claudeEnvironmentPowerShellCommands(value, "http://127.0.0.1:8787")).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL = "gpt-5.4"')
  expect(claudeEnvironmentCommands(value, "http://127.0.0.1:8787", "posix")).toContain("ANTHROPIC_AUTH_TOKEN = [redacted]")
  await expect(echoClaudeEnvironment(value, "http://127.0.0.1:8787", "posix")).resolves.toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL = "gpt-5.4-mini"')
  await expect(echoClaudeEnvironment(value, "http://127.0.0.1:8787", "posix")).resolves.toContain('CLAUDE_CODE_DISABLE_1M_CONTEXT = "1"')
  await expect(echoClaudeEnvironment(value, "http://127.0.0.1:8787", "posix")).resolves.toContain('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "64"')
  await expect(runClaudeEnvironmentSet(value, "http://127.0.0.1:8787", "posix", { persist: false })).resolves.toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:8787")
})

test("formats unset preview lines for Claude settings env keys", async () => {
  const value = draft()

  expect(claudeEnvironmentUnsetCommands(value, "posix")).toEqual([
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_DISABLE_1M_CONTEXT",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
    "NODE_TLS_REJECT_UNAUTHORIZED",
  ])
  await expect(echoClaudeEnvironmentUnset(value, "posix")).resolves.toContain("ANTHROPIC_BASE_URL")
  await expect(runClaudeEnvironmentUnset(value, "posix", { persist: false })).resolves.toBe(`Updated ${claudeSettingsPath()} env object.`)
})

test("uses OpenRouter Codex model recommendations", () => {
  expect(recommendedClaudeEnvironment("codex")).toMatchObject({
    ANTHROPIC_MODEL: "gpt-5.5",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-5.5",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "gpt-5.5",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "gpt-5.4-mini",
  })
})

test("uses Kiro Claude model defaults when provider mode is Kiro", async () => {
  const recommended = recommendedClaudeEnvironment("kiro")
  expect(recommended).toMatchObject({
    ANTHROPIC_MODEL: "claude-sonnet-4.5",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4.6",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4.5",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4.5",
  })

  await withTempDir("claude-settings-kiro-", async (dir) => {
    const settingsFile = path.join(dir, "settings.json")
    await writeFile(settingsFile, `${JSON.stringify({ env: {} }, null, 2)}\n`)

    await expect(readClaudeSettingsEnvAsDraft(settingsFile, "kiro")).resolves.toMatchObject({
      ANTHROPIC_MODEL: "claude-sonnet-4.5",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4.6",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4.5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4.5",
    })
  })
})

test("detects supported and unsupported shells", () => {
  expect(detectShell({ SHELL: "/bin/zsh" }, "darwin")).toEqual({ kind: "posix", name: "zsh" })
  expect(detectShell({ CODEX2CLAUDECODE_SHELL: "powershell" }, "linux")).toEqual({ kind: "powershell", name: "powershell" })
  expect(detectShell({ SHELL: "/usr/bin/fish" }, "linux")).toMatchObject({ kind: "unsupported", name: "fish" })
  expect(detectShell({ CODEX2CLAUDECODE_SHELL: "cmd" }, "win32")).toMatchObject({ kind: "unsupported", name: "cmd" })
})

test("resolves Claude settings paths for each scope", () => {
  expect(claudeSettingsScopeLabel("user")).toBe("~/.claude/settings.json")
  expect(claudeSettingsScopeLabel("project")).toBe(".claude/settings.json")
  expect(claudeSettingsScopeLabel("local")).toBe(".claude/settings.local.json")
  expect(claudeSettingsPathForScope("project", "/repo")).toBe(path.join("/repo", ".claude", "settings.json"))
  expect(claudeSettingsPathForScope("local", "/repo")).toBe(path.join("/repo", ".claude", "settings.local.json"))
})

test("persists Claude env config next to the auth file", async () => {
  await withTempDir("claude-env-config-", async (dir) => {
    const authFile = path.join(dir, "auth-codex.json")
    const value = draft({
      ANTHROPIC_MODEL: "model_custom",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "opus_custom",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet_custom",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku_custom",
    })

    await writeClaudeEnvironmentConfig(authFile, value)
    await expect(readClaudeEnvironmentConfig(authFile)).resolves.toEqual(value)
    expect(claudeEnvironmentConfigPath(authFile)).toBe(path.join(dir, ".claude-env.json"))
    expect(await readFile(path.join(dir, ".claude-env.json"), "utf8")).toContain("opus_custom")
  })
})

test("merges env updates into ~/.claude/settings.json without changing other fields", async () => {
  await withTempDir("claude-settings-set-", async (dir) => {
    const settingsFile = path.join(dir, "settings.json")
    const value = draft({
      extraEnv: { CUSTOM_ENV: "custom-value" },
      unsetEnv: ["REMOVE_ME"],
    })

    await writeFile(settingsFile, `${JSON.stringify({ theme: "dark", env: { KEEP: "yes", REMOVE_ME: "legacy" }, hooks: { enabled: true } }, null, 2)}\n`)
    await persistClaudeEnvironment(value, "http://127.0.0.1:8787", "posix", { settingsFile })

    const saved = JSON.parse(await readFile(settingsFile, "utf8")) as { theme: string; hooks: { enabled: boolean }; env: Record<string, string> }
    expect(saved.theme).toBe("dark")
    expect(saved.hooks.enabled).toBe(true)
    expect(saved.env.KEEP).toBe("yes")
    expect(saved.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787")
    expect(saved.env.ANTHROPIC_AUTH_TOKEN).toBe("codex2claudecode")
    expect(saved.env.ANTHROPIC_API_KEY).toBe("codex2claudecode")
    expect(saved.env.CUSTOM_ENV).toBe("custom-value")
    expect(saved.env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe("1")
    expect(saved.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("64")
    expect(saved.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0")
    expect(saved.env.REMOVE_ME).toBeUndefined()
  })
})

test("removes only managed env keys from ~/.claude/settings.json", async () => {
  await withTempDir("claude-settings-unset-", async (dir) => {
    const settingsFile = path.join(dir, "settings.json")
    const value = draft({
      extraEnv: { CUSTOM_ENV: "custom-value" },
      unsetEnv: ["REMOVE_ME"],
    })

    await writeFile(settingsFile, `${JSON.stringify({
      env: {
        KEEP: "yes",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
        ANTHROPIC_AUTH_TOKEN: "codex2claudecode",
        ANTHROPIC_API_KEY: "codex2claudecode",
        ANTHROPIC_MODEL: "gpt-5.4",
        CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "64",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        CUSTOM_ENV: "custom-value",
        REMOVE_ME: "legacy",
      },
      nested: { ok: true },
    }, null, 2)}\n`)

    await persistClaudeEnvironmentUnset(value, "posix", { settingsFile })

    const saved = JSON.parse(await readFile(settingsFile, "utf8")) as { nested: { ok: boolean }; env: Record<string, string> }
    expect(saved.nested.ok).toBe(true)
    expect(saved.env.KEEP).toBe("yes")
    expect(saved.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(saved.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(saved.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(saved.env.ANTHROPIC_MODEL).toBeUndefined()
    expect(saved.env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBeUndefined()
    expect(saved.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBeUndefined()
    expect(saved.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
    expect(saved.env.CUSTOM_ENV).toBeUndefined()
    expect(saved.env.REMOVE_ME).toBeUndefined()
  })
})

test("creates ~/.claude/settings.json if it does not exist", async () => {
  await withTempDir("claude-settings-create-", async (dir) => {
    const settingsFile = path.join(dir, "settings.json")
    const value = draft({
      extraEnv: { CUSTOM_ENV: "custom-value" },
    })

    await persistClaudeEnvironment(value, "http://127.0.0.1:8787", "posix", { settingsFile })

    const saved = JSON.parse(await readFile(settingsFile, "utf8")) as { env: Record<string, string> }
    expect(saved.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787")
    expect(saved.env.ANTHROPIC_AUTH_TOKEN).toBe("codex2claudecode")
    expect(saved.env.ANTHROPIC_API_KEY).toBe("codex2claudecode")
    expect(saved.env.CUSTOM_ENV).toBe("custom-value")
    expect(saved.env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe("1")
    expect(saved.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("64")
    expect(saved.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0")
  })
})

test("shows configured extra env additions and deletions in previews", async () => {
  const value = draft({
    extraEnv: { CUSTOM_ENV: "custom-value", REMOVE_ME: "keep-new" },
    unsetEnv: ["REMOVE_ME", "LEGACY_FLAG"],
  })

  expect(claudeEnvironmentCommands(value, "http://127.0.0.1:8787", "posix")).toContain('CUSTOM_ENV = "custom-value"')
  expect(claudeEnvironmentCommands(value, "http://127.0.0.1:8787", "posix")).toContain("delete LEGACY_FLAG")
  await expect(runClaudeEnvironmentSet(value, "http://127.0.0.1:8787", "posix", { persist: false })).resolves.toContain("CUSTOM_ENV=custom-value")
})
