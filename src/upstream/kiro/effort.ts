import type { Canonical_Request } from "../../core/canonical"
import { parseReasoningModel, splitModelSuffix } from "../../core/reasoning"
import { REASONING_EFFORT_BUDGETS } from "./constants"
import type { KiroModelEffortMetadata } from "./model-metadata"
import type { KiroEffortSelection } from "./types"

/**
 * Kiro effort selection — the one place client effort intent becomes the reasoning level that
 * goes on the wire.
 *
 * Role, and only this role: **decide**, purely. This module reads no environment, performs no
 * I/O, builds no payload, and emits no notice. It answers one question — "given this model's
 * effort descriptor and what the client asked for, what level should be sent?" — and returns the
 * answer as data a caller branches on. Writing `additionalModelRequestFields` stays in
 * `./payload.ts`; turning a decision into a `Canonical_FeatureNotice` stays in `./features.ts`
 * plus `./feature-notices.ts`; deciding a status code stays in `./index.ts`.
 *
 * It lives upstream of core deliberately: the per-model level vocabulary comes from Kiro's
 * `additionalModelRequestFieldsSchema` (`./model-metadata.ts`), and Requirement 12.7 places that
 * translation in the layer that owns the enum. `src/core/` never learns a Kiro level name.
 *
 * ## Why the return is a union rather than an optional level
 *
 * "No level to send" and "the client named a level this model rejects" are different facts with
 * different consequences: the first is silence, the second is a substitution plus a notice today
 * and a 400 under `NATIVE_STRICT` (Requirements 16.4, 16.5). Collapsing both into
 * `string | undefined` would force the caller to re-derive the difference from the inputs, which
 * is exactly the derivation this module exists to perform once. So the decision is tagged, and
 * every tag is a case a caller must handle.
 *
 * Enum containment is a **post-condition of this function**, not a caller obligation: a
 * `selected` decision always carries a level drawn from `metadata.levels` (Property 14). An
 * out-of-enum request never becomes a `selected` decision — it becomes {@link EffortDecision} of
 * kind `out_of_enum`, so nothing this module returns can put an invalid value on the wire.
 */

/** Which rung of the precedence ladder produced a selected level. */
export type EffortSource = "explicit" | "budget" | "model_default"

/**
 * Why no effort is being sent. Both reasons are silence on the wire, but they are not the same
 * event: `thinking_disabled` is a client choice to switch reasoning off (Requirement 16.9), while
 * `no_model_default` is the absence of anything to say (Requirement 16.2).
 */
export type EffortAbsentReason = "thinking_disabled" | "no_model_default"

/**
 * The outcome of one effort decision.
 *
 * - `selected` — send `effort`; `source` records which rung won, which is what lets a caller emit
 *   a notice only when a substitution actually happened.
 * - `absent` — send nothing.
 * - `out_of_enum` — the client named a level this model does not accept. Carries `levels` so the
 *   classifier in task 21 (`validateKiroEffort()`) can compute a nearest level without re-reading
 *   the descriptor, and `schemaPath` so a substituted level knows where it goes in the payload.
 * - `unsupported` — the client named a level for a model that declares no effort enum at all.
 */
export type EffortDecision =
  | { kind: "selected"; source: EffortSource; effort: KiroEffortSelection }
  | { kind: "absent"; reason: EffortAbsentReason }
  | { kind: "out_of_enum"; requested: string; levels: string[]; schemaPath: KiroModelEffortMetadata["schemaPath"] }
  | { kind: "unsupported"; requested: string }

/**
 * What the client asked for, narrowed to the two members that bear on effort.
 *
 * A narrow input rather than the whole `Canonical_Request` so the function is a pure function of
 * its two arguments and testable without constructing a request. {@link effortIntentFromRequest}
 * is the adapter for callers that hold a request.
 */
