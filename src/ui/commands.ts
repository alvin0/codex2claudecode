export interface UiCommand {
  name: string
  description: string
}

export const UI_COMMANDS: UiCommand[] = [
  { name: "/logs", description: "Show recent runtime request logs" },
  { name: "/codex-fast-mode", description: "Toggle service_tier priority for /v1/responses" },
  { name: "/connect", description: "Add or update a Codex account" },
  { name: "/account", description: "Switch Codex account for this runtime" },
  { name: "/set-claude-env", description: "Edit and apply Claude Code environment exports" },
  { name: "/unset-claude-env", description: "Unset Claude Code environment variables" },
  { name: "/quit", description: "Quit Codex2ClaudeCode" },
]

export function filterCommands(input: string) {
  const query = input.replace(/^\//, "").trim().toLowerCase()
  if (!query) return UI_COMMANDS.slice(0, 8)
  return UI_COMMANDS.filter((command) => command.name.slice(1).includes(query) || command.description.toLowerCase().includes(query)).slice(0, 8)
}
