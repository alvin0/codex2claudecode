// Role: render and write one Transcript per live case — the file a maintainer opens to judge
// fidelity without trusting an assertion (Requirement 25.1). Sectioning, per-section limits,
// redaction, and path derivation live here; the Kiro frame view lives in `kiro-frames.ts`.
//
// Capture path — zero new mechanisms (Requirement 25.4). The upstream bytes come from
// `RequestProxyLog.requestBody` (populated by inbound from `RequestOptions.onRequestBody`) and
// `RequestProxyLog.responseBody` (from `onResponseBodyChunk`). This module reads those two
// fields and the client request/response the harness made itself. It adds no callback and no
// plumbing, and it leaves `DEBUG_PREVIEW_LIMIT` at 4000 for the existing debug-capture path.
//
// Diffability (Requirement 25.8). Everything run-specific — timestamps, ids, durations,
// credits, ports, volatile response headers — is quarantined in `## volatile`. Given identical
// captured input, every section above it is byte-identical across runs.
import { writeTextFile } from "../../src/core/bun-fs"
import { redactDebugText, redactDebugValue, redactSensitiveText } from "../../src/core/debug-capture"
import { bunPath as path } from "../../src/core/paths"
import type { JsonObject } from "../../src/core/types"

import type { NativeLiveCaseId } from "./cases"
import { renderKiroFrameView } from "./kiro-frames"
import type { NativeLiveCase, NativeLiveObservation } from "./types"

/** Fixed section order, so two runs of one case produce aligned diffs (design decision D5). */
export const NATIVE_TRANSCRIPT_SECTIONS = [
  "## case",
  "## client request",
  "## upstream request",
  "## upstream response (raw)",
  "## client response",
  "## assertions",
  "## volatile",
] as const

export type NativeTranscriptSection = (typeof NATIVE_TRANSCRIPT_SECTIONS)[number]

/** Gitignored by task 1.6; overridable with `NATIVE_TRANSCRIPT_DIR`. */
export const NATIVE_TRANSCRIPT_DIR_NAME = ".native-transcripts"

/**
 * Per-section byte limit. 262144 clears the measured 40 KB / 296-frame Kiro response with
 * headroom while bounding a multi-megabyte payload case (Requirement 25.6). This is the
 * transcript's own limit — `DEBUG_PREVIEW_LIMIT` stays at 4000.
 */
export const DEFAULT_NATIVE_TRANSCRIPT_LIMIT = 262_144

/** Case ids are kebab-case, so a path stays a pure, safe function of the id. */
const CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Response headers that change every run; listed under `## volatile`, never in a section above it. */
export const NATIVE_VOLATILE_HEADERS: readonly string[] = [
  "age",
  "cf-ray",
  "date",
  "etag",
  "request-id",
  "server-timing",
  "set-cookie",
  "x-amz-request-id",
  "x-amzn-requestid",
  "x-amzn-trace-id",
  "x-envoy-upstream-service-time",
  "x-request-id",
  "x-runtime",
]

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

export interface NativeTranscriptClientRequest {
  method?: string
  path: string
  headers?: Readonly<Record<string, string>>
  body?: JsonObject | string
}

export interface NativeTranscriptInput {
  liveCase: NativeLiveCase
  observation: NativeLiveObservation
  /** What the harness sent to the gateway. Defaults to the case's route and body. */
  clientRequest?: NativeTranscriptClientRequest
  /** Extra run-specific values to quarantine in `## volatile` (Requirement 25.8). */
  volatile?: Readonly<Record<string, string | number | undefined>>
  /** Per-section byte limit; defaults to `nativeTranscriptLimit()`. */
  limit?: number
  /** Output directory; defaults to `nativeTranscriptDir()`. */
  dir?: string
}

export interface NativeTranscriptResult {
  path: string
  content: string
}

export function nativeTranscriptDir(env: Record<string, string | undefined> = process.env) {
  const configured = env.NATIVE_TRANSCRIPT_DIR?.trim()
  return configured || NATIVE_TRANSCRIPT_DIR_NAME
}

export function nativeTranscriptLimit(env: Record<string, string | undefined> = process.env) {
  const parsed = Number(env.NATIVE_TRANSCRIPT_LIMIT)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_NATIVE_TRANSCRIPT_LIMIT
}

/**
 * The transcript path for a case. A pure function of the case id (Requirement 25.7): the same
 * id always yields the same path, and the file is overwritten each run so two runs diff.
 */
