import { Box, Text } from "ink";

import type { ProviderMode } from "../types"

export function WelcomePanel(props: { hostname: string; port: number; compact?: boolean; width?: number; providerMode?: ProviderMode }) {
  const width = props.width ?? 42
  const mode = props.providerMode ?? "codex"

  return (
    <Box width={width} flexDirection="column" paddingX={1}>
      <Text bold wrap="truncate-end">{mode === "kiro" ? "Codex2ClaudeCode · Kiro" : "Codex2ClaudeCode"}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="#a58a86">Connect</Text>
        <InfoLine label="Base URL" value={`http://${props.hostname}:${props.port}`} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="#a58a86">Supported endpoints</Text>
        <InfoLine label="Claude" value="/v1/messages" />
        <InfoLine label="" value="/v1/messages/count_tokens" />
        {mode === "codex" && (
          <>
            <InfoLine label="OpenAI" value="/v1/responses" />
            <InfoLine label="" value="/v1/chat/completions" />
          </>
        )}
        {mode === "kiro" ? (
          <InfoLine label="Runtime" value="/health" />
        ) : props.compact ? (
          <>
            <InfoLine label="Runtime" value="/usage" />
            <InfoLine label="" value="/environments" />
            <InfoLine label="" value="/health" />
          </>
        ) : (
          <InfoLine label="Runtime" value="/usage · /environments · /health" />
        )}
      </Box>
    </Box>
  )
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
