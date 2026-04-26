import React, { useEffect, useState } from "react"
import { Box, Text, useStdout } from "ink"

import { requestLogModel } from "../../core/request-logs"
import type { RequestLogEntry } from "../../core/types"

const LOG_HEIGHT = 15
export const REQUEST_LOG_DETAIL_HEIGHT = 16
export const REQUEST_LOG_DETAIL_SCROLL_STEP = 1
export const REQUEST_LOG_DETAIL_FAST_SCROLL_STEP = REQUEST_LOG_DETAIL_HEIGHT - 2

const COL_ICON = 3
const COL_ID = 10
const COL_TIME = 10
const COL_METHOD = 7
const COL_PATH = 30
const COL_MODEL = 22
const COL_CLIENT = 8
const COL_PROXY = 8
const COL_DURATION = 10
const COL_SUMMARY = 48
const FIXED_TABLE_WIDTH = COL_ICON + COL_ID + COL_TIME + COL_METHOD + COL_MODEL + COL_CLIENT + COL_PROXY + COL_DURATION
const DEFAULT_TABLE_WIDTH = FIXED_TABLE_WIDTH + COL_PATH + COL_SUMMARY
const MIN_TABLE_WIDTH = 44
const TABLE_GUTTER = 6
const LOADING_FRAMES = ["|", "/", "-", "\\"]
const LONG_SHORTCUTS = "↑/↓ select · Enter details · f follow · l copy · x clear · Esc close"
const SHORT_SHORTCUTS = "↑/↓ select · Enter · f/l/x · Esc"

interface TableLayout {
  width: number
  pathWidth: number
  summaryWidth: number
  showId: boolean
  showTime: boolean
  showModel: boolean
  showProxy: boolean
  showDuration: boolean
  shortcuts: string
}

interface DetailLine {
  text: string
  color: string
}

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
  const { stdout } = useStdout()
  const table = tableLayout(stdout.columns)
  const selected = Math.max(0, Math.min(props.selected, Math.max(0, props.logs.length - 1)))
  const start = Math.min(Math.max(0, selected - LOG_HEIGHT + 1), Math.max(0, props.logs.length - LOG_HEIGHT))
  const rows = props.logs.slice(start, start + LOG_HEIGHT)
  const hasMoreAbove = start > 0
  const hasMoreBelow = start + LOG_HEIGHT < props.logs.length
  const detail = props.logs[selected]

  const pendingCount = props.logs.filter((l) => l.state === "pending").length
  const errorCount = props.logs.filter((l) => l.error !== "-" || (l.proxy?.error !== undefined && l.proxy.error !== "-")).length
  const loadingFrame = useSpinner(pendingCount > 0)
  const now = useNow(pendingCount > 0)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">{"─".repeat(table.width)}</Text>
      <Box width={table.width} flexDirection="column" alignItems="center" marginTop={1}>
        <Text bold color="#c7d2fe">Request logs</Text>
        <Box>
          <Text color="gray" wrap="truncate-end">{table.shortcuts}</Text>
          {props.autoFollow && <Text color="#22c55e"> ● FOLLOW</Text>}
        </Box>
      </Box>
      {props.clearConfirm && <Text color="yellow">Clear all request logs? y confirm · n/Esc cancel</Text>}
      {props.fileError && <Text color="red">⚠ {props.fileError}</Text>}
      {props.copyStatus && <Text color={props.copyStatus.type === "success" ? "green" : "red"}>{props.copyStatus.message}</Text>}
      <Box marginTop={1}>
        <Text color="#6b7280" wrap="truncate-end">{tableHeader(table)}</Text>
      </Box>
      <Text color="#374151">{"─".repeat(table.width)}</Text>
      {hasMoreAbove && <Text color="gray">   ↑ {start} more above</Text>}
      {rows.length ? (
        rows.map((log, index) => {
          const globalIndex = start + index
          return (
            <LogRow
              key={`${log.id}-${log.at}`}
              log={log}
              selected={globalIndex === selected}
              table={table}
              loadingFrame={loadingFrame}
              now={now}
            />
          )
        })
      ) : (
        <Text color="gray">  No requests yet</Text>
      )}
      {hasMoreBelow && <Text color="gray">   ↓ {props.logs.length - start - LOG_HEIGHT} more below</Text>}
      <Text color="#374151">{"─".repeat(table.width)}</Text>
      <Box>
        <Text color="#6b7280">Total: </Text>
        <Text color="#aab3cf">{props.logs.length}</Text>
        {pendingCount > 0 && (
          <>
            <Text color="#6b7280">  {loadingFrame} Pending: </Text>
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
      {props.detailOpen && detail && <LogDetailDialog log={detail} scroll={props.detailScroll ?? 0} width={table.width} />}
    </Box>
  )
}

