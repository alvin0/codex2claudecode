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
  /**
   * Generation controls the client asked for, in provider-neutral names.
   *
   * Every sub-member is optional and the member itself is **omitted entirely** when the client
   * sent none of them — an object of `undefined` sub-members would read as "the client asked for
   * defaults" where the truth is "the client asked for nothing" (Requirement 13.5). Upstream
   * feature resolvers key their `sampling` / `outputLength` / `stopSequences` decisions off
   * presence, so an empty carrier would make them fire for requests that carry no intent.
   *
   * `maxOutputTokens` is kept beside `temperature`/`topP` rather than promoted to a top-level
   * member because it is a generation control like the others; that upstreams declare a separate
   * `outputLength` policy for it is a matrix fact owned by `src/upstream/<provider>/`, not a
   * reason for the canonical shape to split.
   */
  sampling?: {
    maxOutputTokens?: number
    temperature?: number
    topP?: number
    stopSequences?: string[]
  }
  /**
   * The client's thinking request, as intent rather than as any provider's spelling of it.
   *
   * `mode` is required because a present `thinking` member with no mode says nothing: the member
   * exists precisely to record that the client made a choice. `budgetTokens` is optional because
   * a client may enable thinking without naming a budget.
   *
   * Deliberately **not** folded into {@link Canonical_Request.reasoningEffort} (Requirement 12.7).
   * A token budget and an effort level are different quantities, and `reasoningEffort` is
   * provider-enum-shaped: mapping one to the other requires knowing a specific model's level
   * vocabulary, which only the upstream layer knows. Inbound records what the client asked for;
   * the upstream that owns the enum performs the translation, which is also the only way a
   * degrade notice can name both the requested budget and the substituted level.
   */
  thinking?: {
    mode: "enabled" | "disabled" | "adaptive"
    budgetTokens?: number
  }
  /**
   * Which parts of the request the client marked as worth caching upstream, in request order.
   *
   * A list rather than a set of booleans because a client may mark several scopes with different
   * lifetimes, and order is the order the client wrote them — the only order an upstream can
   * report back without inventing one. `scope` is required: an entry naming no scope carries no
   * hint. `ttl` stays a string because it is a client-supplied duration token, not a number this
   * layer is entitled to reinterpret.
   *
   * Omitted rather than empty when the client marked nothing, for the same reason `sampling` is.
   */
  cacheHint?: Array<{ scope: "system" | "tools" | "history"; ttl?: string }>
  /**
   * Whether the client permits more than one tool call per assistant turn.
   *
   * Tri-state on purpose: `undefined` means the client expressed no preference and the upstream
   * default stands, which is a different answer from an explicit `true`. Inbound providers whose
   * wire field is negative (`disable_parallel_tool_use`) invert it at their own boundary rather
   * than pushing the negation into core.
   */
  parallelToolCalls?: boolean
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
  /**
   * What the upstream already knows about token usage when the stream opens, before any event
   * has been read.
   *
   * An upstream that builds its own request payload counts the input it is about to send, so it
   * knows `inputTokens` at construction time; the `usage` events it yields later carry the same
   * figure. Without this field an inbound renderer has to invent an opening number and then
   * contradict it — Claude's `message_start` would report a local estimate of the *client's*
   * request while `message_delta` reports what the upstream actually processed, and the two
   * differ by whatever the gateway added on the way out (embedded instructions, tool docs).
   *
   * Optional because not every upstream knows: Codex and Copilot learn their input count only
   * from the usage frames the endpoint sends mid-stream. An absent field means "no better answer
   * than the renderer's own estimate", never "zero".
   */
  usage?: Partial<Canonical_Usage>
  events: AsyncIterable<Canonical_Event>
}

export type Canonical_Event =
  | { type: "text_delta"; delta: string }
  // `annotations` are the upstream's own citation records for this text, in its wire shape.
  // Carried here because a streaming renderer has no other way to reach them: the non-streaming
  // path reads them off `Canonical_TextBlock.annotations`, and without this field the streaming
  // path silently drops every citation an upstream produced.
  | { type: "text_done"; text: string; annotations?: JsonObject[] }
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
  /**
   * Non-native handling decisions for this request, in decision order.
   *
   * The same member, element type, order and presence rule as
   * {@link Canonical_Response.featureNotices} — a rejection is a fourth channel for the
   * same data, not a different vocabulary. Resolution deliberately continues past a
   * rejection, so a request that fails on one feature can still have decided others; a
   * 400 that reported only the failing field would discard the rest of the account the
   * collector kept.
   *
   * Omitted rather than empty when the request recorded no notice, so `undefined` and
   * `[]` are not two spellings of the same answer.
   */
  featureNotices?: Canonical_FeatureNotice[]
}

export interface Canonical_PassthroughResponse {
  type: "canonical_passthrough"
  status: number
  statusText: string
  headers: Headers
  body: ReadableStream<Uint8Array> | Uint8Array | string | null
}
