import { afterEach, expect, test } from "bun:test"

import {
  appendRequestLog,
  clearRequestLogs,
  ensureRequestLogFile,
  MAX_REQUEST_LOG_ENTRIES,
  readRecentRequestLogs,
  readRequestLogDetail,
  requestLogDetailFilePath,
  requestLogFilePath,
  requestLogModel,
} from "../src/core/request-logs"
import type { Canonical_FeatureNotice } from "../src/core/canonical"
import type { RequestLogEntry, RequestProxyLog, StreamTelemetrySummary } from "../src/core/types"
import { mkdtemp, path, readFile, rm, tmpdir, writeFile } from "./helpers"

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
  expect(JSON.parse((await readFile(requestLogDetailFilePath(file, entry.id), "utf8")).trim())).toMatchObject({
    id: "req-1",
    requestBody: '{"input":"hi"}',
  })
  expect(await readRequestLogDetail(file, (await readRecentRequestLogs(file))[0])).toMatchObject({
    id: "req-1",
    requestBody: '{"input":"hi"}',
  })
})

test("persists request model in recent log summaries", async () => {
  const file = await authFile()

  await appendRequestLog(file, logEntry({
    requestBody: JSON.stringify({ model: "claude-sonnet-4.5", messages: [] }),
  }))

  const summary = JSON.parse((await readFile(requestLogFilePath(file), "utf8")).trim()) as RequestLogEntry
  expect(summary.model).toBe("claude-sonnet-4.5")
  expect(summary.requestBody).toBeUndefined()
  expect(requestLogModel(summary)).toBe("claude-sonnet-4.5")
})

test("extracts request model from proxy body when client body is unavailable", () => {
  expect(requestLogModel(logEntry({
    requestBody: undefined,
    proxy: {
      label: "Kiro messages",
      method: "POST",
      target: "upstream",
      status: 200,
      durationMs: 12,
      error: "-",
      requestBody: JSON.stringify({ model: "claude-opus-4.6" }),
    },
  }))).toBe("claude-opus-4.6")
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
  await expect(readFile(requestLogDetailFilePath(file, "req-1"), "utf8")).rejects.toThrow()
  await expect(readFile(requestLogDetailFilePath(file, "req-105"), "utf8")).resolves.toContain('"req-105"')
})

test("clears request log storage", async () => {
  const file = await authFile()
  await appendRequestLog(file, logEntry())

  await clearRequestLogs(file)

  await expect(readRecentRequestLogs(file)).resolves.toEqual([])
  await expect(readFile(requestLogFilePath(file), "utf8")).rejects.toThrow()
  await expect(readFile(requestLogDetailFilePath(file, "req-1"), "utf8")).rejects.toThrow()

  await appendRequestLog(file, logEntry({ id: "req-2" }))

  await expect(readRecentRequestLogs(file)).resolves.toEqual([expect.objectContaining({ id: "req-2" })])
})

function proxyLog(telemetry?: StreamTelemetrySummary): RequestProxyLog {
  return {
    label: "Kiro messages",
    method: "POST",
    target: "upstream",
    status: 200,
    durationMs: 12,
    error: "-",
    responseBody: "hello",
    ...(telemetry ? { telemetry } : {}),
  }
}

const notice: Canonical_FeatureNotice = {
  feature: "thinkingBudget",
  policy: "degrade",
  detail: "thinking budget clamped to the upstream maximum",
}

test("carries proxy telemetry into the detail file and the recent-log summary", async () => {
  const file = await authFile()
  const entry = logEntry({ proxy: proxyLog({ featureNotices: [notice], providerCredits: 0.0148 }) })

  await appendRequestLog(file, entry)

  const detail = JSON.parse(await readFile(requestLogDetailFilePath(file, entry.id), "utf8")) as RequestLogEntry
  expect(detail.proxy?.telemetry).toEqual({ featureNotices: [notice], providerCredits: 0.0148 })

  const summary = JSON.parse((await readFile(requestLogFilePath(file), "utf8")).trim()) as RequestLogEntry
  expect(summary.proxy?.telemetry).toEqual({ featureNotices: [notice], providerCredits: 0.0148 })
  // The summary is the projection the panel reads, so telemetry must be there without
  // the bodies the projection drops.
  expect(summary.proxy?.responseBody).toBeUndefined()

  const [recent] = await readRecentRequestLogs(file)
  expect(recent?.proxy?.telemetry?.featureNotices).toEqual([notice])
  expect(await readRequestLogDetail(file, recent!)).toMatchObject({
    proxy: { telemetry: { providerCredits: 0.0148 } },
  })
})