function LogRow(props: { log: RequestLogEntry; selected: boolean; table: TableLayout; loadingFrame: string; now: number }) {
  const pending = props.log.state === "pending"
  const isNew = pending

  const iconStr = props.selected ? `>${pending ? props.loadingFrame : " "}` : isNew ? ` ${props.loadingFrame}` : "  "
  const idStr = props.log.id
  const timeStr = new Date(props.log.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
  const methodStr = props.log.method
  const pathStr = truncate(props.log.path, props.table.pathWidth)
  const modelStr = requestLogModel(props.log) ?? "-"
  const clientStr = pending ? "..." : String(props.log.status)
  const proxyStr = props.log.proxy ? String(props.log.proxy.status) : pending ? "..." : "-"
  const durationMs = pending ? elapsedDurationMs(props.log.at, props.now) : props.log.durationMs
  const durationStr = formatDuration(durationMs)
  const summaryStr = summaryText(props.log, props.loadingFrame)
  const summaryTruncated = truncate(summaryStr, props.table.summaryWidth)

  return (
    <Box width={props.table.width}>
      <Text color={props.selected ? "#d97757" : isNew ? "#facc15" : "gray"} wrap="truncate-end">{col(iconStr, COL_ICON)}</Text>
      {props.table.showId && <Text color={props.selected ? "#d97757" : isNew ? "#facc15" : "gray"} wrap="truncate-end">{col(idStr, COL_ID)}</Text>}
      {props.table.showTime && <Text color={isNew ? "#facc15" : "#aab3cf"} wrap="truncate-end">{col(timeStr, COL_TIME)}</Text>}
      <Text color={isNew ? "#facc15" : undefined} wrap="truncate-end">{col(methodStr, COL_METHOD)}</Text>
      <Text color={isNew ? "#facc15" : "#aab3cf"} wrap="truncate-end">{col(pathStr, props.table.pathWidth)}</Text>
      {props.table.showModel && <Text color={modelStr === "-" ? "gray" : "#aab3cf"} wrap="truncate-end">{col(modelStr, COL_MODEL)}</Text>}
      <Text color={pending ? "yellow" : statusColor(props.log.status)} wrap="truncate-end">{col(clientStr, COL_CLIENT)}</Text>
      {props.table.showProxy && <Text color={props.log.proxy ? statusColor(props.log.proxy.status) : "gray"} wrap="truncate-end">{col(proxyStr, COL_PROXY)}</Text>}
      {props.table.showDuration && <Text color={durationColor(durationMs)} wrap="truncate-end">{col(durationStr, COL_DURATION)}</Text>}
      <Text color={summaryColor(props.log)} wrap="truncate-end">{col(summaryTruncated, props.table.summaryWidth)}</Text>
    </Box>
  )
}

function LogDetailDialog(props: { log: RequestLogEntry; scroll: number; width: number }) {
  const { log } = props
  const lines = buildDetailRows(log, detailContentWidth(props.width))
  const maxScroll = Math.max(0, lines.length - REQUEST_LOG_DETAIL_HEIGHT)
  const scroll = Math.max(0, Math.min(props.scroll, maxScroll))
  const visibleLines = lines.slice(scroll, scroll + REQUEST_LOG_DETAIL_HEIGHT)
  return (
    <Box width={props.width} flexDirection="column" marginTop={1} borderStyle="round" borderColor="#d97757" paddingX={1} paddingY={1}>
      <Box>
        <Text bold color="#c7d2fe">Request detail</Text>
        <Text color="gray" wrap="truncate-end">  ↑/↓ scroll · PgUp/PgDn fast · Home/End · Enter/Esc close</Text>
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
        Rows {scroll + 1}-{Math.min(lines.length, scroll + REQUEST_LOG_DETAIL_HEIGHT)} / {lines.length}
      </Text>
      {visibleLines.map((line, index) => (
        <Text key={`${scroll}-${index}`} color={line.color} wrap="truncate-end">
          {line.text}
        </Text>
      ))}
    </Box>
  )
}

/** Pad or truncate a string to exactly `width` visible columns. */
function col(value: string, width: number): string {
  if (width <= 1) return truncate(value, width)
  const contentWidth = width - 1
  const content = truncate(value, contentWidth)
  return content + " ".repeat(width - content.length)
}

function truncate(value: string, width: number) {
  if (value.length <= width) return value
  if (width <= 1) return value.slice(0, width)
  return `${value.slice(0, width - 1)}…`
}

function tableLayout(columns?: number): TableLayout {
  const availableWidth = Math.max(MIN_TABLE_WIDTH, (columns ?? DEFAULT_TABLE_WIDTH + TABLE_GUTTER) - TABLE_GUTTER)
  const full = availableWidth >= 98
  const medium = availableWidth >= 76
  const showId = full
  const showTime = full || medium
  const showModel = availableWidth >= 110
  const showProxy = full
  const showDuration = full || medium
  const fixedWidth =
    COL_ICON +
    COL_METHOD +
    COL_CLIENT +
    (showId ? COL_ID : 0) +
    (showTime ? COL_TIME : 0) +
    (showModel ? COL_MODEL : 0) +
    (showProxy ? COL_PROXY : 0) +
    (showDuration ? COL_DURATION : 0)
  const flexibleWidth = Math.max(12, availableWidth - fixedWidth)
  const minPathWidth = full ? 18 : medium ? 16 : 10
  const minSummaryWidth = full ? 20 : medium ? 16 : 8
  let pathWidth: number
  let summaryWidth: number

  if (flexibleWidth < minPathWidth + minSummaryWidth) {
    pathWidth = Math.max(6, Math.floor(flexibleWidth * 0.55))
    summaryWidth = Math.max(6, flexibleWidth - pathWidth)
  } else {
    pathWidth = Math.max(minPathWidth, Math.min(COL_PATH, Math.floor(flexibleWidth * (full ? 0.52 : 0.48))))
    summaryWidth = flexibleWidth - pathWidth
    if (summaryWidth < minSummaryWidth) {
      summaryWidth = minSummaryWidth
      pathWidth = flexibleWidth - summaryWidth
    }
    if (summaryWidth > COL_SUMMARY) {
      pathWidth = Math.min(COL_PATH, pathWidth + summaryWidth - COL_SUMMARY)
      summaryWidth = COL_SUMMARY
    }
  }
  const width = fixedWidth + pathWidth + summaryWidth

  return {
    pathWidth,
    summaryWidth,
    width,
    showId,
    showTime,
    showModel,
    showProxy,
    showDuration,
    shortcuts: width < 72 ? SHORT_SHORTCUTS : LONG_SHORTCUTS,
  }
}

function tableHeader(table: TableLayout) {
  return [
    col("", COL_ICON),
    table.showId ? col("Id", COL_ID) : "",
    table.showTime ? col("Time", COL_TIME) : "",
    col("Method", COL_METHOD),
    col("Path", table.pathWidth),
    table.showModel ? col("Model", COL_MODEL) : "",
    col("Client", COL_CLIENT),
    table.showProxy ? col("Proxy", COL_PROXY) : "",
    table.showDuration ? col("Duration", COL_DURATION) : "",
    col("Summary", table.summaryWidth),
  ].join("")
}

export function requestLogDetailMaxScroll(log: RequestLogEntry, columns?: number) {
  const table = tableLayout(columns)
  return Math.max(0, buildDetailRows(log, detailContentWidth(table.width)).length - REQUEST_LOG_DETAIL_HEIGHT)
}

function detailContentWidth(width: number) {
  return Math.max(8, Math.floor(width) - 4)
}

function useSpinner(active?: boolean) {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (!active) {
      setIndex(0)
      return
    }
    const timer = setInterval(() => {
      setIndex((value) => (value + 1) % LOADING_FRAMES.length)
    }, 120)
    return () => clearInterval(timer)
  }, [active])

  return active ? LOADING_FRAMES[index] : " "
}

