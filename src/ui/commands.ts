export interface UiCommand {
  name: string
  description: string
  /** If set, command only shows for this provider. Omit for both. */
  provider?: "codex" | "kiro"
}

export const UI_COMMANDS: UiCommand[] = [
  { name: "/limits", description: "Show account and model limits", provider: "codex" },
  { name: "/limits", description: "Show Kiro usage limits", provider: "kiro" },
  { name: "/logs", description: "Show recent runtime request logs" },
  { name: "/provider", description: "Switch LLM provider (codex / kiro)" },
  { name: "/connect", description: "Add or update a Codex account", provider: "codex" },
  { name: "/connect", description: "Add or sync a Kiro account", provider: "kiro" },
  { name: "/account", description: "Switch Codex account for this runtime", provider: "codex" },
  { name: "/account", description: "Switch Kiro account for this runtime", provider: "kiro" },
  { name: "/set-claude-env", description: "Edit and apply Claude Code environment exports" },
  { name: "/unset-claude-env", description: "Unset Claude Code environment variables" },
  { name: "/quit", description: "Quit Codex2ClaudeCode" },
]

export function filterCommands(input: string, provider?: "codex" | "kiro") {
  const query = input.replace(/^\//, "").trim().toLowerCase()
  const available = provider ? UI_COMMANDS.filter((c) => !c.provider || c.provider === provider) : UI_COMMANDS
  if (!query) return available.slice(0, 7)
  return available.filter((command) => command.name.slice(1).includes(query) || command.description.toLowerCase().includes(query)).slice(0, 7)
}
