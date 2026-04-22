import React from "react"
import { Box, Text } from "ink"

import type { AccountInfo } from "../../account-info"
import type { KiroAccountView } from "../../connect-kiro"
import type { ProviderName } from "../../llm-connect/factory"
import type { AccountView } from "../types"

export function AccountInfoPanel(props: {
  account?: AccountView
  info?: AccountInfo
  provider?: ProviderName
  kiroAccount?: KiroAccountView
}) {
  if (props.provider === "kiro") {
    const kiro = props.kiroAccount
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="#a58a86">Kiro account</Text>
        {kiro ? (
          <Box flexDirection="column" marginTop={1}>
            <InfoLine label="Name" value={kiro.name} />
            <InfoLine label="Auth type" value={kiro.authType === "aws_sso_oidc" ? "AWS SSO OIDC" : "Kiro Desktop"} />
            <InfoLine label="Region" value={kiro.region} />
            {kiro.profileArn && <InfoLine label="Profile" value={kiro.profileArn} />}
            <InfoLine label="Status" value={kiro.hasToken ? "connected" : "no token"} />
          </Box>
        ) : (
          <Text color="gray">Not connected. Use /connect to set up Kiro credentials.</Text>
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="#a58a86">Account info</Text>
      <Text color="#aab3cf">{accountInfo(props.account, props.info)}</Text>
    </Box>
  )
}

function InfoLine(props: { label: string; value: string }) {
  return (
    <Box>
      <Box width={12}>
        <Text color="gray">{props.label}:</Text>
      </Box>
      <Text color="#aab3cf">{props.value}</Text>
    </Box>
  )
}

function accountInfo(account?: AccountView, info?: AccountInfo) {
  const email = info?.email ?? account?.email ?? account?.name
  const plan = info?.plan ?? account?.plan
  if (!email) return "unknown"
  return `${email}${plan ? ` (${plan})` : ""}`
}
