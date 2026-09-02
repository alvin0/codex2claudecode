import type { FeaturePolicy, ProviderFeature } from "./provider-capabilities"
import type { JsonObject } from "./types"

export interface Canonical_Request {
  model: string
  instructions?: string
  input: Canonical_InputMessage[]
  tools?: JsonObject[]
  toolChoice?: JsonObject | string
  include?: string[]
  textFormat?: JsonObject
  reasoningEffort?: string
  stream: boolean
  passthrough: boolean
  metadata: Record<string, unknown>
}

export interface Canonical_InputMessage {
  role: "user" | "assistant" | "tool"
  content: JsonObject[]
}

/**
 * The policies a feature notice is allowed to carry.
 *
 * Derived from {@link FeaturePolicy} by subtraction rather than restated as a fresh
 * `"degrade" | "emulate"` union, so the exclusion is a property of the type rather
 * than of a comment: `native` forwards the client value untouched and therefore has
 * nothing to report, and `reject` fails the request down the
 * {@link Canonical_ErrorResponse} path. Neither can ever appear on a notice, and a
 * rename of a surviving policy cannot leave this alias silently stale the way a
 * hand-written union would.
 *
 * `Exclude` has one weakness — it would absorb a hypothetical fifth policy without
 * comment. The two guards below close it, so a new `FeaturePolicy` member fails to
 * compile here until someone decides deliberately which side of the notice boundary
 * it belongs on. Requirements 8.1 and 8.6 restrict notices to exactly these two.
 */
export type Canonical_FeatureNoticePolicy = Exclude<FeaturePolicy, "native" | "reject">

/**
 * Bidirectional drift guards for {@link Canonical_FeatureNoticePolicy}. Same idiom as
 * the union/array guards in `provider-capabilities.ts`; both must resolve to `never`.
 * The literals here are a tripwire, not the source of truth — the alias above is.
 */
type AssertNever<T extends never> = T
/** A fifth `FeaturePolicy` may not silently widen the notice vocabulary. */
type _NoticePolicyNeverWidens = AssertNever<Exclude<Canonical_FeatureNoticePolicy, "degrade" | "emulate">>
/** …and neither `degrade` nor `emulate` may silently vanish from it. */
type _NoticePolicyNeverNarrows = AssertNever<Exclude<"degrade" | "emulate", Canonical_FeatureNoticePolicy>>

/**
 * One non-native handling decision, reported to the client as structured data.
 *
 * Emitted only by upstream providers, because only they resolve policy.
 *
 * `detail` is a non-empty human-readable explanation of what was changed and why
 * (Requirement 8.1). Non-emptiness is not expressible in the type system without a
 * branded type, so it is a construction-site obligation that the notice tests own.
 */
export interface Canonical_FeatureNotice {
  feature: ProviderFeature
  policy: Canonical_FeatureNoticePolicy
  detail: string
}

export interface Canonical_Response {
  type: "canonical_response"
  id: string
  model: string
  stopReason: string
  content: Canonical_ContentBlock[]
  usage: Canonical_Usage
  /**
   * Non-native handling decisions for this request, in decision order.
   *
   * Omitted rather than empty when every feature was handled natively, so
   * `undefined` and `[]` are not two spellings of the same answer.
   */
  featureNotices?: Canonical_FeatureNotice[]
}

export type Canonical_ContentBlock =
  | Canonical_TextBlock
  | Canonical_ToolCallBlock
  | Canonical_ServerToolBlock
  | Canonical_ThinkingBlock

export interface Canonical_TextBlock {
  type: "text"
  text: string
  annotations?: JsonObject[]
}

export interface Canonical_ToolCallBlock {
  type: "tool_call"
  id: string
  callId: string
  name: string
  arguments: string
}

export interface Canonical_ServerToolBlock {
  type: "server_tool"
  blocks: JsonObject[]
}

export interface Canonical_ThinkingBlock {
  type: "thinking"
  thinking: string
  signature: string
}

export interface Canonical_Usage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  outputReasoningTokens?: number
  /**
   * Provider-side spend for this request, expressed in the upstream provider's own billing unit.
   *
   * Deliberately not a token count: it is money-shaped, not context-shaped, so it is excluded from
   * every token arithmetic path (`canonicalInputTokenTotal()`, the `Math.max` merges in
   * `mergeCanonicalUsage()`, and the wire-usage readers in `canonicalUsageFromWireUsage()`).
   * `mergeCanonicalUsage()` **sums** it rather than taking a maximum, because a single gateway
   * request can make several upstream calls and the request's spend is their total.
   *
   * Absent when the upstream provider reports no spend. `undefined` and `0` are different answers:
   * `undefined` means "not measured", `0` means "measured as free".
   */
  providerCredits?: number
  serverToolUse?: {
    webSearchRequests?: number
    webFetchRequests?: number
    mcpCalls?: number
  }
}

export interface Canonical_StreamResponse {
  type: "canonical_stream"
  status: number
  id: string
  model: string
  events: AsyncIterable<Canonical_Event>
}

export type Canonical_Event =
  | { type: "text_delta"; delta: string }
  | { type: "text_done"; text: string }
  | { type: "tool_call_delta"; callId: string; name: string; argumentsDelta: string }
  | { type: "tool_call_done"; callId: string; name: string; arguments: string }
  | { type: "server_tool_block"; blocks: JsonObject[] }
  | { type: "thinking_delta"; label?: string; text?: string }
  | { type: "thinking_signature"; signature: string }
  | { type: "usage"; usage: Partial<Canonical_Usage> }
  // Out-of-band metadata like `usage`: it carries no model output, so it is
  // token-neutral and may appear anywhere in the stream. Providers yield notices
  // before the upstream content, except for ones decided mid-stream.
  | { type: "feature_notice"; feature: ProviderFeature; policy: Canonical_FeatureNoticePolicy; detail: string }
  | { type: "content_block_start"; blockType: string; index: number; block?: JsonObject }
  | { type: "content_block_stop"; index: number }
  | { type: "message_start"; id: string; model: string }
  | { type: "message_stop"; stopReason: string }
  | { type: "error"; message: string }
  | { type: "completion"; output?: unknown; usage?: Canonical_Usage; stopReason?: string; incompleteReason?: string }
  | { type: "lifecycle"; label: string }
  | { type: "message_item_done"; item: JsonObject }

export interface Canonical_ErrorResponse {
  type: "canonical_error"
  status: number
  headers: Headers
  body: string
}

export interface Canonical_PassthroughResponse {
  type: "canonical_passthrough"
  status: number
  statusText: string
  headers: Headers
  body: ReadableStream<Uint8Array> | Uint8Array | string | null
}
