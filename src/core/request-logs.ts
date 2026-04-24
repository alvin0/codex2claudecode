import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { ensureParentDir } from "./paths"
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
  await ensureParentDir(file)
  const fh = await open(file, "a")
  await fh.close()
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
    await ensureRequestLogDetailDir(authFile)
    const detail = withDetailFile(entry)
    await atomicWriteFile(requestLogDetailFilePath(authFile, entry.id), `${JSON.stringify(detail, null, 2)}\n`)
    const logs = await readRecentRequestLogsRaw(authFile, MAX_REQUEST_LOG_ENTRIES)
    logs.push(toRequestLogSummary(detail))
    const recentLogs = logs.slice(-MAX_REQUEST_LOG_ENTRIES)
    await atomicWriteFile(file, formatRequestLogs(recentLogs))
    await removeOrphanedRequestLogDetails(authFile, new Set(recentLogs.map((log) => safeLogId(log.id))))
  })
}

export async function readRecentRequestLogs(authFile: string, limit = MAX_REQUEST_LOG_ENTRIES): Promise<RequestLogEntry[]> {
  return readRecentRequestLogsRaw(authFile, limit)
}

export async function readRequestLogDetail(authFile: string, entry: RequestLogEntry): Promise<RequestLogEntry> {
  if (!entry.detailFile) return entry
  try {
    const detail = JSON.parse(await readFile(path.join(path.dirname(authFile), entry.detailFile), "utf8")) as RequestLogEntry
    return typeof detail.at === "string" ? detail : entry
  } catch (error: unknown) {
    if (isNotFoundError(error)) return entry
    throw error
  }
}

async function readRecentRequestLogsRaw(authFile: string, limit: number): Promise<RequestLogEntry[]> {
  let content: string
  try {
    content = await readFile(requestLogFilePath(authFile), "utf8")
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
      await rm(requestLogFilePath(authFile), { force: true })
    } catch (error: unknown) {
      if (!isBusyError(error)) throw error
    }
    try {
      await rm(path.join(path.dirname(authFile), REQUEST_LOG_DETAIL_DIR_NAME), { recursive: true, force: true })
    } catch (error: unknown) {
      if (!isBusyError(error)) throw error
    }
  })
}

async function ensureRequestLogDetailDir(authFile: string) {
  await mkdir(path.join(path.dirname(authFile), REQUEST_LOG_DETAIL_DIR_NAME), { recursive: true })
}

async function atomicWriteFile(targetFile: string, content: string): Promise<void> {
  const dir = path.dirname(targetFile)
  const tmpFile = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    await writeFile(tmpFile, content, { encoding: "utf8" })
    await rename(tmpFile, targetFile)
  } catch (error: unknown) {
    await rm(tmpFile, { force: true }).catch(() => {})
    throw error
  }
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
    files = await readdir(dir)
  } catch (error: unknown) {
    if (isNotFoundError(error)) return
    throw error
  }
  await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .filter((file) => !keptIds.has(file.slice(0, -".json".length)))
      .map((file) => rm(path.join(dir, file), { force: true })),
  )
}

function safeLogId(id: string) {
  return id.replace(/[^A-Za-z0-9._-]/g, "_")
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function isBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === "EBUSY" || code === "EPERM"
}