export function nativeTranscriptPath(caseId: NativeLiveCaseId | string, options: { dir?: string } = {}) {
  if (!CASE_ID_PATTERN.test(caseId)) throw new Error(`Case id is not path-safe: ${caseId}`)
  return path.join(options.dir ?? nativeTranscriptDir(), `${caseId}.transcript.md`)
}

/** Exact omitted byte count, so a truncated section still reports what it left out (Requirement 25.6). */
export function nativeTranscriptTruncationMarker(omittedBytes: number) {
  return `...[truncated: ${omittedBytes} bytes omitted]`
}

/**
 * Both redactors from `src/core/debug-capture.ts`, reused rather than reimplemented
 * (Requirement 25.5). `redactSensitiveText` handles the named credential keys and `Bearer`;
 * `redactDebugText` additionally collapses any 32-plus-character token run, which is what
 * catches values whose key it does not know — `signature`, for one.
 */
export function redactTranscriptText(text: string) {
  return redactDebugText(redactSensitiveText(text))
}

/**
 * Byte-bounded section body. Truncation lands on a UTF-8 boundary and the marker names the
 * exact number of omitted bytes, counted on the redacted text that would have been written.
 */
export function limitTranscriptSection(text: string, limit = nativeTranscriptLimit()) {
  const bytes = ENCODER.encode(text)
  if (bytes.length <= limit) return text

  let keep = Math.max(0, limit)
  while (keep > 0 && (bytes[keep] & 0xc0) === 0x80) keep -= 1
  const kept = DECODER.decode(bytes.subarray(0, keep))
  return `${kept}\n${nativeTranscriptTruncationMarker(bytes.length - keep)}`
}

/**
 * The upstream bytes for a run, read only from the two `RequestProxyLog` fields inbound
 * already fills. The observation mirrors of those fields are the fallback, since the harness
 * copies them from the same place (Requirement 25.4).
 */
export function nativeUpstreamCapture(observation: NativeLiveObservation) {
  const proxy = observation.requestLog?.proxy
  return {
    requestBody: proxy?.requestBody ?? observation.upstreamRequestBody,
    responseBody: proxy?.responseBody ?? observation.upstreamResponseBody,
  }
}

export function renderNativeTranscript(input: NativeTranscriptInput): string {
  const limit = input.limit ?? nativeTranscriptLimit()
  const bodies = sectionBodies(input)
  const parts = [transcriptHeader(input, limit)]

  for (const header of NATIVE_TRANSCRIPT_SECTIONS) {
    parts.push(`${header}\n\n${limitTranscriptSection(redactTranscriptText(bodies[header]), limit)}`)
  }

  return `${parts.join("\n\n")}\n`
}

export async function writeNativeTranscript(input: NativeTranscriptInput): Promise<NativeTranscriptResult> {
  const target = nativeTranscriptPath(input.liveCase.id, { dir: input.dir })
  const content = renderNativeTranscript(input)
  await writeTextFile(target, content)
  return { path: target, content }
}

function transcriptHeader(input: NativeTranscriptInput, limit: number) {
  return [
    `# native transcript: ${input.liveCase.id}`,
    "",
    `Per-section limit: ${limit} bytes (NATIVE_TRANSCRIPT_LIMIT). A longer section ends with the exact omitted byte count.`,
    "Redaction: every section passes through redactSensitiveText and redactDebugText from src/core/debug-capture.ts.",
    "Known limit: Kiro frame hexdumps re-encode UTF-8-decoded text, so CRC32 and other non-UTF-8 bytes read as EF BF BD.",
    "Everything run-specific lives in the volatile section; the sections above it are byte-identical across runs of the same input.",
  ].join("\n")
}

function sectionBodies(input: NativeTranscriptInput): Record<NativeTranscriptSection, string> {
  const { liveCase, observation } = input
  const capture = nativeUpstreamCapture(observation)
  const request = input.clientRequest ?? { method: "POST", path: liveCase.route, body: liveCase.body }

  return {
    "## case": lines([
      `id: ${liveCase.id}`,
      `title: ${liveCase.title}`,
      `route: ${liveCase.route}`,
      `upstream: ${liveCase.upstream}`,
      `model: ${typeof liveCase.body.model === "string" ? liveCase.body.model : "(unset)"}`,
      `baseline: ${liveCase.baseline}`,
      `flags: ${renderFlags(liveCase.flags)}`,
    ]),
    "## client request": lines([
      `${request.method ?? "POST"} ${request.path}`,
      "",
      "headers:",
      renderHeaders(request.headers),
      "",
      "body:",
      renderBody(request.body),
    ]),
    "## upstream request": lines([
      `upstream request count: ${observation.upstreamRequestCount ?? "(not counted)"}`,
      "",
      "body:",
      renderBody(capture.requestBody),
    ]),
    "## upstream response (raw)": renderUpstreamResponse(liveCase, capture.responseBody),
    "## client response": lines([
      `status: ${observation.status}`,
      "",
      "headers:",
      renderHeaders(observation.headers, { skip: NATIVE_VOLATILE_HEADERS }),
      "",
      "body:",
      observation.clientBody || "(empty)",
    ]),
    "## assertions": renderAssertions(liveCase, observation),
    "## volatile": renderVolatile(input),
  }
}

