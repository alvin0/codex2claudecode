import type { ProviderName } from "../llm-connect/factory"
import type { AccountView, RuntimeState } from "./types"

export function accountSubtitle(account: AccountView) {
  return account.accountId ? `${account.name} · ${account.accountId.slice(0, 8)}` : account.name
}

export function accountShortLabel(account: AccountView) {
  const id = account.accountId ? account.accountId.slice(0, 8) : account.name
  return `${account.name} · ${id}`
}

export function runtimeLine(runtime: RuntimeState, hostname: string, port: number, provider?: ProviderName) {
  const label = provider === "kiro" ? "Kiro" : "Codex"
  if (runtime.status === "starting") return `Starting ${label} runtime...`
  if (runtime.status === "error") return `Runtime error: ${runtime.error}`
  return `${label} runtime listening on http://${hostname}:${port} · started ${new Date(runtime.startedAt).toLocaleTimeString()}`
}

export function modelLabel() {
  return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? process.env.CODEX_MODEL ?? "gpt-5.4_high"
}
