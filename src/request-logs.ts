import { readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { ensureParentDir } from "./paths"
import type { RequestLogEntry } from "./types"

export const REQUEST_LOG_DIR_NAME = ".request-logs"
export const REQUEST_LOG_FILE_NAME = "recent.ndjson"
export const MAX_REQUEST_LOG_ENTRIES = 100

export function requestLogsDir(authFile: string) {
  return path.join(path.dirname(authFile), REQUEST_LOG_DIR_NAME)
}

export function requestLogFilePath(authFile: string) {
  return path.join(requestLogsDir(authFile), REQUEST_LOG_FILE_NAME)
}

export async function ensureRequestLogFile(authFile: string) {
  const file = requestLogFilePath(authFile)
  await ensureParentDir(file)
  await writeFile(file, "", { flag: "a" })
}

export async function appendRequestLog(authFile: string, entry: RequestLogEntry) {
  const file = requestLogFilePath(authFile)
  await ensureRequestLogFile(authFile)
  const logs = await readRecentRequestLogs(authFile, MAX_REQUEST_LOG_ENTRIES)
  logs.push(entry)
  await writeFile(file, formatRequestLogs(logs.slice(-MAX_REQUEST_LOG_ENTRIES)))
  await removeLegacyRequestLogFiles(authFile)
}

export async function readRecentRequestLogs(authFile: string, limit = MAX_REQUEST_LOG_ENTRIES): Promise<RequestLogEntry[]> {
  try {
    const content = await readFile(requestLogFilePath(authFile), "utf8")
    const logs: RequestLogEntry[] = []
    for (const line of content.split("\n")) {
      const entry = parseRequestLogLine(line)
      if (entry) logs.push(entry)
    }
    logs.sort((left: RequestLogEntry, right: RequestLogEntry) => left.at.localeCompare(right.at))
    return logs.slice(-Math.min(limit, MAX_REQUEST_LOG_ENTRIES))
  } catch {
    return []
  }
}

export async function clearRequestLogs(authFile: string) {
  await rm(requestLogsDir(authFile), { recursive: true, force: true })
}

async function removeLegacyRequestLogFiles(authFile: string) {
  try {
    const entries = await readdir(requestLogsDir(authFile), { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ndjson") || entry.name === REQUEST_LOG_FILE_NAME) continue
      await rm(path.join(requestLogsDir(authFile), entry.name), { force: true })
    }
  } catch {
    return
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
