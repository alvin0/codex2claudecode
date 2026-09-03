// Type-only, and reciprocal with `canonical.ts`'s own type-only import of
// `JsonObject` from here. Both statements erase at compile time, so the pair is a
// compile-time reference cycle only — there is no runtime module cycle, and no
// evaluation-order hazard for either module. Keeping the notice shape in
// `canonical.ts` is the alternative-free choice: it is part of the canonical
// contract, and duplicating it here would create a second definition to drift.
import type { Canonical_FeatureNotice } from "./canonical"

export type JsonObject = Record<string, unknown>

export interface RequestOptions {
  headers?: HeadersInit
  signal?: AbortSignal
  onRequestBody?: (body: string) => void
  onResponseBodyChunk?: (chunk: string) => void
}

/**
 * The slice of a request's stream telemetry that is worth persisting in the request
 * log — deliberately narrower than `StreamTelemetry` in `core/stream-telemetry.ts`.
 *
 * `StreamTelemetry` is an in-process diagnostic snapshot of the whole stream. Only
 * two of its fields have no other home in the log:
 *
 * - `featureNotices` — the structured record of every non-native decision
 *   (Requirement 8.5), which exists nowhere else in the entry.
 * - `providerCredits` — provider-side spend, which is neither a token count nor a
 *   field of any wire usage block the log already carries.
 *
 * Everything else on the snapshot is either already on {@link RequestProxyLog} or
 * {@link RequestLogEntry} (`requestId`, `model`, `status`, `durationMs`, `error`) —
 * copying those would create a second source of truth that can disagree with the
 * first — or is stream-shape instrumentation (`textBlocks`, `usageSource`,
 * `firstTokenRetries`, …) that Requirement 8 does not ask the log to keep. Widening
 * this later is additive; narrowing it after consumers exist is not.
 */
export interface StreamTelemetrySummary {
  /** Non-native handling decisions, in emission order. Omitted when there were none. */
  featureNotices?: Canonical_FeatureNotice[]
  /** Provider-side spend in the upstream's own billing unit. Never a token count. */
  providerCredits?: number
}

export interface RequestProxyLog {
  label: string
  method: string
  target: string
  status: number
  durationMs: number
  error: string
  requestBody?: string
  responseBody?: string
  debug?: JsonObject
  /** Populated by the inbound provider from its stream telemetry collector. */
  telemetry?: StreamTelemetrySummary
}

export interface RequestLogEntry {
  id: string
  state?: "pending" | "complete"
  detailFile?: string
  at: string
  method: string
  path: string
  status: number
  durationMs: number
  error: string
  model?: string
  requestHeaders: Record<string, string>
  requestBody?: string
  responseBody?: string
  proxy?: RequestProxyLog
}

export type RequestLogMode = "sync" | "async" | "off"

export interface RuntimeOptions {
  apiPassword?: string
  authFile?: string
  authAccount?: string
  hostname?: string
  port?: number
  healthIntervalMs?: number
  healthTimeoutMs?: number
  logBody?: boolean
  requestLogMode?: RequestLogMode | (() => RequestLogMode)
  quiet?: boolean
  onRequestLogStart?: (entry: RequestLogEntry) => void
  onRequestLog?: (entry: RequestLogEntry) => void
}

export interface HealthStatus {
  ok: boolean
  checkedAt?: string
  latencyMs?: number
  status?: number
  error?: string
}

export interface SseEvent {
  event?: string
  data: string
}
