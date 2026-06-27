import React from "react"
import { Box, Text } from "ink"

import type { AccountInfo } from "../../upstream/codex/account-info"
import type { AccountView, CopilotProviderInfo, KiroProviderInfo, ProviderMode } from "../types"

export function AccountInfoPanel(props: { account?: AccountView; info?: AccountInfo; providerMode?: ProviderMode; kiroInfo?: KiroProviderInfo; copilotInfo?: CopilotProviderInfo }) {
  const mode = props.providerMode ?? "codex"

  if (mode === "kiro") {
    const info = props.kiroInfo
    const tierLabel = info?.subscriptionTier ? formatTier(info.subscriptionTier) : undefined
    return (
      <Box flexDirection="column">
        <Text bold color="#a58a86">Account info</Text>
        <Text color="#aab3cf" wrap="truncate-end">{info?.email ?? props.account?.name ?? "unknown"}</Text>
        <Text color="#aab3cf" wrap="truncate-end">{info?.authType ?? "unknown"}{tierLabel ? ` · ${tierLabel}` : ""}</Text>
        <Text color="#aab3cf" wrap="truncate-end">Region: {info?.region ?? "unknown"}</Text>
        {info?.profileArn && <Text color="#aab3cf" wrap="truncate-end">ARN: {info.profileArn}</Text>}
      </Box>
    )
  }

  if (mode === "copilot") {
    const info = props.copilotInfo
    return (
      <Box flexDirection="column">
        <Text bold color="#a58a86">Account info</Text>
        <Text color="#aab3cf" wrap="truncate-end">{info?.email ?? props.account?.name ?? "unknown"}</Text>
        <Text color="#aab3cf" wrap="truncate-end">{info?.authType ?? "Unknown"}{info?.plan ? ` · ${formatPlan(info.plan)}` : ""}</Text>
        <Text color="#aab3cf" wrap="truncate-end">Account type: {info?.accountType ?? "individual"}</Text>
        {info?.authFilePath && <Text color="#aab3cf" wrap="truncate-end">Auth: {info.authFilePath}</Text>}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold color="#a58a86">Account info</Text>
      <Text color="#aab3cf" wrap="truncate-end">{accountInfo(props.account, props.info)}</Text>
    </Box>
  )
}

function accountInfo(account?: AccountView, info?: AccountInfo) {
  const email = info?.email ?? account?.email ?? account?.name
  const plan = info?.plan ?? account?.plan
  if (!email) return "unknown"
  return `${email}${plan ? ` (${plan})` : ""}`
}

function formatTier(raw: string) {
  // "KIRO POWER" → "Power", "KIRO PRO" → "Pro", etc.
  const cleaned = raw.replace(/^KIRO\s+/i, "")
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase()
}

function formatPlan(raw: string) {
  return raw.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase())
}
