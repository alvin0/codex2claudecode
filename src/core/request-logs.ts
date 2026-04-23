import { open, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { ensureParentDir } from "./paths"
import type { RequestLogEntry } from "./types"

export const REQUEST_LOG_FILE_NAME = "request-logs-recent.ndjson"
export const MAX_REQUEST_LOG_ENTRIES = 100

export function requestLogFilePath(authFile: string) {
  return path.join(path.dirname(authFile), REQUEST_LOG_FILE_NAME)
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
    const logs = await readRecentRequestLogsRaw(authFile, MAX_REQUEST_LOG_ENTRIES)
    logs.push(entry)
    await atomicWriteFile(file, formatRequestLogs(logs.slice(-MAX_REQUEST_LOG_ENTRIES)))
  })
}

export async function readRecentRequestLogs(authFile: string, limit = MAX_REQUEST_LOG_ENTRIES): Promise<RequestLogEntry[]> {
  return readRecentRequestLogsRaw(authFile, limit)
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
  })
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

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function isBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === "EBUSY" || code === "EPERM"
}
