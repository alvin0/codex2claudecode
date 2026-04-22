import { open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
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
  // Ensure the parent directory exists (auth file dir may not exist yet)
  await ensureParentDir(file)
  // Open with "a" flag to create if not exists, without truncating
  const fh = await open(file, "a")
  await fh.close()
}

// Per-authFile write queue to prevent concurrent read-modify-write races.
// Each queue is a promise chain; new writes are appended to the tail.
const writeQueues = new Map<string, Promise<void>>()

function enqueueWrite(authFile: string, task: () => Promise<void>): Promise<void> {
  const current = writeQueues.get(authFile) ?? Promise.resolve()
  // Chain the new task after the current tail. Use a wrapper that always
  // resolves the chain (never rejects) so a failed write doesn't stall
  // subsequent writes. The task's own promise is returned to the caller so
  // they can observe success/failure independently.
  const taskPromise = current.then(() => task())
  const chainPromise = taskPromise.then(
    () => {},
    () => {}, // swallow so the queue chain never rejects
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

/**
 * Read recent request logs. Returns an empty array when the file does not
 * exist yet. Throws on unexpected I/O errors so callers can surface them.
 */
export async function readRecentRequestLogs(authFile: string, limit = MAX_REQUEST_LOG_ENTRIES): Promise<RequestLogEntry[]> {
  return readRecentRequestLogsRaw(authFile, limit)
}

async function readRecentRequestLogsRaw(authFile: string, limit: number): Promise<RequestLogEntry[]> {
  let content: string
  try {
    content = await readFile(requestLogFilePath(authFile), "utf8")
  } catch (error: unknown) {
    // File not found is expected on first run — treat as empty
    if (isNotFoundError(error)) return []
    throw error
  }

  const logs: RequestLogEntry[] = []
  // Normalise line endings so CRLF files (e.g. edited on Windows) parse correctly
  for (const line of content.split("\n")) {
    const entry = parseRequestLogLine(line.replace(/\r$/, ""))
    if (entry) logs.push(entry)
  }
  logs.sort((left: RequestLogEntry, right: RequestLogEntry) => left.at.localeCompare(right.at))
  return logs.slice(-Math.min(limit, MAX_REQUEST_LOG_ENTRIES))
}

export async function clearRequestLogs(authFile: string) {
  // Serialise the clear through the write queue so it doesn't race with an
  // in-flight appendRequestLog call.
  return enqueueWrite(authFile, async () => {
    try {
      await rm(requestLogFilePath(authFile), { force: true })
    } catch (error: unknown) {
      // On Windows, rm can fail with EBUSY if the file is open by another
      // process. Treat this as a best-effort operation.
      if (!isBusyError(error)) throw error
    }
  })
}

async function atomicWriteFile(targetFile: string, content: string): Promise<void> {
  // Place the temp file in the same directory so rename is always on the
  // same filesystem (cross-device rename would fail with EXDEV).
  const dir = path.dirname(targetFile)
  const tmpFile = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    await writeFile(tmpFile, content, { encoding: "utf8" })
    await rename(tmpFile, targetFile)
  } catch (error: unknown) {
    // Clean up the temp file if rename failed; ignore cleanup errors
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
  // Always use LF line endings regardless of platform so the file is
  // portable and consistent across macOS / Linux / Windows.
  return `${logs.map((entry: RequestLogEntry) => JSON.stringify(entry)).join("\n")}\n`
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  )
}

function isBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  const code = (error as NodeJS.ErrnoException).code
  // EBUSY = file locked (Windows), EPERM = operation not permitted (Windows antivirus/indexer)
  return code === "EBUSY" || code === "EPERM"
}
