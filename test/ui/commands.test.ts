import { describe, expect, test } from "bun:test"

import { filterCommands, getCommands } from "../../src/ui/commands"

describe("UI commands", () => {
  test("returns Codex commands in order", () => {
    expect(getCommands("codex").map((command) => command.name)).toEqual([
      "/logs",
      "/codex-fast-mode",
      "/connect",
      "/account",
      "/set-claude-env",
      "/unset-claude-env",
      "/switch-provider",
      "/quit",
    ])
  })

  test("returns Kiro commands in order", () => {
    expect(getCommands("kiro").map((command) => command.name)).toEqual([
      "/logs",
      "/connect",
      "/account",
      "/set-claude-env",
      "/unset-claude-env",
      "/switch-provider",
      "/quit",
    ])
  })

  test("uses dynamic switch-provider descriptions", () => {
    expect(getCommands("codex").find((command) => command.name === "/switch-provider")?.description).toBe("Switch to Kiro upstream provider")
    expect(getCommands("kiro").find((command) => command.name === "/switch-provider")?.description).toBe("Switch to Codex upstream provider")
  })

  test("omits Codex-only commands in Kiro mode", () => {
    const names = getCommands("kiro").map((command) => command.name)
    expect(names).not.toContain("/codex-fast-mode")
    expect(names).toContain("/connect")
    expect(names).toContain("/account")
  })

  test("filters commands by provider mode", () => {
    expect(filterCommands("switch", "codex").map((command) => command.name)).toContain("/switch-provider")
    expect(filterCommands("switch", "kiro").map((command) => command.name)).toContain("/switch-provider")
    expect(filterCommands("codex", "kiro")).toEqual([])
    expect(filterCommands("", "codex")).toHaveLength(8)
  })
})
