import React from "react"
import { Box, Text } from "ink"

export const CONNECT_SOURCES = [
  { label: "Add from ~/.codex/auth.json", description: "Import ChatGPT tokens from Codex CLI auth file" },
  { label: "Manual", description: "Paste accountId, accessToken, and refreshToken manually" },
]

export function ConnectSourceSelector(props: { selected: number; saving?: boolean }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">Connect Codex account</Text>
        <Text color="gray">  ↑/↓ choose · Enter continue · Esc cancel</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {CONNECT_SOURCES.map((source, index) => (
          <Box key={source.label}>
            <Box width={4}>
              <Text color={index === props.selected ? "#d97757" : "gray"}>{index === props.selected ? "›" : " "}{index + 1}.</Text>
            </Box>
            <Box width={32}>
              <Text color={index === props.selected ? "white" : "#aab3cf"}>{source.label}</Text>
            </Box>
            <Text color="gray">{source.description}</Text>
          </Box>
        ))}
      </Box>
      {props.saving && (
        <Box marginTop={1}>
          <Text color="gray">Importing from ~/.codex/auth.json...</Text>
        </Box>
      )}
    </Box>
  )
}
