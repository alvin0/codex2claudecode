import { atomicJsonWrite, isBusyError, isNotFoundError, pathExists, readDirectory, readTextFile, removePath, writeTextFile } from "./bun-fs"
import { bunPath as path } from "./paths"
import type { RequestLogEntry } from "./types"

export const REQUEST_LOG_FILE_NAME = "request-logs-recent.ndjson"
export const REQUEST_LOG_DETAIL_DIR_NAME = "request-log-details"
export const MAX_REQUEST_LOG_ENTRIES = 100

export function requestLogFilePath(authFile: string) {
  return path.join(path.dirname(authFile), REQUEST_LOG_FILE_NAME)
}

export function requestLogDetailFilePath(authFile: string, id: string) {
  return path.join(path.dirname(authFile), REQUEST_LOG_DETAIL_DIR_NAME, `${safeLogId(id)}.json`)
}

export async function ensureRequestLogFile(authFile: string) {
  const file = requestLogFilePath(authFile)
  if (!(await pathExists(file))) await writeTextFile(file, "")
}

const writeQueues = new Map<string, Promise<void>>()

function enqueueWrite(authFile: string, task: () => Promise<void>): Promise<void> {
  const current = writeQueues.get(authFile) ?? Promise.resolve()
  const taskPromise = current.then(() => task())
  const chainPromise = taskPromise.then(
    () => {},
    () => {},
  )
  writeQueues.set(authFile, chainPromise)
  void chainPromise.then(() => {
    if (writeQueues.get(authFile) === chainPromise) writeQueues.delete(authFile)
  })
  return taskPromise
}

export async function appendRequestLog(authFile: string, entry: RequestLogEntry): Promise<void> {
  return enqueueWrite(authFile, async () => {
    const file = requestLogFilePath(authFile)
    await ensureRequestLogFile(authFile)
    const detail = withDetailFile(entry)
    await atomicJsonWrite(requestLogDetailFilePath(authFile, entry.id), detail, { mode: 0o644 })
    const logs = await readRecentRequestLogsRaw(authFile, MAX_REQUEST_LOG_ENTRIES)
    logs.push(toRequestLogSummary(detail))
    const recentLogs = logs.slice(-MAX_REQUEST_LOG_ENTRIES)
    await writeRequestLogFile(file, formatRequestLogs(recentLogs))
    await removeOrphanedRequestLogDetails(authFile, new Set(recentLogs.map((log) => safeLogId(log.id))))
  })
}

export async function readRecentRequestLogs(authFile: string, limit = MAX_REQUEST_LOG_ENTRIES): Promise<RequestLogEntry[]> {
  return readRecentRequestLogsRaw(authFile, limit)
}

export async function readRequestLogDetail(authFile: string, entry: RequestLogEntry): Promise<RequestLogEntry> {
  if (!entry.detailFile) return entry
  try {
    const detail = JSON.parse(await readTextFile(path.join(path.dirname(authFile), entry.detailFile))) as RequestLogEntry
    return typeof detail.at === "string" ? detail : entry
  } catch (error: unknown) {
    if (isNotFoundError(error)) return entry
    throw error
  }
}

export function requestLogModel(entry: Pick<RequestLogEntry, "model" | "requestBody" | "proxy">) {
  return normalizeModel(entry.model) ?? modelFromBody(entry.requestBody) ?? modelFromBody(entry.proxy?.requestBody)
}

async function readRecentRequestLogsRaw(authFile: string, limit: number): Promise<RequestLogEntry[]> {
  let content: string
  try {
    content = await readTextFile(requestLogFilePath(authFile))
  } catch (error: unknown) {
    if (isNotFoundError(error)) return []
    throw error
  }

  const logs: RequestLogEntry[] = []
  for (const line of content.split("\n")) {
    const entry = parseRequestLogLine(line.replace(/\r$/, ""))
    if (entry) logs.push(entry)
  }
  logs.sort((left: RequestLogEntry, right: RequestLogEntry) => left.at.localeCompare(right.at))
  return logs.slice(-Math.min(limit, MAX_REQUEST_LOG_ENTRIES))
}

export async function clearRequestLogs(authFile: string) {
  return enqueueWrite(authFile, async () => {
    try {
      await removePath(requestLogFilePath(authFile), { force: true })
    } catch (error: unknown) {
      if (!isBusyError(error)) throw error
    }
    try {
      await removePath(path.join(path.dirname(authFile), REQUEST_LOG_DETAIL_DIR_NAME), { recursive: true, force: true })
    } catch (error: unknown) {
      if (!isBusyError(error)) throw error
    }
  })
}

async function writeRequestLogFile(targetFile: string, content: string): Promise<void> {
  await writeTextFile(targetFile, content)
}

function parseRequestLogLine(line: string) {
  if (!line.trim()) return
  try {
    const entry = JSON.parse(line) as RequestLogEntry
    return typeof entry.at === "string" ? entry : undefined
  } catch {
    return
  }
}

function formatRequestLogs(logs: RequestLogEntry[]) {
  if (!logs.length) return ""
  return `${logs.map((entry: RequestLogEntry) => JSON.stringify(entry)).join("\n")}\n`
}

function withDetailFile(entry: RequestLogEntry): RequestLogEntry {
  return {
    ...entry,
    detailFile: path.join(REQUEST_LOG_DETAIL_DIR_NAME, `${safeLogId(entry.id)}.json`),
  }
}

function toRequestLogSummary(entry: RequestLogEntry): RequestLogEntry {
  return {
    id: entry.id,
    state: entry.state,
    detailFile: entry.detailFile,
    at: entry.at,
    method: entry.method,
    path: entry.path,
    status: entry.status,
    durationMs: entry.durationMs,
    error: entry.error,
    model: requestLogModel(entry),
    requestHeaders: entry.requestHeaders,
    proxy: entry.proxy
      ? {
          label: entry.proxy.label,
          method: entry.proxy.method,
          target: entry.proxy.target,
          status: entry.proxy.status,
          durationMs: entry.proxy.durationMs,
          error: entry.proxy.error,
        }
      : undefined,
  }
}

async function removeOrphanedRequestLogDetails(authFile: string, keptIds: Set<string>) {
  const dir = path.join(path.dirname(authFile), REQUEST_LOG_DETAIL_DIR_NAME)
  let files: string[]
  try {
    files = await readDirectory(dir)
  } catch (error: unknown) {
    if (isNotFoundError(error)) return
    throw error
  }
  await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .filter((file) => !keptIds.has(file.slice(0, -".json".length)))
      .map((file) =>
        removePath(path.join(dir, file), { force: true }).catch((error: unknown) => {
          // On Windows, locked files (EBUSY/EPERM) are common — skip and retry next cycle.
          if (isBusyError(error)) return
          throw error
        }),
      ),
  )
}

function safeLogId(id: string) {
  return id.replace(/[^A-Za-z0-9._-]/g, "_")
}

function modelFromBody(body?: string) {
  if (!body) return
  try {
    return modelFromJson(JSON.parse(body))
  } catch {
    return normalizeModel(body.match(/"model"\s*:\s*"([^"]+)"/)?.[1])
  }
}

function modelFromJson(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const model = (value as { model?: unknown }).model
  return normalizeModel(model)
}

function normalizeModel(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
