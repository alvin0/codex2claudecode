import React, { useEffect, useState } from "react"
import { Box, Text } from "ink"

import type { LimitGroupView } from "../limits"

export function LimitsPanel(props: { limitGroups: LimitGroupView[]; loading?: boolean; error?: string }) {
  const spinner = useSpinner(props.loading)

  return (
    <Box flexDirection="column" marginTop={2}>
      <Box>
        <Text bold color="#a58a86">Limits</Text>
        <Box marginLeft={1}>
          <Text color="#aab3cf">{spinner}</Text>
        </Box>
      </Box>
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
      <Box width={11}>
        <Text bold>{props.left}</Text>
      </Box>
      <Text color="gray">({props.reset})</Text>
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
