import React from "react"
import { Box, Text } from "ink"

import type { AccountInfo } from "../../upstream/codex/account-info"
import type { AccountView } from "../types"

export function AccountInfoPanel(props: { account?: AccountView; info?: AccountInfo }) {
  return (
    <Box flexDirection="column">
      <Text bold color="#a58a86">Account info</Text>
      <Text color="#aab3cf">{accountInfo(props.account, props.info)}</Text>
    </Box>
  )
}

function accountInfo(account?: AccountView, info?: AccountInfo) {
  const email = info?.email ?? account?.email ?? account?.name
  const plan = info?.plan ?? account?.plan
  if (!email) return "unknown"
  return `${email}${plan ? ` (${plan})` : ""}`
}