test("keeps every collected feature notice in emission order through both projections", async () => {
  const file = await authFile()
  const notices: Canonical_FeatureNotice[] = [
    notice,
    { feature: "webSearch", policy: "emulate", detail: "web search emulated with a local fetch" },
  ]

  await appendRequestLog(file, logEntry({ proxy: proxyLog({ featureNotices: notices, providerCredits: undefined }) }))

  const detail = JSON.parse(await readFile(requestLogDetailFilePath(file, "req-1"), "utf8")) as RequestLogEntry
  const summary = JSON.parse((await readFile(requestLogFilePath(file), "utf8")).trim()) as RequestLogEntry
  expect(detail.proxy?.telemetry?.featureNotices).toEqual(notices)
  expect(summary.proxy?.telemetry?.featureNotices).toEqual(notices)
})

test("omits featureNotices rather than writing an empty array when no notice was collected", async () => {
  const file = await authFile()

  await appendRequestLog(file, logEntry({ proxy: proxyLog({ providerCredits: 0 }) }))

  const detail = JSON.parse(await readFile(requestLogDetailFilePath(file, "req-1"), "utf8")) as RequestLogEntry
  const summary = JSON.parse((await readFile(requestLogFilePath(file), "utf8")).trim()) as RequestLogEntry
  expect("featureNotices" in detail.proxy!.telemetry!).toBe(false)
  expect("featureNotices" in summary.proxy!.telemetry!).toBe(false)
  // 0 means "measured as free" and must not be normalized away as falsy.
  expect(detail.proxy?.telemetry?.providerCredits).toBe(0)
  expect(summary.proxy?.telemetry?.providerCredits).toBe(0)
})

test("keeps providerCredits present in memory while JSON drops the undefined member on disk", async () => {
  const file = await authFile()
  const telemetry: StreamTelemetrySummary = { providerCredits: undefined }
  const entry = logEntry({ proxy: proxyLog(telemetry) })

  await appendRequestLog(file, entry)

  // In memory the member stays present, carrying `undefined` for "not measured".
  expect("providerCredits" in entry.proxy!.telemetry!).toBe(true)
  // On disk JSON cannot encode that, so the key is absent — but the value every
  // consumer reads is `undefined` either way.
  const detail = JSON.parse(await readFile(requestLogDetailFilePath(file, entry.id), "utf8")) as RequestLogEntry
  expect(detail.proxy?.telemetry).toEqual({})
  expect(detail.proxy?.telemetry?.providerCredits).toBeUndefined()

  const summary = JSON.parse((await readFile(requestLogFilePath(file), "utf8")).trim()) as RequestLogEntry
  expect(summary.proxy?.telemetry).toEqual({})
})

test("leaves a proxy log without telemetry unchanged", async () => {
  const file = await authFile()

  await appendRequestLog(file, logEntry({ proxy: proxyLog() }))

  const detail = JSON.parse(await readFile(requestLogDetailFilePath(file, "req-1"), "utf8")) as RequestLogEntry
  const summary = JSON.parse((await readFile(requestLogFilePath(file), "utf8")).trim()) as RequestLogEntry
  expect("telemetry" in detail.proxy!).toBe(false)
  expect("telemetry" in summary.proxy!).toBe(false)
  expect(summary.proxy).toEqual({
    label: "Kiro messages",
    method: "POST",
    target: "upstream",
    status: 200,
    durationMs: 12,
    error: "-",
  })
})

test("leaves an entry without a proxy log free of telemetry", async () => {
  const file = await authFile()

  await appendRequestLog(file, logEntry())

  const summary = JSON.parse((await readFile(requestLogFilePath(file), "utf8")).trim()) as RequestLogEntry
  expect("proxy" in summary).toBe(false)
  const [recent] = await readRecentRequestLogs(file)
  expect(recent?.proxy).toBeUndefined()
})
