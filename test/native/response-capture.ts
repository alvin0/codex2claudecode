// Role: turn one HTTP response plus the gateway's request logs into a
// `NativeLiveObservation`. Parsing only — no network, no filesystem, no assertions — so the
// same projection is reachable from the live run and from an offline test with a canned
// response.
//
// `observation.ts` reads an observation; this module builds one. The split matters because
// building it needs the wire shape (content type, SSE framing, which log entry belongs to
// this request) and reading it must not.
import type { JsonObject, RequestLogEntry } from "../../src/core/types"

import type { NativeLiveCaseId } from "./cases"
import type { NativeLiveObservation, NativeSseEvent } from "./types"

export const SSE_CONTENT_TYPE = "text/event-stream"

/** Both routes answer either JSON or SSE; the content type is what decides how to read it. */
export function isSseContentType(contentType: string | null | undefined) {
  return (contentType ?? "").toLowerCase().includes(SSE_CONTENT_TYPE)
}

export function responseHeaderRecord(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of response.headers.entries()) headers[name.toLowerCase()] = value
  return headers
}

/**
 * Splits SSE text into events. `data` holds parsed JSON when the payload is JSON and the raw
 * string otherwise, which is what `eventTypes()` and `usage()` in `observation.ts` expect.
 * Multi-line `data:` payloads are joined with newlines, per the SSE format.
 */
export function parseSseText(text: string): NativeSseEvent[] {
  const events: NativeSseEvent[] = []

  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue
    let eventName: string | undefined
    const dataLines: string[] = []

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim()
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
    }

    if (!eventName && !dataLines.length) continue
    const raw = dataLines.join("\n")
    events.push({ ...(eventName ? { event: eventName } : {}), data: parseJsonValue(raw) ?? raw })
  }

  return events
}

export function parseJsonObjectText(text: string): JsonObject | undefined {
  const parsed = parseJsonValue(text)
  return isJsonObject(parsed) ? parsed : undefined
}

export interface CaptureNativeObservationInput {
  caseId: NativeLiveCaseId
  response: Response
  /** Body already read off the response; a `Response` body can only be consumed once. */
  clientBody: string
  /** Every completed request log the gateway recorded for this run, in arrival order. */
  logs: readonly RequestLogEntry[]
  /** The entry belonging to this client request. Defaults to the last log carrying a proxy call. */
  requestLog?: RequestLogEntry
  /** Bytes from a direct upstream call, for the byte-equality case only. */
  directUpstreamBody?: string
}

export function captureNativeObservation(input: CaptureNativeObservationInput): NativeLiveObservation {
  const { response, clientBody } = input
  const sse = isSseContentType(response.headers.get("content-type"))
  const requestLog = input.requestLog ?? [...input.logs].reverse().find((entry) => entry.proxy)
  const proxy = requestLog?.proxy

  return {
    caseId: input.caseId,
    status: response.status,
    headers: responseHeaderRecord(response),
    clientBody,
    ...(sse ? {} : withKey("clientJson", parseJsonObjectText(clientBody))),
    clientEvents: sse ? parseSseText(clientBody) : [],
    ...withKey("upstreamRequestBody", proxy?.requestBody),
    ...withKey("upstreamResponseBody", proxy?.responseBody),
    upstreamRequestCount: countUpstreamRequests(input.logs),
    ...withKey("requestLog", requestLog),
    ...withKey("directUpstreamBody", input.directUpstreamBody),
  }
}

/**
 * Upstream calls the run made, counted as the request logs that recorded a proxy call. Model
 * metadata lookups the providers issue outside a request never produce a log entry, so this
 * counts client-driven upstream calls only — which is what the count is asserted on.
 */
export function countUpstreamRequests(logs: readonly RequestLogEntry[]) {
  return logs.filter((entry) => entry.proxy !== undefined).length
}

function parseJsonValue(text: string): unknown {
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Keeps optional fields absent rather than explicitly `undefined`, so transcripts stay stable. */
function withKey<K extends string, V>(key: K, value: V | undefined) {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}
