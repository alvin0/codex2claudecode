import React from "react"
import { Box, Text } from "ink"

import type { RequestLogEntry } from "../../types"

const LOG_HEIGHT = 8

export function RequestLogsPanel(props: { logs: RequestLogEntry[]; selected: number }) {
  const selected = Math.max(0, Math.min(props.selected, Math.max(0, props.logs.length - 1)))
  const start = Math.min(Math.max(0, selected - LOG_HEIGHT + 1), Math.max(0, props.logs.length - LOG_HEIGHT))
  const rows = props.logs.slice(start, start + LOG_HEIGHT)
  const hasMoreAbove = start > 0
  const hasMoreBelow = start + LOG_HEIGHT < props.logs.length
  const detail = props.logs[selected]
  const errorDetail = detail?.error !== "-" ? detail : undefined

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">Request logs</Text>
        <Text color="gray">  ↑/↓ select id · Esc close</Text>
      </Box>
      <Box>
        <Box width={10}>
          <Text color="gray">Id</Text>
        </Box>
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
      {rows.length ? rows.map((log, index) => <LogRow key={`${log.id}-${log.at}`} log={log} selected={start + index === selected} />) : <Text color="gray">No requests yet</Text>}
      {hasMoreBelow && <Text color="gray">   ↓ more</Text>}
      {errorDetail && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="#c7d2fe">Error detail</Text>
          <Text color="gray">
            [{errorDetail.id}] {errorDetail.method} {errorDetail.path} · {errorDetail.status} · {errorDetail.durationMs}ms
          </Text>
          <Text color="red">{errorDetail.error}</Text>
        </Box>
      )}
    </Box>
  )
}

function LogRow(props: { log: RequestLogEntry; selected: boolean }) {
  return (
    <Box>
      <Box width={2}>
        <Text color={props.selected ? "#d97757" : "gray"}>{props.selected ? "›" : " "}</Text>
      </Box>
      <Box width={10}>
        <Text color={props.selected ? "#d97757" : "gray"}>{props.log.id}</Text>
      </Box>
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
      <Text color={props.log.error === "-" ? "gray" : "red"}>{truncate(props.log.error, 56)}</Text>
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
