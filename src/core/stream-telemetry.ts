import type { UsageSource } from "./usage-source"

/**
 * Lightweight stream telemetry for diagnosing production stream problems
 * without raw payload logs.
 */
export interface StreamTelemetry {
  /** Request identifier for correlation. */
  requestId: string
  /** Provider kind (codex, kiro). */
  provider: string
  /** Model identifier. */
  model: string
  /** Whether the request was streaming. */
  streaming: boolean
  /** Total request duration in milliseconds. */
  durationMs: number
  /** Time to first token in milliseconds (streaming only). */
  firstTokenMs?: number
  /** Terminal event type (message_stop, error, cancelled). */
  terminalEvent: string
  /** Number of emitted text content blocks. */
  textBlocks: number
  /** Number of emitted thinking content blocks. */
  thinkingBlocks: number
  /** Number of client tool calls. */
  clientToolCalls: number
  /** Number of server tool calls. */
  serverToolCalls: number
  /** Number of stream errors encountered. */
  streamErrors: number
  /** Whether usage was exact or estimated. */
  usageSource: UsageSource
  /** First-token retry attempts (Kiro only). */
  firstTokenRetries?: number
  /** Whether the stream was cancelled by the client. */
  clientCancelled: boolean
}

/**
 * Mutable telemetry collector for a single stream request.
 */
export class StreamTelemetryCollector {
  private readonly started = Date.now()
  private firstTokenTime?: number

  requestId = ""
  provider = ""
  model = ""
  streaming = false
  terminalEvent = "unknown"
  textBlocks = 0
  thinkingBlocks = 0
  clientToolCalls = 0
  serverToolCalls = 0
  streamErrors = 0
  usageSource: UsageSource = "unavailable"
  firstTokenRetries?: number
  clientCancelled = false

  constructor(init?: Partial<Pick<StreamTelemetry, "requestId" | "provider" | "model" | "streaming">>) {
    if (init?.requestId) this.requestId = init.requestId
    if (init?.provider) this.provider = init.provider
    if (init?.model) this.model = init.model
    if (init?.streaming !== undefined) this.streaming = init.streaming
  }

  /** Record the first token arrival. */
  markFirstToken(): void {
    if (!this.firstTokenTime) this.firstTokenTime = Date.now()
  }

  /** Record a text block emission. */
  recordTextBlock(): void {
    this.textBlocks += 1
  }

  /** Record a thinking block emission. */
  recordThinkingBlock(): void {
    this.thinkingBlocks += 1
  }

  /** Record a client tool call. */
  recordClientToolCall(): void {
    this.clientToolCalls += 1
  }

  /** Record a server tool call. */
  recordServerToolCall(): void {
    this.serverToolCalls += 1
  }

  /** Record a stream error. */
  recordStreamError(): void {
    this.streamErrors += 1
  }

  private finalizedSnapshot?: StreamTelemetry

  /** Finalize and return the telemetry snapshot. Idempotent — returns the same snapshot on repeated calls. */
  finalize(): StreamTelemetry {
    if (this.finalizedSnapshot) return this.finalizedSnapshot
    this.finalizedSnapshot = {
      requestId: this.requestId,
      provider: this.provider,
      model: this.model,
      streaming: this.streaming,
      durationMs: Date.now() - this.started,
      firstTokenMs: this.firstTokenTime ? this.firstTokenTime - this.started : undefined,
      terminalEvent: this.terminalEvent,
      textBlocks: this.textBlocks,
      thinkingBlocks: this.thinkingBlocks,
      clientToolCalls: this.clientToolCalls,
      serverToolCalls: this.serverToolCalls,
      streamErrors: this.streamErrors,
      usageSource: this.usageSource,
      firstTokenRetries: this.firstTokenRetries,
      clientCancelled: this.clientCancelled,
    }
    return this.finalizedSnapshot
  }
}
