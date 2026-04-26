export interface AccountView {
  key: string
  name: string
  email?: string
  accountId?: string
  plan?: string
  detail?: string
}

export type RuntimeState =
  | { status: "starting" }
  | { status: "running"; server: ReturnType<typeof Bun.serve>; startedAt: number }
  | { status: "error"; error: string }

export type ProviderMode = "codex" | "kiro"

export interface ProviderInfoBase {
  mode: ProviderMode
  label: string
}

export interface CodexProviderInfo extends ProviderInfoBase {
  mode: "codex"
  label: "Codex"
}

export interface KiroProviderInfo extends ProviderInfoBase {
  mode: "kiro"
  label: "Kiro"
  authType: "Desktop Auth" | "SSO OIDC"
  region: string
  profileArn?: string
  authFilePath: string
  subscriptionTier?: string
  email?: string
}

export type ProviderInfo = CodexProviderInfo | KiroProviderInfo
