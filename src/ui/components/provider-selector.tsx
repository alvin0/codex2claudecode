import { Box, Text } from "ink"

import type { ProviderName } from "../../llm-connect/factory"

const PROVIDERS: Array<{ name: ProviderName; label: string; description: string }> = [
  { name: "codex", label: "Codex", description: "OpenAI / ChatGPT backend" },
  { name: "kiro", label: "Kiro", description: "AWS Kiro backend" },
]

export function ProviderSelector(props: { selected: number; current: ProviderName }) {
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold color="#a58a86">
        Switch LLM Provider{" "}
        <Text color="gray">(current: {props.current})</Text>
      </Text>
      {PROVIDERS.map((provider, index) => (
        <Box key={provider.name}>
          <Text color={index === props.selected ? "#d97757" : "gray"}>
            {index === props.selected ? "❯ " : "  "}
          </Text>
          <Text bold={index === props.selected} color={provider.name === props.current ? "#aab3cf" : undefined}>
            {provider.label}
          </Text>
          <Text color="gray"> — {provider.description}</Text>
          {provider.name === props.current && <Text color="#d97757"> (active)</Text>}
        </Box>
      ))}
      <Text color="gray" dimColor>
        ↑↓ navigate · Enter select · Esc cancel
      </Text>
    </Box>
  )
}

export { PROVIDERS }
