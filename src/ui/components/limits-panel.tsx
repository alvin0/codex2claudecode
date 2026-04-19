import React from "react"
import { Box, Text } from "ink"

import type { LimitGroupView } from "../limits"

export function LimitsPanel(props: { limitGroups: LimitGroupView[]; loading?: boolean; error?: string }) {
  return (
    <Box flexDirection="column" marginTop={2}>
      <Text bold color="#a58a86">Limits</Text>
      {props.loading && <Text color="gray">Fetching limits...</Text>}
      {props.error && <Text color="red">{props.error}</Text>}
      {!props.loading && !props.error && !props.limitGroups.length && <Text color="gray">No limits available</Text>}
      {props.limitGroups.map((group, groupIndex) => (
        <Box key={`${group.title ?? "default"}-${groupIndex}`} flexDirection="column" marginTop={group.title ? 1 : 0}>
          {group.title && <Text color="gray">{group.title}</Text>}
          {group.rows.map((row) => (
            <LimitRow key={`${group.title ?? "default"}-${row.label}`} label={row.label} used={row.used} left={row.left} reset={row.reset} />
          ))}
        </Box>
      ))}
    </Box>
  )
}

function LimitRow(props: { label: string; used: number; left: string; reset: string }) {
  return (
    <Box>
      <Box width={24}>
        <Text color="gray">{props.label}</Text>
      </Box>
      <Text>[</Text>
      <Text color="#f4f1eb">{progressBar(props.used)}</Text>
      <Text>] </Text>
      <Box width={11}>
        <Text bold>{props.left}</Text>
      </Box>
      <Text color="gray">({props.reset})</Text>
    </Box>
  )
}

function progressBar(used: number) {
  const width = 18
  const filled = Math.max(0, Math.min(width, Math.round((used / 100) * width)))
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`
}