function useNow(active?: boolean) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [active])

  return now
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

function elapsedDurationMs(startedAt: string, now: number) {
  const startedAtMs = new Date(startedAt).getTime()
  if (!Number.isFinite(startedAtMs)) return 0
  return Math.max(0, now - startedAtMs)
}

function summaryText(log: RequestLogEntry, loadingFrame = " ") {
  if (log.state === "pending") return `${loadingFrame} in process`
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

function buildDetailLines(log: RequestLogEntry): DetailLine[] {
  const pending = log.state === "pending"
  const model = requestLogModel(log) ?? "-"
  return [
    { text: `[${log.id}] ${formatTimestamp(log.at)} · ${log.method} ${log.path}`, color: "gray" },
    { text: `Model: ${model}`, color: model === "-" ? "gray" : "#aab3cf" },
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

function buildDetailRows(log: RequestLogEntry, width: number) {
  return buildDetailLines(log).flatMap((line) => wrapDetailLine(line, width))
}

function wrapDetailLine(line: DetailLine, width: number): DetailLine[] {
  const rowWidth = Math.max(1, Math.floor(width))
  if (line.text.length <= rowWidth) return [line]

  const continuationIndent = line.text.match(/^\s*/)?.[0] ?? ""
  const rows: DetailLine[] = []
  let remaining = line.text
  let first = true

  while (remaining.length > 0) {
    const prefix = first || continuationIndent.length >= rowWidth - 4 ? "" : continuationIndent
    const chunkWidth = Math.max(1, rowWidth - prefix.length)
    rows.push({ ...line, text: `${prefix}${remaining.slice(0, chunkWidth)}` })
    remaining = remaining.slice(chunkWidth)
    first = false
  }

  return rows
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
