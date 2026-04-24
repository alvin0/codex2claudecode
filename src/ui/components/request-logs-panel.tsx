import React from "react"
import { Box, Text } from "ink"

import type { RequestLogEntry } from "../../core/types"

const LOG_HEIGHT = 15
const DETAIL_HEIGHT = 16

export function RequestLogsPanel(props: {
  logs: RequestLogEntry[]
  selected: number
  autoFollow?: boolean
  detailOpen?: boolean
  detailScroll?: number
  copyStatus?: { type: "success" | "error"; message: string }
  clearConfirm?: boolean
  fileError?: string
}) {
  const selected = Math.max(0, Math.min(props.selected, Math.max(0, props.logs.length - 1)))
  const start = Math.min(Math.max(0, selected - LOG_HEIGHT + 1), Math.max(0, props.logs.length - LOG_HEIGHT))
  const rows = props.logs.slice(start, start + LOG_HEIGHT)
  const hasMoreAbove = start > 0
  const hasMoreBelow = start + LOG_HEIGHT < props.logs.length
  const detail = props.logs[selected]

  const pendingCount = props.logs.filter((l) => l.state === "pending").length
  const errorCount = props.logs.filter((l) => l.error !== "-" || (l.proxy?.error !== undefined && l.proxy.error !== "-")).length

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">Request logs</Text>
        <Text color="gray">  ↑/↓ select · Enter details · f follow · l copy · x clear · Esc close</Text>
        {props.autoFollow && <Text color="#22c55e"> ● FOLLOW</Text>}
      </Box>
      {props.clearConfirm && <Text color="yellow">Clear all request logs? y confirm · n/Esc cancel</Text>}
      {props.fileError && <Text color="red">⚠ {props.fileError}</Text>}
      {props.copyStatus && <Text color={props.copyStatus.type === "success" ? "green" : "red"}>{props.copyStatus.message}</Text>}
      <Box marginTop={1}>
        <Box width={5}>
          <Text color="#6b7280">#</Text>
        </Box>
        <Box width={10}>
          <Text color="#6b7280">Id</Text>
        </Box>
        <Box width={10}>
          <Text color="#6b7280">Time</Text>
        </Box>
        <Box width={7}>
          <Text color="#6b7280">Method</Text>
        </Box>
        <Box width={30}>
          <Text color="#6b7280">Path</Text>
        </Box>
        <Box width={8}>
          <Text color="#6b7280">Client</Text>
        </Box>
        <Box width={8}>
          <Text color="#6b7280">Proxy</Text>
        </Box>
        <Box width={10}>
          <Text color="#6b7280">Duration</Text>
        </Box>
        <Text color="#6b7280">Summary</Text>
      </Box>
      <Text color="#374151">{"─".repeat(90)}</Text>
      {hasMoreAbove && <Text color="gray">   ↑ {start} more above</Text>}
      {rows.length ? (
        rows.map((log, index) => {
          const globalIndex = start + index
          return (
            <LogRow
              key={`${log.id}-${log.at}`}
              log={log}
              index={globalIndex + 1}
              selected={globalIndex === selected}
            />
          )
        })
      ) : (
        <Text color="gray">  No requests yet</Text>
      )}
      {hasMoreBelow && <Text color="gray">   ↓ {props.logs.length - start - LOG_HEIGHT} more below</Text>}
      <Text color="#374151">{"─".repeat(90)}</Text>
      <Box>
        <Text color="#6b7280">Total: </Text>
        <Text color="#aab3cf">{props.logs.length}</Text>
        {pendingCount > 0 && (
          <>
            <Text color="#6b7280">  ⏳ Pending: </Text>
            <Text color="yellow">{pendingCount}</Text>
          </>
        )}
        {errorCount > 0 && (
          <>
            <Text color="#6b7280">  ✗ Errors: </Text>
            <Text color="red">{errorCount}</Text>
          </>
        )}
        {pendingCount === 0 && errorCount === 0 && props.logs.length > 0 && (
          <>
            <Text color="#6b7280">  </Text>
            <Text color="green">✓ All OK</Text>
          </>
        )}
      </Box>
      {props.detailOpen && detail && <LogDetailDialog log={detail} scroll={props.detailScroll ?? 0} />}
    </Box>
  )
}

