import type { Canonical_Request } from "../../core/canonical"
import type { CodexModelMetadata } from "./model-metadata"

/**
 * Codex effort selection — where a client's effort intent becomes the level that goes on the wire
 * inside `reasoning: { effort, summary }`.
 *
 * Role, and only this role: **decide**, purely. No I/O, no environment, no notice, no payload.
 * It answers "given this model's effort descriptor and what the client asked for, what level
 * should be sent?" and returns the answer as data. Emitting the nested `reasoning` object stays in
 * `./parse.ts`; turning a decision into a `Canonical_FeatureNotice` stays in `./features.ts` plus
 * `./feature-notices.ts`; reading the registry stays in `./index.ts`.
 *
 * ## Why this is a Codex module and not a shared one
 *
 * `src/upstream/kiro/effort.ts` implements the same four-rung ladder, so the reuse question is
 * real and was decided deliberately rather than by convenience:
 *
 * - **Importing the Kiro module is not an option.** One upstream provider directory may not reach
 *   into another; `src/upstream/codex/*` importing `src/upstream/kiro/*` is the exact dependency
 *   the workspace architecture rules forbid, and for a good reason — it would make a Kiro-owned
 *   edit a Codex behavior change with no signal at either end.
 * - **Promoting the ladder to `src/core/` would be premature.** Core is for genuinely
 *   provider-agnostic contracts, not for behavior two providers happen to agree on today. The
 *   agreement here is *the spec's* (Requirements 16.1–16.3 name one precedence for every
 *   upstream), but everything the ladder touches is provider-owned: the level vocabulary comes
 *   from Kiro's `additionalModelRequestFieldsSchema` on one side and Codex's
 *   `supported_reasoning_levels` on the other (Requirement 12.7 puts that translation in the layer
 *   that owns the enum), the payload position differs (`additionalModelRequestFields` vs a nested
 *   `reasoning` object), and the two providers already diverge on out-of-enum handling — see below.
 *   A core helper would have to be parameterised over all three, at which point it carries less
 *   than the ladder itself.
 * - **The divergence is not hypothetical.** Kiro's `EffortDecision` has `out_of_enum` and
 *   `unsupported` arms because Kiro validates a stated level against the model enum and
 *   substitutes or rejects (Requirements 16.4, 16.5, task 21). This module has neither arm, because
 *   Codex forwards a stated level verbatim today and dropping it would be a silent regression —
 *   the Codex registry is empty until `listModels()` has run, so an enum check here would discard
 *   every client-stated effort on a cold start. Two unions with different arms are two contracts.
 *
 * So: same ladder, stated twice, each in the directory that owns its vocabulary. If a third
 * upstream needs it, that is the point to weigh a core abstraction with three cases in hand.
 *
 * ## Enum containment, and the one asymmetry with Kiro
 *
 * A level this module **chooses** — from the budget rung or the model default — is always drawn
 * from `metadata.levels`, so nothing invented here can put a value outside the model's own
 * vocabulary on the wire. A level the **client** stated is passed through unchecked: rejecting it
 * is validation, validation on this upstream is not yet declared, and silently swapping it would
 * be the drop Requirement 10 forbids. The `source` on a `selected` decision is what lets a later
 * task attach a notice to exactly the substitutions it owns.
 */

/**
 * A model's effort vocabulary, narrowed to what selection needs.
 *
 * Structurally the tail of `ProviderModelDescriptor["effort"]` in `src/core/interfaces.ts` minus
 * `schemaPath`: on this upstream the path is always the nested `reasoning` object, so carrying it
 * through the decision would be carrying a constant. {@link codexEffortMetadata} is the adapter
 * from the registry's own shape.
 */
export interface CodexEffortMetadata {
  levels: readonly string[]
  defaultLevel?: string
}

/** Which rung of the precedence ladder produced a selected level. */
export type CodexEffortSource = "explicit" | "budget" | "model_default"

/**
 * Why no effort is being sent. Both are silence on the wire and they are not the same event:
 * `thinking_disabled` is a client switching reasoning off (Requirement 16.9), `no_model_default`
 * is the absence of anything to say (Requirement 16.2).
 */
export type CodexEffortAbsentReason = "thinking_disabled" | "no_model_default"

/**
 * The outcome of one effort decision.
 *
 * A tagged union rather than `string | undefined` for the same reason Kiro's is: "nothing to send"
 * and "the client stated this" are different facts with different consequences downstream, and
 * `source` is what a notice-emitting caller branches on.
 */
export type CodexEffortDecision =
  | { kind: "selected"; source: CodexEffortSource; level: string }
  | { kind: "absent"; reason: CodexEffortAbsentReason }

/**
 * What the client asked for, narrowed to the two members that bear on effort, so the function is
 * pure in its arguments and testable without building a request.
 */
export interface CodexEffortIntent {
  /** `Canonical_Request.reasoningEffort` — the level the client stated, if any. */
  requested?: string
  /** `Canonical_Request.thinking` — mode and optional budget, as the client sent them. */
  thinking?: Canonical_Request["thinking"]
}

/**
 * Read a model's effort vocabulary off the registry entry, or `undefined` when the model declares
 * none.
 *
 * `thinkingEfforts` empty means no vocabulary, which is the same condition `listModelDescriptors()`
 * uses to decide whether to emit an `effort` descriptor at all — so a model that advertises no
 * levels produces no descriptor there and no metadata here, from one rule stated once.
 */
