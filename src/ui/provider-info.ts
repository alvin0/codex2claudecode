import type { Upstream_Provider } from "../core/interfaces"
import type { CopilotProviderInfo, CodexProviderInfo, KiroProviderInfo, ProviderInfo, ProviderMode } from "./types"

interface KiroProviderAccessors {
  getAuthType?: () => unknown
  getRegion?: () => unknown
  getProfileArn?: () => unknown
}

interface CopilotProviderAccessors {
  getAuthType?: () => unknown
  getAccountType?: () => unknown
  getEmail?: () => unknown
  getPlan?: () => unknown
}

export function buildProviderInfo(mode: ProviderMode, upstream: Upstream_Provider, authFilePath?: string): ProviderInfo {
  if (mode === "codex") return { mode: "codex", label: "Codex" } as CodexProviderInfo
  if (mode === "copilot") {
    const copilot = upstream as Upstream_Provider & CopilotProviderAccessors
    const rawAuthType = copilot.getAuthType?.()
    const rawAccountType = copilot.getAccountType?.()
    const rawEmail = copilot.getEmail?.()
    const rawPlan = copilot.getPlan?.()
    return {
      mode: "copilot",
      label: "Copilot",
      authType: rawAuthType === "device_code" ? "Device Code" : rawAuthType === "github_token" ? "GitHub Token" : "Unknown",
      ...(typeof rawAccountType === "string" ? { accountType: rawAccountType } : {}),
      ...(typeof rawEmail === "string" ? { email: rawEmail } : {}),
      ...(typeof rawPlan === "string" ? { plan: rawPlan } : {}),
      authFilePath: authFilePath ?? "",
    } as CopilotProviderInfo
  }

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
