import React from "react"
import { Box, Text } from "ink"

import type { ProviderMode } from "../types"
import type { EndpointShareEndpointOption, EndpointShareSourceOption } from "../endpoint-share"

export function EndpointShareWizard(props: {
  providerMode: ProviderMode
  step: number
  endpointOptions: EndpointShareEndpointOption[]
  sourceOptions: EndpointShareSourceOption[]
  selectedEndpoint: number
  selectedSource: number
  saving?: boolean
  status?: string
}) {
  const selectedEndpoint = props.endpointOptions[props.selectedEndpoint]
  const selectedSource = props.sourceOptions[props.selectedSource]

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">Endpoint share</Text>
        <Text color="gray">  ↑/↓ choose · Enter continue · Esc cancel</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Current provider: </Text>
        <Text bold color="#f8fafc">{providerLabel(props.providerMode)}</Text>
      </Box>

      {props.step === 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Select the endpoint to proxy.</Text>
          {props.endpointOptions.map((option, index) => (
            <Box key={option.endpoint}>
              <Box width={4}>
                <Text color={index === props.selectedEndpoint ? "#d97757" : "gray"}>{index === props.selectedEndpoint ? "›" : " "}{index + 1}.</Text>
              </Box>
              <Box width={24}>
                <Text color={index === props.selectedEndpoint ? "white" : "#aab3cf"}>{option.label}</Text>
              </Box>
              <Text color={option.value === "Unavailable" ? "red" : "gray"}>{option.value}</Text>
            </Box>
          ))}
        </Box>
      )}

      {props.step === 1 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Select the source provider for {selectedEndpoint?.label ?? "this endpoint"}.</Text>
          {props.sourceOptions.map((option, index) => (
            <Box key={`${option.target}-${index}`}>
              <Box width={4}>
                <Text color={index === props.selectedSource ? "#d97757" : "gray"}>{index === props.selectedSource ? "›" : " "}{index + 1}.</Text>
              </Box>
              <Box width={16}>
                <Text color={index === props.selectedSource ? "white" : option.available ? "#aab3cf" : "gray"}>
                  {option.label}
                  {option.current ? " (current)" : ""}
                  {index === props.selectedSource ? " ✓" : ""}
                </Text>
              </Box>
              <Text color={option.available ? "gray" : "red"}>{option.description}</Text>
            </Box>
          ))}
        </Box>
      )}

      {props.step === 2 && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="#7f4f45" paddingX={1} paddingY={1}>
          <Text bold color="#d97757">Confirm route proxy</Text>
          <Box marginTop={1}>
            <Text color="gray">Endpoint: </Text>
            <Text bold color="#f8fafc">{selectedEndpoint?.label ?? "Unknown"}</Text>
            <Text color="gray"> → </Text>
            <Text bold color="#f8fafc">{selectedSource?.label ?? "Unknown"}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color="yellow">This will update provider-state.json and restart the runtime.</Text>
            <Text color="gray">Only OpenAI-compatible routes are affected.</Text>
          </Box>
        </Box>
      )}

      {props.status && (
        <Box marginTop={1}>
          <Text color={props.saving ? "gray" : props.status.startsWith("Failed") ? "red" : "gray"}>{props.status}</Text>
        </Box>
      )}
    </Box>
  )
}

function providerLabel(mode: ProviderMode) {
  return mode === "codex" ? "Codex" : mode === "kiro" ? "Kiro" : "Copilot"
}
