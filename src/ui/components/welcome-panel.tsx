import { Box, Text } from "ink";

export function WelcomePanel(props: { hostname: string; port: number; compact?: boolean; width?: number }) {
  const width = props.width ?? 42

  return (
    <Box width={width} flexDirection="column" paddingX={1}>
      <Text bold wrap="truncate-end">Codex2ClaudeCode</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="#a58a86">Connect</Text>
        <InfoLine label="Base URL" value={`http://${props.hostname}:${props.port}`} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="#a58a86">Supported endpoints</Text>
        <InfoLine label="Claude" value="/v1/messages" />
        <InfoLine label="" value="/v1/messages/count_tokens" />
        <InfoLine label="OpenAI" value="/v1/responses" />
        <InfoLine label="" value="/v1/chat/completions" />
        {props.compact ? (
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
