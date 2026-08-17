import { Box, Text } from "ink"

import { CODEX_CLI_MODES, codexCliStaticEntries } from "../codex-cli"

export function CodexCliSetup(props: {
  baseUrl: string
  profilePath: string
  models: string[]
  selected: number
  loading?: boolean
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="#c7d2fe">Point Codex CLI at this gateway</Text>
        <Text color="gray">Target: {props.profilePath}</Text>
        <Text color="gray">↑/↓ move · Enter write · Esc cancel</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="#7aa2f7">{"── When to use the gateway ──"}</Text>
        {CODEX_CLI_MODES.map((mode, index) => (
          <Box key={mode.label}>
            <Box width={3}>
              <Text color={props.selected === index ? "#d97757" : "gray"}>{props.selected === index ? ">" : " "}</Text>
            </Box>
            <Box width={10}>
              <Text bold={props.selected === index}>{mode.label}</Text>
            </Box>
            <Text color="#aab3cf">{mode.description}</Text>
          </Box>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="#7aa2f7">{"── Added to config.toml ──"}</Text>
        {codexCliStaticEntries(props.baseUrl).map((entry) => (
          <Box key={entry.key}>
            <Box width={22}>
              <Text color="#aab3cf">  {entry.key}</Text>
            </Box>
            <Text color="#c0caf5">{entry.value}</Text>
          </Box>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="#7aa2f7">{"── Models Codex will see ──"}</Text>
        {props.models.slice(0, 8).map((model) => (
          <Text key={model} color="gray">  {model}</Text>
        ))}
        {props.models.length > 8 && <Text color="gray">  … {props.models.length - 8} more</Text>}
        {props.models.length === 0 && <Text color="gray">  {props.loading ? "loading…" : "none yet — the list is served from /v1/models"}</Text>}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Codex reads this list itself and picks the reasoning effort on its own.</Text>
        <Text color="#e5c07b">Your config.toml is backed up before the provider block is added.</Text>
      </Box>
    </Box>
  )
}