function renderUpstreamResponse(liveCase: NativeLiveCase, responseBody: string | undefined) {
  if (!responseBody) return "(not captured)"
  // Codex sends SSE text, recorded verbatim including `event:` and `data:` lines
  // (Requirement 25.3). Kiro sends binary EventStream, recorded as the frame view
  // (Requirement 25.2).
  return liveCase.upstream === "kiro" ? renderKiroFrameView(responseBody) : responseBody
}

function renderAssertions(liveCase: NativeLiveCase, observation: NativeLiveObservation) {
  if (!liveCase.assertions.length) return "(none declared)"

  return liveCase.assertions
    .map((assertion) => {
      const outcome = evaluateAssertion(assertion, observation)
      return `- [${outcome.label}] ${assertion.id}: ${assertion.description}${outcome.detail ? ` (${outcome.detail})` : ""}`
    })
    .join("\n")
}

/** A throwing assertion is recorded, not propagated: the transcript is written either way. */
function evaluateAssertion(
  assertion: NativeLiveCase["assertions"][number],
  observation: NativeLiveObservation,
): { label: "pass" | "fail" | "error"; detail?: string } {
  try {
    const result = assertion.evaluate(observation)
    return result.ok ? { label: "pass" } : { label: "fail", detail: result.detail }
  } catch (error) {
    return { label: "error", detail: error instanceof Error ? error.message : String(error) }
  }
}

function renderVolatile(input: NativeTranscriptInput) {
  const log = input.observation.requestLog
  const entries: string[] = []

  if (log) {
    entries.push(`request log id: ${log.id}`)
    entries.push(`request log at: ${log.at}`)
    entries.push(`gateway duration ms: ${log.durationMs}`)
    if (log.detailFile) entries.push(`detail file: ${log.detailFile}`)
    if (log.proxy) {
      entries.push(`upstream label: ${log.proxy.label}`)
      entries.push(`upstream target: ${log.proxy.target}`)
      entries.push(`upstream duration ms: ${log.proxy.durationMs}`)
    }
  }

  for (const [name, value] of sortedHeaderEntries(input.observation.headers)) {
    if (NATIVE_VOLATILE_HEADERS.includes(name)) entries.push(`response header ${name}: ${value}`)
  }

  for (const [key, value] of Object.entries(input.volatile ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (value !== undefined) entries.push(`${key}: ${value}`)
  }

  return entries.length ? entries.join("\n") : "(nothing run-specific recorded)"
}

function renderFlags(flags: NativeLiveCase["flags"]) {
  const entries = Object.entries(flags)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
  return entries.length ? entries.join(" ") : "(none)"
}

function renderHeaders(headers: Readonly<Record<string, string>> | undefined, options: { skip?: readonly string[] } = {}) {
  const kept = sortedHeaderEntries(headers).filter(([name]) => !options.skip?.includes(name))
  if (!kept.length) return "(none)"
  // `redactDebugValue` masks secret-named keys structurally before the text redactors run.
  return JSON.stringify(redactDebugValue(Object.fromEntries(kept)), null, 2)
}

function sortedHeaderEntries(headers: Readonly<Record<string, string>> | undefined): Array<[string, string]> {
  return Object.entries(headers ?? {})
    .map<[string, string]>(([name, value]) => [name.toLowerCase(), value])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
}

function renderBody(body: JsonObject | string | undefined) {
  if (body === undefined) return "(not captured)"
  if (typeof body !== "string") return JSON.stringify(redactDebugValue(body), null, 2)
  if (!body) return "(empty)"
  try {
    return JSON.stringify(redactDebugValue(JSON.parse(body)), null, 2)
  } catch {
    return body
  }
}

function lines(parts: readonly string[]) {
  return parts.join("\n")
}
