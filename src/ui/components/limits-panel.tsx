import React, { useEffect, useState } from "react"
import { Box, Text } from "ink"

import type { LimitGroupView } from "../limits"

export function LimitsPanel(props: { limitGroups: LimitGroupView[]; loading?: boolean; error?: string; compact?: boolean; width?: number }) {
  const spinner = useSpinner(props.loading)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold color="#a58a86">Limits</Text>
        <Box marginLeft={1}>
          <Text color="#aab3cf">{spinner}</Text>
        </Box>
      </Box>
      {props.error && <Text color="red">{props.error}</Text>}
      {!props.loading && !props.error && !props.limitGroups.length && <Text color="gray">No limits available</Text>}
      {props.limitGroups.map((group, groupIndex) => (
        <Box key={`${group.title ?? "default"}-${groupIndex}`} flexDirection="column" marginTop={group.title && groupIndex > 0 ? 1 : 0}>
          {group.title && <Text color="gray" wrap="truncate-end">{group.title}</Text>}
          {group.rows.map((row) => (
            <LimitRow key={`${group.title ?? "default"}-${row.label}`} label={row.label} used={row.used} left={row.left} reset={row.reset} compact={props.compact} width={props.width} />
          ))}
        </Box>
      ))}
    </Box>
  )
}

function LimitRow(props: { label: string; used: number; left: string; reset: string; compact?: boolean; width?: number }) {
  const labelWidth = props.compact ? Math.max(12, Math.min(18, Math.floor((props.width ?? 48) * 0.35))) : 21
  const leftWidth = props.compact ? 10 : 10

  if (props.compact) {
    return (
      <Box flexDirection="column">
        <Box>
          <Box width={labelWidth}>
            <Text color="gray" wrap="truncate-end">{props.label}</Text>
          </Box>
          <Box width={leftWidth}>
            <Text bold wrap="truncate-end">{props.left}</Text>
          </Box>
        </Box>
        <Text color="gray" wrap="truncate-end">  ({props.reset})</Text>
      </Box>
    )
  }

  return (
    <Box>
      <Box width={labelWidth}>
        <Text color="gray" wrap="truncate-end">{props.label}</Text>
      </Box>
      <Box width={leftWidth}>
        <Text bold wrap="truncate-end">{props.left}</Text>
      </Box>
      <Text color="gray" wrap="truncate-end">({props.reset})</Text>
    </Box>
  )
}

function useSpinner(active?: boolean) {
  const frames = ["|", "/", "-", "\\"]
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (!active) {
      setIndex(0)
      return
    }
    const timer = setInterval(() => {
      setIndex((value) => (value + 1) % frames.length)
    }, 120)
    return () => clearInterval(timer)
  }, [active])

  return active ? frames[index] : " "
}
