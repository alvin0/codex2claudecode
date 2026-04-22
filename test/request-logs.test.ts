import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { appendRequestLog, clearRequestLogs, ensureRequestLogFile, MAX_REQUEST_LOG_ENTRIES, readRecentRequestLogs, requestLogFilePath } from "../src/request-logs"
import type { RequestLogEntry } from "../src/types"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function authFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "request-logs-test-"))
  tempDirs.push(dir)
  const file = path.join(dir, "auth-codex.json")
  await writeFile(file, JSON.stringify({ type: "oauth", access: "a", refresh: "r" }))
  return file
}

function logEntry(overrides?: Partial<RequestLogEntry>): RequestLogEntry {
  return {
    id: "req-1",
    at: "2026-04-22T10:00:00.000Z",
    method: "POST",
    path: "/v1/responses",
    status: 200,
    durationMs: 12,
    error: "-",
    requestHeaders: { "content-type": "application/json" },
    requestBody: '{"input":"hi"}',
    ...overrides,
  }
}

test("appends request logs to request-logs-recent.ndjson", async () => {
  const file = await authFile()
  const entry = logEntry()

  await appendRequestLog(file, entry)

  expect(requestLogFilePath(file)).toBe(path.join(path.dirname(file), "request-logs-recent.ndjson"))
  expect(JSON.parse((await readFile(requestLogFilePath(file), "utf8")).trim())).toMatchObject({
    id: "req-1",
    at: entry.at,
    path: "/v1/responses",
  })
})

test("creates request log file when parent directories are missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "request-logs-missing-parent-test-"))
  tempDirs.push(root)
  const file = path.join(root, "missing", "auth-codex.json")

  await appendRequestLog(file, logEntry())

  await expect(readFile(requestLogFilePath(file), "utf8")).resolves.toContain('"req-1"')
})

test("initializes request log file without truncating existing logs", async () => {
  const file = await authFile()
  await appendRequestLog(file, logEntry())

  await ensureRequestLogFile(file)

  await expect(readFile(requestLogFilePath(file), "utf8")).resolves.toContain('"req-1"')
})

test("reads recent request logs in sorted order", async () => {
  const file = await authFile()

  await appendRequestLog(file, logEntry({ id: "two", at: "2026-04-22T09:00:00.000Z" }))
  await appendRequestLog(file, logEntry({ id: "one", at: "2026-04-22T08:00:00.000Z" }))

  await expect(readRecentRequestLogs(file, 10)).resolves.toEqual([
    expect.objectContaining({ id: "one" }),
    expect.objectContaining({ id: "two" }),
  ])
})

test("keeps only the newest 100 request logs", async () => {
  const file = await authFile()

  for (let index = 0; index < MAX_REQUEST_LOG_ENTRIES + 5; index += 1) {
    await appendRequestLog(
      file,
      logEntry({
        id: `req-${index + 1}`,
        at: new Date(Date.parse("2026-04-22T10:00:00.000Z") + index * 1000).toISOString(),
      }),
    )
  }

  const logs = await readRecentRequestLogs(file, MAX_REQUEST_LOG_ENTRIES)
  expect(logs).toHaveLength(MAX_REQUEST_LOG_ENTRIES)
  expect(logs[0]).toMatchObject({ id: "req-6" })
  expect(logs[MAX_REQUEST_LOG_ENTRIES - 1]).toMatchObject({ id: "req-105" })
})

test("clears request log storage", async () => {
  const file = await authFile()
  await appendRequestLog(file, logEntry())

  await clearRequestLogs(file)

  await expect(readRecentRequestLogs(file)).resolves.toEqual([])
  await expect(readFile(requestLogFilePath(file), "utf8")).rejects.toThrow()

  await appendRequestLog(file, logEntry({ id: "req-2" }))

  await expect(readRecentRequestLogs(file)).resolves.toEqual([expect.objectContaining({ id: "req-2" })])
})
