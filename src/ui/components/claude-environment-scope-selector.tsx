import { Box, Text } from "ink"

import { claudeSettingsScopeLabel, type ClaudeSettingsScope } from "../claude-env"

const OPTIONS: Array<{ scope: ClaudeSettingsScope; title: string; description: string; recommended?: boolean }> = [
  {
    scope: "user",
    title: "User",
    description: "You, across all projects",
    recommended: true,
  },
  {
    scope: "project",
    title: "Project",
    description: "All collaborators in this repository",
  },
  {
    scope: "local",
    title: "Local",
    description: "You only, in this repository",
  },
]

export function ClaudeEnvironmentScopeSelector(props: { selected: number; action: "set" | "unset" }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="#c7d2fe">Choose Claude Settings Scope</Text>
        <Text color="gray">Default selection is User because it is usually the safest and clearest place to configure Claude Code.</Text>
        <Text color="gray">Controls: ↑/↓ move · Enter continue · Esc cancel</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {OPTIONS.map((option, index) => (
          <Box key={option.scope} flexDirection="column" marginBottom={1}>
            <Box>
              <Box width={2}>
                <Text color={props.selected === index ? "#d97757" : "gray"}>{props.selected === index ? "›" : " "}</Text>
              </Box>
              <Box width={12}>
                <Text color={props.selected === index ? "white" : "#c0caf5"}>{option.title}</Text>
              </Box>
              <Box width={30}>
                <Text color="#aab3cf">{claudeSettingsScopeLabel(option.scope)}</Text>
              </Box>
              <Text color={option.recommended ? "#98c379" : "gray"}>{option.recommended ? "Recommended" : ""}</Text>
            </Box>
            <Box marginLeft={2}>
              <Text color="gray">{option.description}</Text>
            </Box>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">{props.action === "set" ? "The selected scope will receive updated env values." : "The selected scope will have managed env values removed."}</Text>
      </Box>
    </Box>
  )
}
