import React from "react"
import { Box, Text } from "ink"

import type { KiroConnectDraft } from "../../connect-kiro"

const FIELDS = [
  { key: "refreshToken", label: "refreshToken", secret: true, hint: "Kiro desktop refresh token (required)" },
  { key: "region", label: "region", secret: false, hint: "AWS region (default: us-east-1)" },
] as const

export function ConnectKiroWizard(props: { draft: KiroConnectDraft; step: number; saving?: boolean; error?: string }) {
  const current = FIELDS[props.step]
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">Connect Kiro account</Text>
        <Text color="gray">  Enter next · Esc cancel</Text>
      </Box>
      <Text color="gray">Paste your Kiro credentials. Token is hidden while typing.</Text>
      <Box marginTop={1} flexDirection="column">
        {FIELDS.map((field, index) => (
          <Box key={field.key}>
            <Box width={2}>
              <Text color={index === props.step ? "#d97757" : "gray"}>{index === props.step ? "›" : " "}</Text>
            </Box>
            <Box width={16}>
              <Text color={index === props.step ? "white" : "gray"}>{field.label}:</Text>
            </Box>
            <Text color={index === props.step ? "#d97757" : "#aab3cf"}>{displayValue(props.draft[field.key], field.secret)}</Text>
            {index === props.step && !props.saving && <Text inverse> </Text>}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        {props.error ? (
          <Text color="red">{props.error}</Text>
        ) : (
          <Text color="gray">
            {props.saving
              ? "Validating and saving Kiro credentials..."
              : `Editing ${current.label}. ${current.hint}`}
          </Text>
        )}
      </Box>
    </Box>
  )
}

export function updateKiroConnectDraft(draft: KiroConnectDraft, step: number, update: (value: string) => string): KiroConnectDraft {
  const keys = ["refreshToken", "region"] as const
  const key = keys[step]
  return { ...draft, [key]: update(draft[key]) }
}

function displayValue(value: string, secret: boolean) {
  if (!value) return ""
  if (!secret) return value
  return "•".repeat(Math.min(value.length, 48))
}