export interface EffortIntent {
  /** `Canonical_Request.reasoningEffort` — the level the client stated, if any. */
  requested?: string
  /** `Canonical_Request.thinking` — mode and optional token budget, as the client sent them. */
  thinking?: Canonical_Request["thinking"]
}

/**
 * Select the effort level for one request: **explicit ▸ budget ▸ model default ▸ absent**, with
 * `thinking.mode === "disabled"` short-circuiting the whole ladder to absent.
 *
 * The order is a total one — each rung is consulted only when every rung above it declined — so
 * the outcome is a function of the inputs alone and never of the order the members were written.
 *
 * `metadata` is the model's effort descriptor from `./model-metadata.ts`. It is structurally the
 * same shape as `ProviderModelDescriptor["effort"]` in `src/core/interfaces.ts`, so a caller
 * holding either can pass it; the Kiro alias is named here because this file is Kiro's.
 * `undefined` means the model declares no effort enum.
 *
 * Requirements 16.1 (apply `defaultLevel` when the client omits effort), 16.2 (omit when there is
 * no default), 16.3 (a stated client value beats the default), 16.9 (`disabled` omits).
 */
export function selectEffortLevel(metadata: KiroModelEffortMetadata | undefined, intent: EffortIntent = {}): EffortDecision {
  // Rung 0 — an explicit "off" outranks every source of a level, including one the client itself
  // stated. `disabled` is not a preference between levels; it is a request for no reasoning.
  if (intent.thinking?.mode === "disabled") return { kind: "absent", reason: "thinking_disabled" }

  const requested = normalizeRequested(intent.requested)

  // Rung 1 — explicit. Checked before the descriptor is consulted for a default, so a stated
  // value can never lose to one (Requirement 16.3).
  if (requested !== undefined) {
    if (!metadata) return { kind: "unsupported", requested }
    if (metadata.levels.includes(requested)) return selected("explicit", metadata.schemaPath, requested)
    return { kind: "out_of_enum", requested, levels: [...metadata.levels], schemaPath: metadata.schemaPath }
  }

  if (!metadata) return { kind: "absent", reason: "no_model_default" }

  // Rung 2 — the token budget, mapped into this model's vocabulary (Requirement 16.7). Reached
  // only because rung 1 found no stated level, which is Requirement 16.8's precedence: a budget
  // beside an explicit effort is never mapped, so it can never produce a notice either.
  // `undefined` from `budgetToLevel()` is a decline, not a level; the ladder falls through.
  const fromBudget = budgetToLevel(intent.thinking?.budgetTokens, metadata.levels)
  if (fromBudget !== undefined) return selected("budget", metadata.schemaPath, fromBudget)

  // Rung 3 — the model's own default. Trusted only when it is a member of its own enum; a
  // descriptor whose default falls outside its levels is malformed, and honouring it would break
  // the enum-containment post-condition (Property 14). `parseEffortMetadata()` already drops such
  // a default, so this guard is a second line rather than the only one.
  const defaultLevel = metadata.defaultLevel
  if (defaultLevel !== undefined && metadata.levels.includes(defaultLevel)) {
    return selected("model_default", metadata.schemaPath, defaultLevel)
  }

  // Rung 4 — nothing to say.
  return { kind: "absent", reason: "no_model_default" }
}