function LogRow(props: { log: RequestLogEntry; index: number; selected: boolean }) {
  const pending = props.log.state === "pending"
  const isNew = pending

  return (
    <Box>
      <Box width={5}>
        <Text color={props.selected ? "#d97757" : "#4b5563"}>{String(props.index).padStart(3, " ")} </Text>
      </Box>
      <Box width={2}>
        <Text color={props.selected ? "#d97757" : isNew ? "#facc15" : "gray"}>{props.selected ? "›" : isNew ? "⏳" : " "}</Text>
      </Box>
      <Box width={10}>
        <Text color={props.selected ? "#d97757" : isNew ? "#facc15" : "gray"}>{props.log.id}</Text>
      </Box>
      <Box width={10}>
        <Text color={isNew ? "#facc15" : "#aab3cf"}>
          {new Date(props.log.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
        </Text>
      </Box>
      <Box width={7}>
        <Text color={isNew ? "#facc15" : undefined}>{props.log.method}</Text>
      </Box>
      <Box width={30}>
        <Text color={isNew ? "#facc15" : "#aab3cf"}>{truncate(props.log.path, 28)}</Text>
      </Box>
      <Box width={8}>
        <Text color={pending ? "yellow" : statusColor(props.log.status)}>{pending ? "···" : props.log.status}</Text>
      </Box>
      <Box width={8}>
        <Text color={props.log.proxy ? statusColor(props.log.proxy.status) : "gray"}>
          {props.log.proxy?.status ?? (pending ? "···" : "–")}
        </Text>
      </Box>
      <Box width={10}>
        <Text color={pending ? "yellow" : durationColor(props.log.durationMs)}>{pending ? "···" : formatDuration(props.log.durationMs)}</Text>
      </Box>
      <Text color={summaryColor(props.log)}>{truncate(summaryText(props.log), 48)}</Text>
    </Box>
  )
}

function LogDetailDialog(props: { log: RequestLogEntry; scroll: number }) {
  const { log } = props
  const lines = buildDetailLines(log)
  const maxScroll = Math.max(0, lines.length - DETAIL_HEIGHT)
  const scroll = Math.max(0, Math.min(props.scroll, maxScroll))
  const visibleLines = lines.slice(scroll, scroll + DETAIL_HEIGHT)
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="#d97757" paddingX={1} paddingY={1}>
      <Box>
        <Text bold color="#c7d2fe">Request detail</Text>
        <Text color="gray">  ↑/↓ scroll · Enter/Esc close</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="#d97757">[c]</Text>
        <Text color="gray"> copy request</Text>
        <Text color="#d97757">  [l]</Text>
        <Text color="gray"> copy all logs</Text>
        <Text color="#d97757">  [x]</Text>
        <Text color="gray"> clear logs</Text>
      </Box>
      <Text color="gray">
        Lines {scroll + 1}-{Math.min(lines.length, scroll + DETAIL_HEIGHT)} / {lines.length}
      </Text>
      {visibleLines.map((line, index) => (
        <Text key={`${scroll}-${index}`} color={line.color}>
          {line.text}
        </Text>
      ))}
    </Box>
  )
}

function truncate(value: string, width: number) {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value
}

/** Color-code duration: green < 1s, yellow 1-5s, red > 5s */
function durationColor(ms: number): string {
  if (ms < 1000) return "green"
  if (ms < 5000) return "yellow"
  return "red"
}

/** Format duration with appropriate unit */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function summaryText(log: RequestLogEntry) {
  if (log.state === "pending") return "⏳ in process"
  if (log.proxy && log.proxy.error !== "-") return `proxy: ${log.proxy.error}`
  if (log.error !== "-") return log.error
  if (log.proxy) return `${log.proxy.label} ${log.proxy.status}`
  return "local"
}

function summaryColor(log: RequestLogEntry) {
  if (log.state === "pending") return "yellow"
  if (log.proxy?.error !== "-" || log.error !== "-") return "red"
  if (log.proxy && log.proxy.status >= 400) return statusColor(log.proxy.status)
  return "gray"
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString()
}

function formatKeyValue(value: Record<string, string>) {
  const entries = Object.entries(value)
  if (!entries.length) return "-"
  return entries.map(([key, content]) => `${key}: ${content}`).join(" | ")
}

function buildDetailLines(log: RequestLogEntry) {
  const pending = log.state === "pending"
  return [
    { text: `[${log.id}] ${formatTimestamp(log.at)} · ${log.method} ${log.path}`, color: "gray" },
    { text: pending ? "Client status: in process" : `Client status: ${log.status} · ${log.durationMs}ms`, color: pending ? "yellow" : statusColor(log.status) },
    { text: `Client error: ${log.error}`, color: log.error === "-" ? "gray" : "red" },
    { text: "", color: "gray" },
    { text: "Request headers", color: "#c7d2fe" },
    ...blockLines(formatKeyValue(log.requestHeaders), "#aab3cf"),
    { text: "", color: "gray" },
    { text: "Request body preview", color: "#c7d2fe" },
    ...blockLines(formatStructuredText(log.requestBody), log.requestBody ? "#aab3cf" : "gray"),
    { text: "", color: "gray" },
    { text: "Response body preview", color: "#c7d2fe" },
    ...blockLines(formatStructuredText(log.responseBody), log.responseBody ? "#aab3cf" : "gray"),
    { text: "", color: "gray" },
    { text: "Proxy", color: "#c7d2fe" },
    ...(pending && !log.proxy
      ? [{ text: "Proxy request has not completed yet", color: "yellow" }]
      : log.proxy
      ? [
          { text: `${log.proxy.label} · ${log.proxy.method} ${log.proxy.target}`, color: "gray" },
          { text: `Proxy status: ${log.proxy.status} · ${log.proxy.durationMs}ms`, color: statusColor(log.proxy.status) },
          { text: `Proxy error: ${log.proxy.error}`, color: log.proxy.error === "-" ? "gray" : "red" },
          { text: "Proxy request body preview", color: "gray" },
          ...blockLines(formatStructuredText(log.proxy.requestBody), log.proxy.requestBody ? "#aab3cf" : "gray"),
          { text: "Proxy response body preview", color: "gray" },
          ...blockLines(formatStructuredText(log.proxy.responseBody), log.proxy.responseBody ? "#aab3cf" : "gray"),
        ]
      : [{ text: "No upstream proxy for this request", color: "gray" }]),
  ]
}

export function formatRequestLogDetail(log: RequestLogEntry) {
  return buildDetailLines(log)
    .map((line) => line.text)
    .join("\n")
}

export function formatAllRequestLogs(logs: RequestLogEntry[]) {
  if (!logs.length) return "No request logs"
  return logs
    .map((log, index) => {
      const title = `===== Log ${index + 1}/${logs.length} · ${log.id} =====`
      return `${title}\n${formatRequestLogDetail(log)}`
    })
    .join("\n\n")
}

function blockLines(value: string, color: string) {
  return value.split("\n").map((text) => ({ text, color }))
}

function formatStructuredText(value?: string) {
  if (!value) return "-"
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function statusColor(status: number) {
  if (status <= 0) return "gray"
  if (status >= 500) return "red"
  if (status >= 400) return "yellow"
  return "green"
}
