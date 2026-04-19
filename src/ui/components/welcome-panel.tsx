import { Box, Text } from "ink";

export function WelcomePanel(props: { hostname: string; port: number }) {
  return (
    <Box width={54} flexDirection="column" alignItems="center" justifyContent="center" paddingX={2}>
      <Text bold>Codex2ClaudeCode</Text>
      <Box marginTop={2} width={50} flexDirection="column">
        <Text bold color="#a58a86">Connect</Text>
        <InfoLine label="Base URL" value={`http://${props.hostname}:${props.port}`} />
      </Box>
      <Box marginTop={1} width={50} flexDirection="column">
        <Text bold color="#a58a86">Supported endpoints</Text>
        <InfoLine label="Claude" value="/v1/messages" />
        <InfoLine label="" value="/v1/messages/count_tokens" />
        <InfoLine label="OpenAI" value="/v1/responses" />
        <InfoLine label="" value="/v1/chat/completions" />
        <InfoLine label="Runtime" value="/usage · /environments · /health" />
      </Box>
    </Box>
  )
}

function InfoLine(props: { label: string; value: string }) {
  return (
    <Box>
      <Box width={12}>
        <Text color="gray">{props.label ? `${props.label}:` : ""}</Text>
      </Box>
      <Text color="#aab3cf">{props.value}</Text>
    </Box>
  )
}
