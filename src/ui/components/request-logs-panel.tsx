import React from "react"
import { Box, Text } from "ink"

import type { RequestLogEntry } from "../../types"

const LOG_HEIGHT = 8

export function RequestLogsPanel(props: { logs: RequestLogEntry[]; scroll: number }) {
  const start = Math.max(0, props.logs.length - LOG_HEIGHT - props.scroll)
  const rows = props.logs.slice(start, start + LOG_HEIGHT)
  const hasMoreAbove = start > 0
  const hasMoreBelow = start + LOG_HEIGHT < props.logs.length

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">Request logs</Text>
        <Text color="gray">  ↑/↓ scroll · Esc close</Text>
      </Box>
      <Box>
        <Box width={10}>
          <Text color="gray">Time</Text>
        </Box>
        <Box width={7}>
          <Text color="gray">Method</Text>
        </Box>
        <Box width={36}>
          <Text color="gray">Path</Text>
        </Box>
        <Box width={8}>
          <Text color="gray">Status</Text>
        </Box>
        <Box width={10}>
          <Text color="gray">Duration</Text>
        </Box>
        <Text color="gray">Error</Text>
      </Box>
      {hasMoreAbove && <Text color="gray">   ↑ more</Text>}
      {rows.length ? rows.map((log) => <LogRow key={`${log.id}-${log.at}`} log={log} />) : <Text color="gray">No requests yet</Text>}
      {hasMoreBelow && <Text color="gray">   ↓ more</Text>}
    </Box>
  )
}

function LogRow(props: { log: RequestLogEntry }) {
  return (
    <Box>
      <Box width={10}>
        <Text color="#aab3cf">{new Date(props.log.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</Text>
      </Box>
      <Box width={7}>
        <Text>{props.log.method}</Text>
      </Box>
      <Box width={36}>
        <Text color="#aab3cf">{truncate(props.log.path, 34)}</Text>
      </Box>
      <Box width={8}>
        <Text color={statusColor(props.log.status)}>{props.log.status}</Text>
      </Box>
      <Box width={10}>
        <Text color="gray">{props.log.durationMs}ms</Text>
      </Box>
      <Text color={props.log.error === "-" ? "gray" : "red"}>{truncate(props.log.error, 36)}</Text>
    </Box>
  )
}

function truncate(value: string, width: number) {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value
}

function statusColor(status: number) {
  if (status >= 500) return "red"
  if (status >= 400) return "yellow"
  return "green"
}
