import { Box, Text } from "ink"

export interface SwitchProviderOption {
  label: string
  current?: boolean
}

export function SwitchProviderConfirm(props: { currentLabel: string; options: SwitchProviderOption[]; selected: number }) {
  return (
    <Box borderStyle="round" borderColor="#7f4f45" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="#d97757">Switch upstream provider</Text>
      <Box marginTop={1}>
        <Text color="#aab3cf">Current: <Text bold>{props.currentLabel}</Text></Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {props.options.map((option, index) => (
          <Box key={option.label}>
            <Box width={4}>
              <Text color={props.selected === index ? "#d97757" : "gray"}>{props.selected === index ? "›" : " "}</Text>
            </Box>
            <Box width={14}>
              <Text bold={props.selected === index}>{option.label}</Text>
            </Box>
            <Text color={option.current ? "#aab3cf" : "gray"}>{option.current ? "current" : "switch target"}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="yellow">⚠ The runtime will restart and active connections will be interrupted.</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">↑/↓ choose · </Text>
        <Text bold>Enter</Text>
        <Text color="gray"> switch · </Text>
        <Text bold>Escape</Text>
        <Text color="gray"> cancel</Text>
      </Box>
    </Box>
  )
}
