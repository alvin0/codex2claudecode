import React from "react"
import { Box, Text } from "ink"

import type { ProviderAccountConnectDefinition } from "../providers/types"

export function ConnectSourceSelector(props: { connect: ProviderAccountConnectDefinition; selected: number; saving?: boolean }) {
  const entries = [
    ...props.connect.sources.map((source) => ({ label: source.label, description: source.description })),
    { label: "Manual", description: props.connect.manualDescription },
  ]

  const activeSavingMessage = props.saving
    ? (props.connect.sources[props.selected]?.savingMessage ?? undefined)
    : undefined

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">{props.connect.title}</Text>
        <Text color="gray">  ↑/↓ choose · Enter continue · Esc cancel</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {entries.map((entry, index) => (
          <Box key={entry.label}>
            <Box width={4}>
              <Text color={index === props.selected ? "#d97757" : "gray"}>{index === props.selected ? "›" : " "}{index + 1}.</Text>
            </Box>
            <Box width={32}>
              <Text color={index === props.selected ? "white" : "#aab3cf"}>{entry.label}</Text>
            </Box>
            <Text color="gray">{entry.description}</Text>
          </Box>
        ))}
      </Box>
      {activeSavingMessage && (
        <Box marginTop={1}>
          <Text color="gray">{activeSavingMessage}</Text>
        </Box>
      )}
    </Box>
  )
}
