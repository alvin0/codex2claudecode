import { Box, Text } from "ink";

import { getLocalNetworkIp } from "../../core/network"
import type { ProviderMode } from "../types"

type EndpointLine = { label: string; value: string }

export function WelcomePanel(props: { hostname: string; port: number; compact?: boolean; width?: number; providerMode?: ProviderMode }) {
  const width = props.width ?? 42
  const mode = props.providerMode ?? "codex"
  const title = `Codex2ClaudeCode - ${mode === "kiro" ? "Kiro" : "Codex"} Mode`
  const endpoints = welcomeEndpointLines(mode)
  const displayHostname = props.hostname === "0.0.0.0" || props.hostname === "::" ? "127.0.0.1" : props.hostname
  const localUrl = `http://${displayHostname}:${props.port}`
  const networkIp = getLocalNetworkIp()
  const networkUrl = networkIp ? `http://${networkIp}:${props.port}` : undefined

  return (
    <Box width={width} flexDirection="column" paddingX={1}>
      <Text bold wrap="truncate-end">{title}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="#a58a86">Connect</Text>
        <InfoLine label="Local" value={localUrl} />
        {networkUrl && <InfoLine label="Network" value={networkUrl} />}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="#a58a86">Supported endpoints</Text>
        {endpoints.map((endpoint, index) => (
          <InfoLine key={`${endpoint.label}-${endpoint.value}-${index}`} label={endpoint.label} value={endpoint.value} />
        ))}
      </Box>
    </Box>
  )
}

export function welcomeEndpointLines(mode: ProviderMode): EndpointLine[] {
  const claude = [
    { label: "Claude", value: "/v1/messages" },
    { label: "", value: "/v1/messages/count_tokens" },
  ]

  if (mode === "kiro") {
    return [
      ...claude,
      { label: "OpenAI", value: "/v1/responses" },
      { label: "", value: "/v1/chat/completions" },
      { label: "Runtime", value: "/health" },
    ]
  }

  return [
    ...claude,
    { label: "OpenAI", value: "/v1/responses" },
    { label: "", value: "/v1/chat/completions" },
    { label: "Runtime", value: "/usage" },
    { label: "", value: "/environments" },
    { label: "", value: "/health" },
  ]
}

function InfoLine(props: { label: string; value: string }) {
  return (
    <Box>
      <Box width={10}>
        <Text color="gray">{props.label ? `${props.label}:` : ""}</Text>
      </Box>
      <Text color="#aab3cf" wrap="truncate-end">{props.value}</Text>
    </Box>
  )
}