/**
 * The classified outcome of validating one requested effort level.
 *
 * Every member other than `{ ok: true }` carries a `code` that is a **literal**, so the caller in
 * task 22.1 branches on `result.code === "effort_not_in_enum"` and never on the shape of a
 * message. Requirement 6.3 asks for exactly that: the message is presentation, the code is the
 * contract, and a reworded message must not be able to change control flow.
 *
 * - `effort_not_in_enum` — the model publishes an effort enum and the requested level is not in
 *   it. Carries `levels` (the model's own vocabulary) and {@link EffortValidation.nearest}, the
 *   member of that vocabulary a degrading caller should send instead (Requirement 16.4).
 * - `effort_unsupported` — the model publishes no effort enum at all, so there is nothing to
 *   substitute. A distinct code rather than a variant of the above, because the handling differs:
 *   task 22.1 degrades the first with a substituted level and the second with a notice only.
 * - `metadata_unavailable` — the registry has not loaded, so the enum is unknown and *no* claim
 *   about the requested level is possible. This is infrastructure, not a feature gap, and it keeps
 *   the existing `503` (Requirement 6.4). The status travels on the result so the caller does not
 *   re-derive it from the code.
 *
 * This union adds **no rules** to the validation that exists today: it re-expresses the three
 * outcomes `resolveRequestedEffort()` in `./index.ts` already produces (503, unsupported, not in
 * enum) as data. That is what lets a broader `validateKiroPayload()` compose it later without
 * inheriting effort-specific policy (Requirement 6.5).
 */
export type EffortValidation =
  | { ok: true }
  | { ok: false; code: "effort_not_in_enum"; requested: string; levels: string[]; nearest: string }
  | { ok: false; code: "effort_unsupported"; requested: string }
  | { ok: false; code: "metadata_unavailable"; status: 503 }

/**
 * The descriptor argument {@link validateKiroEffort} accepts, with three states rather than two.
 *
 * - a {@link KiroModelEffortMetadata} — the model's enum, loaded.
 * - `undefined` — metadata is loaded and this model declares no effort enum. Exactly what
 *   `KiroModelMetadata.effort` reads as, so `registry.get(model)?.effort` passes straight through.
 * - `null` — metadata has **not** loaded, so the enum is unknown.
 *
 * `null` and `undefined` are deliberately not merged: "this model has no effort" and "we do not
 * know what this model has" produce a 400-class and a 503-class outcome respectively, and a
 * two-state input would force the caller to keep that distinction outside the classifier — which
 * is the distinction the classifier exists to make.
 */
export type KiroEffortDescriptor = KiroModelEffortMetadata | undefined | null

/**
 * Classify a requested effort level against one model's effort descriptor.
 *
 * Pure: a function of its two arguments only. It reads no registry, awaits nothing, and does not
 * decide what to *do* about a rejection — the status code, the notice and the strict-mode
 * escalation all stay in `./index.ts` (task 22.1). Requirements 6.1, 6.2, 6.3, 6.4, 6.5.
 *
 * Classification is delegated to {@link selectEffortLevel} rather than re-derived here. That
 * function already decides membership, and duplicating the check would create two places where
 * "in the enum" could drift apart. This function's own work is the mapping from decision to
 * classified result, plus {@link nearestEnumLevel}.
 *
 * A missing or empty `requested` is `{ ok: true }`: there is nothing to validate, and the caller's
 * `if (!requested) return {}` fast path stays valid. Notably that check comes *before* the
 * unloaded-metadata check, matching today's order — a request that states no effort never needs
 * metadata and so must never be delayed or 503'd by it.
 */
export function validateKiroEffort(metadata: KiroEffortDescriptor, requested: string | undefined): EffortValidation {
  if (normalizeRequested(requested) === undefined) return { ok: true }
  if (metadata === null) return { ok: false, code: "metadata_unavailable", status: 503 }

  const decision = selectEffortLevel(metadata, { requested })
  switch (decision.kind) {
    case "unsupported":
      return { ok: false, code: "effort_unsupported", requested: decision.requested }
    case "out_of_enum":
      return {
        ok: false,
        code: "effort_not_in_enum",
        requested: decision.requested,
        levels: decision.levels,
        nearest: nearestEnumLevel(decision.requested, decision.levels),
      }
    // `selected` is the in-enum case (Requirement 6.2). `absent` is unreachable for a non-empty
    // `requested` — the ladder's rung 1 always classifies a stated value — but it is a valid
    // "nothing to send", so it reads as valid rather than as an error.
    default:
      return { ok: true }
  }
}

