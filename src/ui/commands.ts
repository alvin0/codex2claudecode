import type { ProviderMode } from "./types"

export interface UiCommand {
  name: string
  description: string
}

const SHARED_COMMANDS_BEFORE: UiCommand[] = [
  { name: "/logs", description: "Show recent runtime request logs" },
]

const SHARED_COMMANDS_AFTER: UiCommand[] = [
  { name: "/set-claude-env", description: "Edit and apply Claude Code environment exports" },
  { name: "/unset-claude-env", description: "Unset Claude Code environment variables" },
]

const ACCOUNT_COMMANDS: UiCommand[] = [
  { name: "/connect", description: "Add or update an account for the active provider" },
  { name: "/account", description: "Switch account for this runtime" },
]

const PROVIDER_COMMANDS: Record<ProviderMode, UiCommand[]> = {
  codex: [
    { name: "/codex-fast-mode", description: "Toggle service_tier priority for /v1/responses" },
    ...ACCOUNT_COMMANDS,
  ],
  kiro: ACCOUNT_COMMANDS,
}

export function getCommands(providerMode: ProviderMode): UiCommand[] {
  const switchCommand: UiCommand = {
    name: "/switch-provider",
    description: providerMode === "codex" ? "Switch to Kiro upstream provider" : "Switch to Codex upstream provider",
  }
  const quitCommand: UiCommand = { name: "/quit", description: "Quit Codex2ClaudeCode" }

  return [...SHARED_COMMANDS_BEFORE, ...PROVIDER_COMMANDS[providerMode], ...SHARED_COMMANDS_AFTER, switchCommand, quitCommand]
}

export const UI_COMMANDS = getCommands("codex")

export function filterCommands(input: string, providerMode: ProviderMode = "codex") {
  const query = input.replace(/^\//, "").trim().toLowerCase()
  const commands = getCommands(providerMode)
  if (!query) return commands.slice(0, 8)
  return commands.filter((command) => command.name.slice(1).includes(query)).slice(0, 8)
}
