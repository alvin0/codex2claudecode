import { Box, Text } from "ink"

import { claudeEnvironmentUnsetCommands, type ClaudeEnvironmentDraft, type ShellKind } from "../claude-env"

export function ClaudeEnvironmentUnsetConfirm(props: { draft: ClaudeEnvironmentDraft; shell: ShellKind; settingsTarget: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">Confirm unset Claude environment</Text>
        <Text color="gray">  Enter/y apply · n/Esc cancel</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {claudeEnvironmentUnsetCommands(props.draft, props.shell).map((line) => (
          <Text key={line} color="#aab3cf">{line}</Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">Remove these keys from {props.settingsTarget} env?</Text>
        <Text color="gray">Press Enter or y to save · n or Esc to cancel.</Text>
      </Box>
    </Box>
  )
}