/**
 * The ladder used to place level names relative to one another.
 *
 * Ordering knowledge, not vocabulary: it is **not** the set of levels any model accepts, and
 * nothing is ever sent because it appears here. It exists only so `"ultra"` can be understood as
 * *above* `"high"` when choosing a substitute. Levels a model publishes that are absent from this
 * list still work — they simply carry no rank, and the fallback below covers them.
 */
const KNOWN_LEVEL_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const

/**
 * The member of `levels` to send in place of an out-of-enum `requested`.
 *
 * **`nearest` is by definition a member of the model's own enum** — `levels` here is the descriptor's
 * own array, and every return path picks an element of it. That is what keeps Property 14 true
 * through the substitution path task 22.1 opens: degrading cannot put an invented level on the
 * wire.
 *
 * The rule, and why this one:
 *
 * 1. Both `requested` and a candidate ranked on {@link KNOWN_LEVEL_ORDER} — pick the candidate
 *    with the smallest rank distance. "Nearest" means nearest in reasoning intensity, which is the
 *    dimension the client was expressing; nearest by string similarity would be a coincidence.
 * 2. Ties break **upward** (`"medium"` requested against `["low", "high"]` yields `"high"`). A
 *    client naming a level asked for at least that much reasoning, so rounding up honours the
 *    request while rounding down quietly under-serves it. Cost is the tradeoff, and it is the
 *    lesser surprise.
 * 3. `requested` unranked (`"ultra"`, or any prose a client sends) — the highest-ranked candidate.
 *    An unplaceable name cannot be measured against the ladder, and the same round-up reasoning
 *    applies: a client reaching past the published vocabulary was reaching upward.
 * 4. No candidate ranked at all — the **last** element of `levels`. Kiro's
 *    `additionalModelRequestFieldsSchema` lists levels ascending, so the last entry is the
 *    model's strongest, keeping rule 2's direction even for a vocabulary this ladder has never
 *    seen. `levels` is non-empty for any descriptor `parseEffortMetadata()` produces, and the
 *    guard below makes the empty case explicit rather than `undefined`-by-accident.
 */
function nearestEnumLevel(requested: string, levels: readonly string[]): string {
  const rankOf = (level: string) => KNOWN_LEVEL_ORDER.indexOf(level as (typeof KNOWN_LEVEL_ORDER)[number])
  const ranked = levels.map((level) => ({ level, rank: rankOf(level) })).filter((candidate) => candidate.rank >= 0)

  // Rule 4 — nothing to compare against, so fall back on declaration order.
  if (!ranked.length) return levels[levels.length - 1] ?? requested

  const requestedRank = rankOf(requested)
  // Rule 3 — an unplaceable request rounds up to the strongest level this model knows.
  if (requestedRank < 0) return ranked.reduce((best, candidate) => (candidate.rank > best.rank ? candidate : best)).level

  // Rules 1 and 2 — closest by rank, ties upward.
  return ranked.reduce((best, candidate) => {
    const candidateDistance = Math.abs(candidate.rank - requestedRank)
    const bestDistance = Math.abs(best.rank - requestedRank)
    if (candidateDistance < bestDistance) return candidate
    if (candidateDistance === bestDistance && candidate.rank > best.rank) return candidate
    return best
  }).level
}

