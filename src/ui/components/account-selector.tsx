import React from "react"
import { Box, Text } from "ink"

import type { AccountView } from "../types"

export function AccountSelector(props: { accounts: AccountView[]; selected: number }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">Select account</Text>
      </Box>
      <Text color="gray">Switch between Codex accounts. Applies to this session and future requests.</Text>
      <Box marginTop={1} flexDirection="column">
        {props.accounts.map((account, index) => (
          <Box key={account.key}>
            <Box width={5}>
              <Text color={index === props.selected ? "#aab3cf" : "gray"}>{index === props.selected ? "›" : " "}{index + 1}.</Text>
            </Box>
            <Box width={34}>
              <Text color={index === props.selected ? "green" : "white"}>
                {account.name}
                {index === props.selected ? " ✓" : ""}
              </Text>
            </Box>
            <Text color="gray">
              {account.email ? `${account.email} · ` : ""}
              {account.plan ? `${account.plan} · ` : ""}
              {account.accountId ? account.accountId.slice(0, 8) : account.key}
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">↑/↓ choose · Enter switch · Esc cancel</Text>
      </Box>
    </Box>
  )
}
