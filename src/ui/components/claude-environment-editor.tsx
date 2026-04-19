import { Box, Text } from "ink"

import { CLAUDE_MODEL_ENV_KEYS, claudeEnvironmentExports, type ClaudeEnvironmentDraft } from "../claude-env"

export function ClaudeEnvironmentEditor(props: {
  draft: ClaudeEnvironmentDraft
  selected: number
  baseUrl: string
  confirm: boolean
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">{props.confirm ? "Confirm Claude environment" : "Edit Claude environment"}</Text>
        <Text color="gray">  ↑/↓ field · type edit · Enter {props.confirm ? "apply" : "confirm"} · Esc cancel</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {claudeEnvironmentExports(props.draft, props.baseUrl).slice(0, 3).map((line) => (
          <Text key={line} color="gray">{line}</Text>
        ))}
        {CLAUDE_MODEL_ENV_KEYS.map((key, index) => (
          <Box key={key}>
            <Box width={2}>
              <Text color={props.selected === index ? "#d97757" : "gray"}>{props.selected === index ? "›" : " "}</Text>
            </Box>
            <Box width={38}>
              <Text color={props.selected === index ? "white" : "#aab3cf"}>export {key}=</Text>
            </Box>
            <Text color={props.selected === index ? "#d97757" : "gray"}>"{props.draft[key]}"</Text>
            {props.selected === index && !props.confirm && <Text inverse> </Text>}
          </Box>
        ))}
      </Box>
      {props.confirm && (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">Apply these values to the current Codex2ClaudeCode process?</Text>
          <Text color="gray">Press Enter or y to apply · n or Esc to cancel. Shell parent env cannot be changed from here.</Text>
        </Box>
      )}
    </Box>
  )
}