/**
 * Map a thinking token budget onto a level of this model's enum.
 *
 * Kiro's wire format has no budget field, so a `thinking.budgetTokens` the client sent can only
 * reach the model as a reasoning level. This is that translation, and the whole of it: the notice
 * that reports it belongs to `./index.ts`, and the precedence that decides whether this rung is
 * consulted at all belongs to {@link selectEffortLevel} (Requirement 16.8 — an explicit level
 * always wins, so a budget beside one is never mapped and reports nothing).
 *
 * The contract, unchanged from what the task-20 stub put on the record:
 *
 * - The mapping is over `REASONING_EFFORT_BUDGETS` in `./constants.ts`
 *   (low 4000 / medium 8000 / high 16000 / xhigh 32000).
 * - The result is the level whose budget is **nearest** the requested one, restricted to `levels`,
 *   so the enum-containment post-condition (Property 14) holds for a budget-derived level too.
 * - It is **monotone**: `a <= b` implies `REASONING_EFFORT_BUDGETS[budgetToLevel(a)] <=
 *   REASONING_EFFORT_BUDGETS[budgetToLevel(b)]` (Property 16). Nearest-neighbour selection over a
 *   fixed ordered set is monotone for any deterministic tie rule, which is why the rule below can
 *   be chosen on merit rather than to protect the ordering.
 * - Neither extreme throws: a budget under every entry lands on the lowest available level, and a
 *   budget over every entry on the highest. `budget_tokens: 1` is a real request, not an error.
 *
 * Two rules worth stating explicitly:
 *
 * 1. **Ties round up.** A budget exactly between two levels (6000, between low 4000 and medium
 *    8000) picks the higher. A budget is a statement about how much reasoning the client is
 *    willing to pay for, so spending it is closer to the request than withholding it — the same
 *    direction {@link nearestEnumLevel} takes, for the same reason.
 * 2. **A level with no budget entry is not a candidate.** `minimal` and `max` are real level names
 *    on the ladder and absent from `REASONING_EFFORT_BUDGETS`, so there is no budget at which they
 *    are "nearest" to anything; including them would mean inventing a token figure for them here,
 *    in a module whose whole discipline is not inventing values. A model whose enum contains *only*
 *    such names therefore makes this rung **decline** — `undefined`, so the ladder falls through to
 *    the model default exactly as it does for a request carrying no budget. `undefined` has always
 *    meant "this rung declines" and still never means "the lowest level".
 */
export function budgetToLevel(budgetTokens: number | undefined, levels: readonly string[]): string | undefined {
  // A budget must be a usable positive number to be mapped at all. Inbound already filters to
  // positive finite values (`src/inbound/claude/sampling.ts`), so this guard is a second line
  // rather than the only one — and it is what keeps `0`, `NaN` and a non-number from being read as
  // "the smallest budget" by the arithmetic below.
  if (typeof budgetTokens !== "number" || !Number.isFinite(budgetTokens) || budgetTokens <= 0) return undefined

  const candidates = levels
    .map((level) => ({ level, budget: REASONING_EFFORT_BUDGETS[level] }))
    .filter((candidate): candidate is { level: string; budget: number } => typeof candidate.budget === "number")
  if (!candidates.length) return undefined

  // Nearest by budget, ties upward. Both extremes are covered without a special case: a budget
  // below every entry is nearest the smallest, one above every entry nearest the largest.
  return candidates.reduce((best, candidate) => {
    const candidateDistance = Math.abs(candidate.budget - budgetTokens)
    const bestDistance = Math.abs(best.budget - budgetTokens)
    if (candidateDistance < bestDistance) return candidate
    if (candidateDistance === bestDistance && candidate.budget > best.budget) return candidate
    return best
  }).level
}

/** The base identifier and effort level recovered from a suffixed model identifier. */
export interface ModelEffortSuffix {
  /** The identifier with the effort suffix removed — what actually goes upstream as the model. */
  baseModel: string
  /**
   * The level to send.
   *
   * A member of `levels` whenever `levels` is non-empty, mirroring the enum-containment
   * post-condition {@link selectEffortLevel} holds to (Property 14): recognizing a suffix must not
   * become a way to put an invented level on the wire. When `levels` is empty the model publishes
   * no enum, there is nothing to draw from, and this echoes {@link requestedLevel} with
   * {@link degraded} set — "a suffix was recognized, and there is no level to send".
   */
  level: string
  /**
   * The level as literally written in the identifier.
   *
   * Equal to {@link level} in the ordinary case. It differs when the suffix was degraded, and also
   * for the one pre-existing normalization core performs (`gpt-5_ultra` sends `max`), which is a
   * rename rather than a degradation — hence a separate field rather than reusing `degraded` for
   * both.
   */
  requestedLevel: string
  /**
   * Whether {@link level} is a substitute because {@link requestedLevel} is absent from `levels`.
   *
   * Requirement 16.11 degrades rather than rejects, and a degradation is a `Feature_Notice`. This
   * flag is the whole of that signal: emitting the notice stays in `./features.ts` plus
   * `./feature-notices.ts`, exactly as it does for every other decision this module returns.
   */
  degraded: boolean
}

