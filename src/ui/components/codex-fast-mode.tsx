import React from "react"
import { Box, Text } from "ink"

export function CodexFastModeSelector(props: { selected: number; current: boolean }) {
  const options = [
    { label: "on", description: 'Add service_tier: "priority" to /v1/responses' },
    { label: "off", description: "Default request body" },
  ]

  return (
    <Box borderStyle="round" borderColor="#7f4f45" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="#d97757">Codex fast mode</Text>
      <Text color="gray">Current: {props.current ? "on" : "off"}</Text>
      {options.map((option, index) => (
        <Box key={option.label}>
          <Box width={3}>
            <Text color={props.selected === index ? "#d97757" : "gray"}>{props.selected === index ? ">" : " "}</Text>
          </Box>
          <Box width={8}>
            <Text bold={props.selected === index}>{option.label}</Text>
          </Box>
          <Text color="#aab3cf">{option.description}</Text>
        </Box>
      ))}
    </Box>
  )
}

export function CodexFastModeStatus(props: { enabled: boolean }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text bold color="#a58a86">Codex fast: </Text>
        <Text bold color={props.enabled ? "#d97757" : "gray"}>{props.enabled ? "ON" : "OFF"}</Text>
      </Box>
      {props.enabled && <Text color="gray" wrap="truncate-end">Responses tier: priority</Text>}
    </Box>
  )
}
