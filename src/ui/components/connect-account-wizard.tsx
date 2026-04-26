import React from "react"
import { Box, Text } from "ink"

import type { ProviderConnectDraft, ProviderConnectField } from "../providers/types"

export function ConnectAccountWizard(props: { title: string; description: string; draft: ProviderConnectDraft; fields: ProviderConnectField[]; step: number; saving?: boolean }) {
  const current = props.fields[props.step] ?? props.fields[0]
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">{props.title}</Text>
        <Text color="gray">  Enter next · Esc cancel</Text>
      </Box>
      <Text color="gray">{props.description}</Text>
      <Box marginTop={1} flexDirection="column">
        {props.fields.map((field, index) => (
          <Box key={field.key}>
            <Box width={2}>
              <Text color={index === props.step ? "#d97757" : "gray"}>{index === props.step ? "›" : " "}</Text>
            </Box>
            <Box width={14}>
              <Text color={index === props.step ? "white" : "gray"}>{field.label}:</Text>
            </Box>
            <Text color={index === props.step ? "#d97757" : "#aab3cf"}>{displayValue(props.draft[field.key] ?? "", Boolean(field.secret))}</Text>
            {index === props.step && !props.saving && <Text inverse> </Text>}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          {props.saving
            ? "Saving account..."
            : `Editing ${current.label}. ${fieldHint(current)}`}
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

function fieldHint(field: ProviderConnectField) {
  if (field.secret) return "Input is masked."
  if (field.optional) return "This field can be left empty."
  return "This field is required."
}