/**
 * The names that may be read as an effort suffix at all.
 *
 * Vocabulary, not ordering — {@link KNOWN_LEVEL_ORDER} above is the ordering, and this set adds the
 * two names core's pattern accepts that carry no rank (`none`, `ultra`).
 *
 * Its purpose is to keep suffix recognition from eating a model identifier that merely happens to
 * contain an underscore: a model called `foo_preview` must resolve to `foo_preview`, not to base
 * `foo` with effort `preview`. So an unrecognized suffix means "this identifier carries no effort
 * suffix" rather than "this identifier carries a bad one". A level a model publishes that is absent
 * from this set still works — it is matched against `levels` directly, before this set is
 * consulted.
 */
const EFFORT_SUFFIX_NAMES: readonly string[] = ["none", ...KNOWN_LEVEL_ORDER, "ultra"]

/**
 * Split a suffixed model identifier such as `claude-sonnet-5_high` into its base identifier and
 * its effort level, resolved against the model enum this layer owns.
 *
 * `undefined` means **this identifier carries no effort suffix** — send it upstream as it stands.
 * That is a real answer, not a failure: it is what `claude-sonnet-5` and `foo_preview` both
 * deserve, and it is why the function returns rather than throwing (Requirement 16.10).
 *
 * Where the work happens, and why here:
 *
 * - The **lexical** split is generic and stays in `src/core/reasoning.ts`
 *   ({@link splitModelSuffix}) — it names no family and consults no vocabulary.
 * - The **resolution** is this function's, because it needs `levels`, and the per-model level enum
 *   comes from Kiro's `additionalModelRequestFieldsSchema` (`./model-metadata.ts`). Requirement
 *   16.10 places it in the layer that owns the enum, and Requirement 16.12 keeps the core pattern
 *   from growing a second model-family name to do the same job.
 *
 * The three outcomes for an identifier that *does* carry a suffix:
 *
 * 1. **`gpt-5` and friends** — delegated to {@link parseReasoningModel}, so the base and level are
 *    the same values `normalizeReasoningBody()` produced before this feature, down to `ultra`
 *    reading as `max` and to `gpt-5_bogus` being unrecognized (Requirement 16.11). Delegation
 *    rather than a re-spelled regex: a copy could drift, and "the same as before" is a claim only
 *    the original can guarantee. Notably the enum is **not** consulted on this path — that would be
 *    a behavior change, and this path is defined as unchanged.
 * 2. **A suffix in `levels`** — returned exactly, which is the round-trip half of Property 17.
 * 3. **A suffix that is a level name but not one this model publishes** — degraded to
 *    {@link nearestEnumLevel} with `degraded: true` for the caller's notice, rather than rejected
 *    (Requirement 16.11). `none` is the one name the ladder cannot place and must not round up:
 *    it asks for less reasoning, so it degrades to the model's weakest level.
 *
 * Pure, like the rest of this module: no notice is emitted here and no payload written. This
 * function currently has **no production caller** — wiring it into `./index.ts` is separate work.
 */
