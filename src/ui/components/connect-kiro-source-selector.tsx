import React from "react"
import { Box, Text } from "ink"

export const KIRO_CONNECT_SOURCES = [
  { label: "Sync from AWS SSO cache", description: "Import from ~/.aws/sso/cache/kiro-auth-token.json" },
  { label: "Manual", description: "Paste refreshToken and region manually" },
]

export function ConnectKiroSourceSelector(props: { selected: number; saving?: boolean }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">Connect Kiro account</Text>
        <Text color="gray">  ↑/↓ choose · Enter continue · Esc cancel</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {KIRO_CONNECT_SOURCES.map((source, index) => (
          <Box key={source.label}>
            <Box width={4}>
              <Text color={index === props.selected ? "#d97757" : "gray"}>{index === props.selected ? "›" : " "}{index + 1}.</Text>
            </Box>
            <Box width={30}>
              <Text color={index === props.selected ? "white" : "#aab3cf"}>{source.label}</Text>
            </Box>
            <Text color="gray">{source.description}</Text>
          </Box>
        ))}
      </Box>
      {props.saving && (
        <Box marginTop={1}>
          <Text color="gray">Importing from AWS SSO cache...</Text>
        </Box>
      )}
    </Box>
  )
}
