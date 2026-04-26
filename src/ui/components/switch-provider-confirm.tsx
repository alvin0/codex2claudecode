import { Box, Text } from "ink"

export function SwitchProviderConfirm(props: { currentLabel: string; targetLabel: string }) {
  return (
    <Box borderStyle="round" borderColor="#7f4f45" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="#d97757">Switch upstream provider</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="#aab3cf">Current: <Text bold>{props.currentLabel}</Text></Text>
        <Text color="#aab3cf">Target:  <Text bold>{props.targetLabel}</Text></Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">⚠ The runtime will restart and active connections will be interrupted.</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Press </Text>
        <Text bold>Enter</Text>
        <Text color="gray"> to confirm or </Text>
        <Text bold>Escape</Text>
        <Text color="gray"> to cancel</Text>
      </Box>
    </Box>
  )
}
