import React from "react"
import { Box, Text } from "ink"

import type { ConnectAccountDraft } from "../../upstream/codex/connect-account"

const FIELDS = [
  { key: "accountId", label: "accountId", secret: false },
  { key: "accessToken", label: "accessToken", secret: true },
  { key: "refreshToken", label: "refreshToken", secret: true },
] as const

export function ConnectAccountWizard(props: { draft: ConnectAccountDraft; step: number; saving?: boolean }) {
  const current = FIELDS[props.step]
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">Connect Codex account</Text>
        <Text color="gray">  Enter next · Esc cancel</Text>
      </Box>
      <Text color="gray">Paste account credentials. Tokens are hidden while typing.</Text>
      <Box marginTop={1} flexDirection="column">
        {FIELDS.map((field, index) => (
          <Box key={field.key}>
            <Box width={2}>
              <Text color={index === props.step ? "#d97757" : "gray"}>{index === props.step ? "›" : " "}</Text>
            </Box>
            <Box width={14}>
              <Text color={index === props.step ? "white" : "gray"}>{field.label}:</Text>
            </Box>
            <Text color={index === props.step ? "#d97757" : "#aab3cf"}>{displayValue(props.draft[field.key], field.secret)}</Text>
            {index === props.step && !props.saving && <Text inverse> </Text>}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          {props.saving
            ? "Saving account..."
            : `Editing ${current.label}. ${current.secret ? "Input is masked." : "Account ID can be left empty if token contains it."}`}
        </Text>
      </Box>
    </Box>
  )
}

function displayValue(value: string, secret: boolean) {
  if (!value) return ""
  if (!secret) return value
  return "•".repeat(Math.min(value.length, 48))
}
