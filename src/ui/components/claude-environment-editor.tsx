import { Box, Text } from "ink"

import {
  CLAUDE_MODEL_ENV_KEYS,
  EXPORT_ENV_EXTRA_EDITABLE_KEYS,
  EXPORT_ENV_STATIC_ENTRIES,
  type ClaudeEnvironmentDraft,
  type ShellKind,
} from "../claude-env"

export function ClaudeEnvironmentEditor(props: {
  draft: ClaudeEnvironmentDraft
  selected: number
  baseUrl: string
  confirm: boolean
  shell: ShellKind
  settingsTarget: string
  apiPassword?: string
}) {
  const modelKeyCount = CLAUDE_MODEL_ENV_KEYS.length
  const authValue = props.apiPassword || EXPORT_ENV_STATIC_ENTRIES.find((e) => e.key === "ANTHROPIC_AUTH_TOKEN")?.value || "codex2claudecode"
  const lockedEntries: Array<{ key: string; value: string }> = [
    { key: "ANTHROPIC_BASE_URL", value: props.baseUrl },
    ...EXPORT_ENV_STATIC_ENTRIES.map((entry) =>
      entry.key === "ANTHROPIC_AUTH_TOKEN" || entry.key === "ANTHROPIC_API_KEY"
        ? { ...entry, value: authValue }
        : entry,
    ),
  ]

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="#c7d2fe">{props.confirm ? "Confirm Claude Environment" : "Edit Claude Environment"}</Text>
        <Text color="gray">Target: {props.settingsTarget} → env</Text>
        <Text color="gray">↑/↓ move · type edit · Enter {props.confirm ? "save" : "confirm"} · Esc cancel</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="#7aa2f7">{"── Locked ──"}</Text>
        {lockedEntries.map((entry) => (
          <LockedRow key={entry.key} name={entry.key} value={entry.value} />
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="#7aa2f7">{"── Editable ──"}</Text>
        {CLAUDE_MODEL_ENV_KEYS.map((key, index) => (
          <EditableRow key={key} name={key} value={props.draft[key]} active={props.selected === index} confirm={props.confirm} />
        ))}
        {EXPORT_ENV_EXTRA_EDITABLE_KEYS.map((key, index) => (
          <EditableRow
            key={key}
            name={key}
            value={props.draft.extraEnv[key] ?? ""}
            active={props.selected === modelKeyCount + index}
            confirm={props.confirm}
          />
        ))}
      </Box>

      {props.draft.unsetEnv.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="#7aa2f7">{"── Unset On Save ──"}</Text>
          {props.draft.unsetEnv.map((key) => (
            <Text key={key} color="#ff9e64">  delete {key}</Text>
          ))}
        </Box>
      )}

      {props.confirm && (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">Write these values into {props.settingsTarget} env?</Text>
          <Text color="gray">Enter or y to save · n or Esc to cancel</Text>
        </Box>
      )}
    </Box>
  )
}

function LockedRow(props: { name: string; value: string }) {
  return (
    <Box>
      <Box width={40}>
        <Text color="#636a83">  {props.name}</Text>
      </Box>
      <Text color="#636a83">{props.value}</Text>
    </Box>
  )
}

function EditableRow(props: { name: string; value: string; active: boolean; confirm: boolean }) {
  return (
    <Box>
      <Box width={2}>
        <Text color={props.active ? "#d97757" : "gray"}>{props.active ? "›" : " "}</Text>
      </Box>
      <Box width={38}>
        <Text color={props.active ? "white" : "#aab3cf"}>{props.name}</Text>
      </Box>
      <Text color={props.active ? "#d97757" : "#c0caf5"}>{props.value}</Text>
      {props.active && !props.confirm && <Text inverse> </Text>}
    </Box>
  )
}
