// Type-only, and the same import `types.ts` already makes for
// `StreamTelemetrySummary`. The notice shape belongs to the canonical contract, so
// this module borrows it rather than declaring a second definition that can drift
// from the one the accumulator and the summary projection both use.
import type { Canonical_FeatureNotice } from "./canonical"
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
  /**
   * Provider-side spend for this request, in the provider's own billing unit.
   *
   * A billing amount, never a token count: it is excluded from every token
   * arithmetic path, exactly as `Canonical_Usage.providerCredits` is.
   * `undefined` means "not measured" — the upstream reported no spend at all —
   * and is distinct from `0`, which means "measured as free".
   */
  providerCredits?: number
  /**
   * Non-native handling decisions for this request, in emission order, one entry
   * per event (Requirement 8.2).
   *
   * Omitted rather than empty when the stream carried no notice (Requirement 8.3),
   * so `undefined` and `[]` are not two spellings of the same answer — the same
   * convention `Canonical_Response.featureNotices` follows.
   *
   * Deliberately not deduped: repeats are preserved here because this is the
   * diagnostic record of what happened. Collapsing repeats by `(feature, detail)`
   * for display is the inbound renderer's job.
   */
  featureNotices?: Canonical_FeatureNotice[]
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
  providerCredits?: number
  private readonly featureNotices: Canonical_FeatureNotice[] = []

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

  /**
   * Record provider-side spend reported by one usage event.
   *
   * Adds to the running total rather than replacing it: a single gateway request
   * can make several upstream calls (a preflight plus the main generate), each
   * reporting its own spend, and the request's cost is their sum. Overwriting
   * would report only the last call. This is the same reason
   * `mergeCanonicalUsage()` sums the canonical field.
   *
   * A non-finite value is ignored so a malformed upstream number can never turn
   * the total into `NaN`. The credit parse path already rejects non-finite
   * values, but this is a public surface and stays total on its own.
   */
  recordProviderCredits(value: number): void {
    if (!Number.isFinite(value)) return
    this.providerCredits = (this.providerCredits ?? 0) + value
  }

  /**
   * Record one non-native handling decision reported by a `feature_notice` event.
   *
   * Takes the whole notice rather than three positional arguments. Two of the three
   * members are strings-in-disguise, so a positional signature would accept a
   * `(detail, feature)` swap at some call sites without complaint, and every caller
   * already holds the three members together — a `feature_notice` event, or an
   * element of `Canonical_Response.featureNotices`. A later member added to
   * {@link Canonical_FeatureNotice} also extends this method without changing its
   * arity or touching a single call site.
   *
   * Appends unconditionally: one entry per event, in emission order, repeats kept.
   * The three members are copied into a fresh object rather than the argument being
   * pushed, for two reasons — a caller passing a `feature_notice` event (structurally
   * assignable, since it carries `type` as an extra member) cannot leak `type` into
   * the snapshot, and a caller that later mutates the object it passed cannot rewrite
   * history here. Same construction as the fold in `canonical-accumulator.ts`, so the
   * streaming and non-streaming records are key-for-key identical.
   */
  recordFeatureNotice(notice: Canonical_FeatureNotice): void {
    this.featureNotices.push({ feature: notice.feature, policy: notice.policy, detail: notice.detail })
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
      providerCredits: this.providerCredits,
      // Genuinely absent when no notice arrived, not present-with-`undefined` the way
      // the scalar members above are emitted. Requirement 8.3 says "omit", and for an
      // array member the distinction is observable: a consumer reasonably writes
      // `"featureNotices" in telemetry` or `Object.keys(...)` rather than a `?? []`,
      // and `JSON.stringify` of a present-but-`undefined` member drops it anyway — so
      // omitting here is what the persisted form (task 8.4) already reports. This also
      // matches `accumulateCanonicalStream().finalize()` exactly, which keeps the
      // streaming and non-streaming halves of Requirement 8.3 readable side by side.
      //
      // The array is copied, not aliased: the snapshot is cached and returned by every
      // later `finalize()`, so handing out collector state would let a post-finalize
      // `recordFeatureNotice()` mutate an already-returned snapshot and break the
      // idempotence the cache exists to provide.
      ...(this.featureNotices.length ? { featureNotices: [...this.featureNotices] } : {}),
    }
    return this.finalizedSnapshot
  }
}
