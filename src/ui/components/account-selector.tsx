import React from "react"
import { Box, Text } from "ink"

import type { AccountView } from "../types"

export function AccountSelector(props: { accounts: AccountView[]; selected: number; title?: string; description?: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">{props.title ?? "Select account"}</Text>
      </Box>
      <Text color="gray">{props.description ?? "Switch accounts. Applies to this session and future requests."}</Text>
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
              {accountDetail(account)}
            </Text>
          </Box>
        ))}
        {!props.accounts.length && <Text color="gray">No accounts available. Use /connect to add one.</Text>}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">↑/↓ choose · Enter switch · Esc cancel</Text>
      </Box>
    </Box>
  )
}

function accountDetail(account: AccountView) {
  if (account.detail) return account.detail
  return [
    account.email,
    account.plan,
    account.accountId ? account.accountId.slice(0, 8) : account.key,
  ].filter(Boolean).join(" · ")
}
