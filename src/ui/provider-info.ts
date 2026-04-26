import type { Upstream_Provider } from "../core/interfaces"
import type { CodexProviderInfo, KiroProviderInfo, ProviderInfo, ProviderMode } from "./types"

interface KiroProviderAccessors {
  getAuthType?: () => unknown
  getRegion?: () => unknown
  getProfileArn?: () => unknown
}

export function buildProviderInfo(mode: ProviderMode, upstream: Upstream_Provider, authFilePath?: string): ProviderInfo {
  if (mode === "codex") return { mode: "codex", label: "Codex" } as CodexProviderInfo

  const kiro = upstream as Upstream_Provider & KiroProviderAccessors
  const rawAuthType = kiro.getAuthType?.()
  const authType = rawAuthType === "aws_sso_oidc" ? "SSO OIDC" : "Desktop Auth"
  const rawRegion = kiro.getRegion?.()
  const rawProfileArn = kiro.getProfileArn?.()

  return {
    mode: "kiro",
    label: "Kiro",
    authType,
    region: typeof rawRegion === "string" ? rawRegion : "unknown",
    ...(typeof rawProfileArn === "string" ? { profileArn: rawProfileArn } : {}),
    authFilePath: authFilePath ?? "",
  } as KiroProviderInfo
}
