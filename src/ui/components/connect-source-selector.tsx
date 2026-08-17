import React from "react"
import { Box, Text } from "ink"

import type { ProviderAccountConnectDefinition, ProviderConnectProgress } from "../providers/types"

export function ConnectSourceSelector(props: { connect: ProviderAccountConnectDefinition; selected: number; saving?: boolean; status?: string; progress?: ProviderConnectProgress }) {
  const entries = [
    ...props.connect.sources.map((source) => ({ label: source.label, description: source.description })),
    { label: "Manual", description: props.connect.manualDescription },
  ]

  const activeMessage = props.status ?? (props.saving ? (props.connect.sources[props.selected]?.savingMessage ?? undefined) : undefined)
  const messageColor = activeMessage?.startsWith("Connect failed:") ? "#fca5a5" : "gray"

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
      {props.progress?.verificationUri && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="#3b82f6" paddingX={1} paddingY={1}>
          <Text bold color="#93c5fd">{props.progress.userCode ? "Device code login" : "Browser login"}</Text>
          {props.progress.message && <Text color="gray">{props.progress.message}</Text>}
          <Box marginTop={1} flexDirection="column">
            <Text color="gray">Open this URL in your browser:</Text>
            <Text color="#67e8f9">{props.progress.verificationUri}</Text>
          </Box>
          {props.progress.userCode && (
            <Box marginTop={1} flexDirection="column">
              <Text color="gray">Enter this code:</Text>
              <Text bold color="white">{props.progress.userCode}</Text>
            </Box>
          )}
        </Box>
      )}
      {activeMessage && (
        <Box marginTop={1}>
          <Text color={props.saving ? "gray" : messageColor}>{activeMessage}</Text>
        </Box>
      )}
    </Box>
  )
}
