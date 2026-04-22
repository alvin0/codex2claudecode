import React from "react"
import { Box, Text } from "ink"

import type { KiroAccountView } from "../../connect-kiro"

export function KiroAccountSelector(props: { accounts: KiroAccountView[]; selected: number }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">Select Kiro account</Text>
      </Box>
      <Text color="gray">Switch between Kiro accounts. Applies to this session and future requests.</Text>
      <Box marginTop={1} flexDirection="column">
        {props.accounts.map((account, index) => (
          <Box key={account.key}>
            <Box width={5}>
              <Text color={index === props.selected ? "#aab3cf" : "gray"}>{index === props.selected ? "›" : " "}{index + 1}.</Text>
            </Box>
            <Box width={28}>
              <Text color={index === props.selected ? "green" : "white"}>
                {account.name}
                {index === props.selected ? " ✓" : ""}
              </Text>
            </Box>
            <Text color="gray">
              {account.authType === "aws_sso_oidc" ? "SSO" : "Desktop"} · {account.region}
              {account.profileArn ? ` · ${account.profileArn.split(":")[4]?.slice(0, 8) ?? ""}` : ""}
            </Text>
          </Box>
        ))}
      </Box>
      {!props.accounts.length && <Text color="gray">No Kiro accounts connected. Use /connect to add one.</Text>}
      <Box marginTop={1}>
        <Text color="gray">↑/↓ choose · Enter switch · Esc cancel</Text>
      </Box>
    </Box>
  )
}