export function codexEffortMetadata(metadata: CodexModelMetadata | undefined): CodexEffortMetadata | undefined {
  if (!metadata || metadata.thinkingEfforts.length === 0) return undefined
  return {
    levels: metadata.thinkingEfforts.map((effort) => effort.thinkingEffort),
    ...(metadata.defaultThinkingEffort !== undefined && { defaultLevel: metadata.defaultThinkingEffort }),
  }
}

/**
 * Select the effort level for one request: **explicit ▸ budget ▸ model default ▸ absent**, with
 * `thinking.mode === "disabled"` short-circuiting the ladder to absent.
 *
 * The order is total — each rung is consulted only when every rung above it declined — so the
 * outcome is a function of the inputs and never of the order the members were written.
 *
 * Requirements 16.1 (apply `defaultLevel` when the client omits effort), 16.2 (omit when there is
 * no default), 16.3 (a stated client value beats the default), 16.9 (`disabled` omits).
 */
export function selectCodexEffortLevel(metadata: CodexEffortMetadata | undefined, intent: CodexEffortIntent = {}): CodexEffortDecision {
  // Rung 0 — an explicit "off" outranks every source of a level, including one the client itself
  // stated. `disabled` is not a preference between levels; it is a request for no reasoning.
  if (intent.thinking?.mode === "disabled") return { kind: "absent", reason: "thinking_disabled" }

  // Rung 1 — explicit. Consulted before the descriptor, so a stated value can never lose to a
  // default (Requirement 16.3). Forwarded unchecked; see the enum-containment note above.
  const requested = normalizeRequested(intent.requested)
  if (requested !== undefined) return { kind: "selected", source: "explicit", level: requested }

  if (!metadata) return { kind: "absent", reason: "no_model_default" }

  // Rung 2 — the token budget mapped into this model's vocabulary. Inert today; see
  // `codexBudgetToLevel()` for why declining is the only honest answer an unmapped rung can give.
  const fromBudget = codexBudgetToLevel(intent.thinking?.budgetTokens, metadata.levels)
  if (fromBudget !== undefined) return { kind: "selected", source: "budget", level: fromBudget }

  // Rung 3 — the model's own default, trusted only when it is a member of its own enum. A
  // descriptor whose default falls outside its levels is malformed, and honouring it would put a
  // value this module chose outside the model's vocabulary.
  const defaultLevel = metadata.defaultLevel
  if (defaultLevel !== undefined && metadata.levels.includes(defaultLevel)) {
    return { kind: "selected", source: "model_default", level: defaultLevel }
  }

  // Rung 4 — nothing to say.
  return { kind: "absent", reason: "no_model_default" }
}

/**
 * Return the request whose `reasoningEffort` is the one that should reach the wire.
 *
 * The adapter between the decision and the body builder, so `./parse.ts` keeps its single job —
 * canonical request in, Responses envelope out — and never learns about registries or precedence.
 * A `selected` level lands in `reasoningEffort`, which `canonicalToCodexBody()` emits as
 * `reasoning: { effort, summary: "auto" }` after task 19b.1; an `absent` decision strips the member
 * so no `reasoning` object is built at all.
 *
 * Returns the **same object** when nothing changes, so a request that already carries the level it
 * would have been given produces a byte-identical body and no needless copy.
 */
export function applyCodexEffortDefault(request: Canonical_Request, metadata: CodexEffortMetadata | undefined): Canonical_Request {
  const decision = selectCodexEffortLevel(metadata, effortIntentFromRequest(request))

  if (decision.kind === "selected") {
    if (request.reasoningEffort === decision.level) return request
    return { ...request, reasoningEffort: decision.level }
  }

  if (!request.reasoningEffort) return request
  const { reasoningEffort: _dropped, ...rest } = request
  return rest
}

/** Narrow a `Canonical_Request` to the effort intent it carries. */
export function effortIntentFromRequest(request: Pick<Canonical_Request, "reasoningEffort" | "thinking">): CodexEffortIntent {
  return {
    ...(request.reasoningEffort !== undefined && { requested: request.reasoningEffort }),
    ...(request.thinking !== undefined && { thinking: request.thinking }),
  }
}

/**
 * Map a thinking token budget onto a level of this model's enum.
 *
 * **Not mapped yet.** Returning `undefined` is this rung *declining*, which makes
 * {@link selectCodexEffortLevel} fall through to the model default exactly as it does for a request
 * carrying no budget at all. It never means "the lowest level" and no caller may read it that way.
 *
 * Declining rather than throwing is deliberate: today a canonical `thinking.budgetTokens` is
 * ignored on the Codex path, and an inert rung preserves that byte for byte, while a throwing stub
 * would turn every budget-carrying request into a 500. The budget→level mapping is a separate
 * concern with its own revert boundary (M16 for Kiro); when it lands for Codex it lands here, and
 * the only rule it inherits is that its result must be a member of `levels`.
 */
function codexBudgetToLevel(budgetTokens: number | undefined, levels: readonly string[]): string | undefined {
  void budgetTokens
  void levels
  return undefined
}

/**
 * An empty `reasoningEffort` is not a stated value.
 *
 * The same falsy reading `canonicalToCodexBody()`'s emit guard already applies, so an inbound
 * mapper that turns a missing field into `""` keeps meaning "the client stated nothing" — and
 * therefore now picks up the model default rather than sending silence. Deliberately **not**
 * trimmed: `" high"` is not a level any catalog advertises, and treating it as one would be this
 * module inventing a value the client did not send.
 */
function normalizeRequested(requested: string | undefined): string | undefined {
  return typeof requested === "string" && requested.length ? requested : undefined
}
