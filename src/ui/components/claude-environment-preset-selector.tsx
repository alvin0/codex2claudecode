import { Box, Text } from "ink"

export interface ClaudeEnvPresetOption {
  key: string
  title: string
  description: string
  tag?: string
}

const PRESET_OPTIONS: ClaudeEnvPresetOption[] = [
  {
    key: "recommend",
    title: "Recommend setting",
    description: "Use recommended model defaults from export config",
    tag: "Recommended",
  },
  {
    key: "latest",
    title: "Latest setting",
    description: "Load current values from the selected settings file",
    tag: "Current",
  },
  {
    key: "skip",
    title: "Skip to editor",
    description: "Go directly to the environment editor with current draft",
  },
]

export { PRESET_OPTIONS }

export function ClaudeEnvironmentPresetSelector(props: { selected: number; settingsTarget: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="#c7d2fe">Load Preset or Continue</Text>
        <Text color="gray">Optionally load a preset before editing. Target: {props.settingsTarget}</Text>
        <Text color="gray">Controls: ↑/↓ move · Enter continue · Esc cancel</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {PRESET_OPTIONS.map((option, index) => (
          <Box key={option.key} flexDirection="column" marginBottom={1}>
            <Box>
              <Box width={2}>
                <Text color={props.selected === index ? "#d97757" : "gray"}>{props.selected === index ? "›" : " "}</Text>
              </Box>
              <Box width={24}>
                <Text color={props.selected === index ? "white" : "#c0caf5"}>{option.title}</Text>
              </Box>
              <Text color={option.tag === "Recommended" ? "#98c379" : option.tag ? "#e5c07b" : "gray"}>{option.tag ?? ""}</Text>
            </Box>
            <Box marginLeft={2}>
              <Text color="gray">{option.description}</Text>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
