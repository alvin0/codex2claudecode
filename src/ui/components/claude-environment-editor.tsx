import { Box, Text } from "ink"

import { CLAUDE_CODE_ENV_CONFIG } from "../../claude-code-env.config"
import { CLAUDE_ENV_FIXED, CLAUDE_MODEL_ENV_KEYS, type ClaudeEnvironmentDraft, type ShellKind } from "../claude-env"

export function ClaudeEnvironmentEditor(props: {
  draft: ClaudeEnvironmentDraft
  selected: number
  baseUrl: string
  confirm: boolean
  shell: ShellKind
  settingsTarget: string
}) {
  const defaultExtraKeys = new Set(Object.keys(CLAUDE_CODE_ENV_CONFIG.defaultExtraEnv))
  const defaultExtraEntries = Object.entries(props.draft.extraEnv).filter(([key]) => defaultExtraKeys.has(key))
  const customExtraEntries = Object.entries(props.draft.extraEnv).filter(([key]) => !defaultExtraKeys.has(key))

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="#c7d2fe">{props.confirm ? "Confirm Claude Environment" : "Edit Claude Environment"}</Text>
        <Text color="gray">Settings target: {props.settingsTarget} → env</Text>
        <Text color="gray">Controls: ↑/↓ move · type edit · Enter {props.confirm ? "save" : "confirm"} · Esc cancel</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <SectionLabel label="Auto Generated" />
        <PreviewRow name="ANTHROPIC_BASE_URL" value={props.baseUrl} color="#8ad7ff" />

        <SectionLabel label="Locked Values" />
        {Object.entries(CLAUDE_ENV_FIXED).map(([key, value]) => (
          <PreviewRow key={key} name={key} value={value} color="#aab3cf" />
        ))}

        <SectionLabel label="Editable Models" />
        {CLAUDE_MODEL_ENV_KEYS.map((key, index) => (
          <EditableRow key={key} name={key} value={props.draft[key]} active={props.selected === index} confirm={props.confirm} />
        ))}

        {defaultExtraEntries.length > 0 && (
          <>
            <SectionLabel label="Default Extra Env" />
            {defaultExtraEntries.map(([key, value]) => (
              <PreviewRow key={key} name={key} value={value} color="#98c379" />
            ))}
          </>
        )}

        {customExtraEntries.length > 0 && (
          <>
            <SectionLabel label="Custom Extra Env" />
            {customExtraEntries.map(([key, value]) => (
              <PreviewRow key={key} name={key} value={value} color="#e5c07b" />
            ))}
          </>
        )}

        {props.draft.unsetEnv.length > 0 && (
          <>
            <SectionLabel label="Unset On Save" />
            {props.draft.unsetEnv.map((key) => (
              <Text key={key} color="#ff9e64">delete env.{key}</Text>
            ))}
          </>
        )}
      </Box>
      {props.confirm && (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">Write these values into {props.settingsTarget} env?</Text>
          <Text color="gray">Press Enter or y to save · n or Esc to cancel.</Text>
        </Box>
      )}
    </Box>
  )
}

function SectionLabel(props: { label: string }) {
  return (
    <Box marginTop={1}>
      <Text bold color="#7aa2f7">{props.label}</Text>
    </Box>
  )
}

function PreviewRow(props: { name: string; value: string; color: string }) {
  return (
    <Box>
      <Box width={34}>
        <Text color="#aab3cf">env.{props.name}</Text>
      </Box>
      <Box width={3}>
        <Text color="gray">=</Text>
      </Box>
      <Text color={props.color}>{JSON.stringify(props.value)}</Text>
    </Box>
  )
}

function EditableRow(props: { name: string; value: string; active: boolean; confirm: boolean }) {
  return (
    <Box>
      <Box width={2}>
        <Text color={props.active ? "#d97757" : "gray"}>{props.active ? "›" : " "}</Text>
      </Box>
      <Box width={32}>
        <Text color={props.active ? "white" : "#aab3cf"}>{props.name}</Text>
      </Box>
      <Box width={3}>
        <Text color="gray">=</Text>
      </Box>
      <Text color={props.active ? "#d97757" : "#c0caf5"}>{JSON.stringify(props.value)}</Text>
      {props.active && !props.confirm && <Text inverse> </Text>}
    </Box>
  )
}
