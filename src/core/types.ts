export type JsonObject = Record<string, unknown>

export interface RequestOptions {
  headers?: HeadersInit
  signal?: AbortSignal
  onRequestBody?: (body: string) => void
  onResponseBodyChunk?: (chunk: string) => void
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

export interface RuntimeOptions {
  authFile?: string
  authAccount?: string
  hostname?: string
  port?: number
  healthIntervalMs?: number
  healthTimeoutMs?: number
  logBody?: boolean
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