export function parseModelEffortSuffix(model: string, levels: readonly string[]): ModelEffortSuffix | undefined {
  const { base, suffix } = splitModelSuffix(model)
  if (suffix === undefined) return undefined

  // Outcome 1 — the identifiers core already recognizes keep resolving through core.
  const core = parseReasoningModel(model)
  if (core) return { baseModel: core.base, level: core.effort, requestedLevel: suffix, degraded: false }

  // Outcome 2 — a level this model publishes, whatever it is named.
  if (levels.includes(suffix)) return { baseModel: base, level: suffix, requestedLevel: suffix, degraded: false }

  // Not a level name at all: the underscore belongs to the model identifier.
  if (!EFFORT_SUFFIX_NAMES.includes(suffix)) return undefined

  // Outcome 3 — a recognizable level this model does not accept.
  if (!levels.length) return { baseModel: base, level: suffix, requestedLevel: suffix, degraded: true }
  const substitute = suffix === "none" ? lowestEnumLevel(levels) : nearestEnumLevel(suffix, levels)
  return { baseModel: base, level: substitute, requestedLevel: suffix, degraded: true }
}

/**
 * The weakest member of `levels`, used only as the substitute for a `none` suffix.
 *
 * A separate helper rather than a fourth rule inside {@link nearestEnumLevel}, because it goes the
 * other way: that function rounds *up* on purpose, and `none` is the one request where rounding up
 * inverts what was asked. Falls back on the first declared level for a vocabulary the ladder does
 * not rank, matching the ascending order Kiro's schema publishes.
 */
function lowestEnumLevel(levels: readonly string[]): string {
  const rankOf = (level: string) => KNOWN_LEVEL_ORDER.indexOf(level as (typeof KNOWN_LEVEL_ORDER)[number])
  const ranked = levels.map((level) => ({ level, rank: rankOf(level) })).filter((candidate) => candidate.rank >= 0)
  if (!ranked.length) return levels[0]!
  return ranked.reduce((best, candidate) => (candidate.rank < best.rank ? candidate : best)).level
}

/**
 * Whether the client asked for anything this upstream would settle as a `thinkingBudget` outcome.
 *
 * Exactly the two client-supplied intents that can produce one: a stated level, which may fall
 * outside the model's enum or land on a model that publishes none, and a token budget, which has no
 * wire field here and is therefore mapped onto a level. Both are read through the same normalization
 * the resolver applies — an empty `reasoningEffort` is not a stated value, and a budget beside
 * `thinking.mode: "disabled"` is not consulted (Requirement 16.9).
 *
 * The model's own published default is deliberately **not** an intent: it fills a silence rather
 * than changing anything the client asked for, so it produces no notice and there is nothing for a
 * caller to report. That is what makes this predicate usable as a "is there a decision pending"
 * question rather than as "would effort be sent".
 */
export function requestStatesEffortIntent(request: Pick<Canonical_Request, "reasoningEffort" | "thinking">): boolean {
  if (normalizeRequested(request.reasoningEffort) !== undefined) return true
  if (request.thinking?.mode === "disabled") return false
  return typeof request.thinking?.budgetTokens === "number"
}

/** Narrow a `Canonical_Request` to the effort intent it carries. */
export function effortIntentFromRequest(request: Pick<Canonical_Request, "reasoningEffort" | "thinking">): EffortIntent {
  return {
    ...(request.reasoningEffort !== undefined ? { requested: request.reasoningEffort } : {}),
    ...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
  }
}

/**
 * An empty `reasoningEffort` is not a stated value.
 *
 * Exactly the falsy reading the existing `resolveRequestedEffort()` in `./index.ts` already
 * applies, so an inbound provider that maps a missing field to `""` keeps producing silence rather
 * than a rejection. Deliberately **not** trimmed: `" high"` is not a level any model's enum
 * contains, and treating it as one would be this module inventing a value the client did not send.
 */
function normalizeRequested(requested: string | undefined): string | undefined {
  return typeof requested === "string" && requested.length ? requested : undefined
}

function selected(source: EffortSource, schemaPath: KiroModelEffortMetadata["schemaPath"], level: string): EffortDecision {
  return { kind: "selected", source, effort: { schemaPath, level } }
}
