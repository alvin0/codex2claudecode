/**
 * Claude wire → canonical mapping for the four members the contract task added:
 * `sampling`, `thinking`, `cacheHint`, and `parallelToolCalls`.
 *
 * Its own file rather than four more branches inside `./convert.ts`, which already owns one
 * responsibility — turning Claude messages and content blocks into canonical input items. The
 * two jobs change for unrelated reasons: this one changes when Anthropic adds a generation
 * control, that one changes when Anthropic adds a content block type.
 *
 * The rule every function here obeys: **a member is absent unless the request carried at least
 * one source field for it, and no present sub-member holds `undefined`** (Requirement 13.5).
 * That is load-bearing rather than cosmetic. Upstream feature resolvers key their decisions off
 * presence — `resolveKiroFeatures()` (`src/upstream/kiro/features.ts`) asks
 * `typeof sampling.temperature === "number"` and `Array.isArray(cacheHint) && cacheHint.length > 0`
 * — so an object of `undefined` sub-members, or an empty `cacheHint` array, would make a policy
 * fire for a request that expressed no intent at all. Every member below is therefore built with
 * a conditional spread, never with an assignment that can land `undefined`.
 */

import type { Canonical_Request } from "../../core/canonical"
import type { ClaudeMessagesRequest } from "../types"

/**
 * The canonical members this mapper is allowed to produce, derived from
 * {@link Canonical_Request} by {@link Pick} rather than restated.
 *
 * Derived, so a rename or a widened sub-member in core is a type error here instead of a silent
 * divergence. Every key stays optional, which is what makes the result safe to spread into a
 * canonical request: absent keys add nothing.
 */
export type ClaudeSamplingMembers = Pick<
  Canonical_Request,
  "sampling" | "thinking" | "cacheHint" | "parallelToolCalls"
>

type CanonicalSampling = NonNullable<Canonical_Request["sampling"]>
type CanonicalThinking = NonNullable<Canonical_Request["thinking"]>
type CanonicalCacheHint = NonNullable<Canonical_Request["cacheHint"]>[number]

/**
 * The three scopes a cache hint may name, taken from the canonical type.
 *
 * Derived rather than re-typed because this union is the whole point of the narrowing below: it
 * must stay exactly what core accepts, and a fourth scope appearing in core should surface here
 * as an unhandled case rather than as a value this file happens not to produce.
 */
type CanonicalCacheScope = CanonicalCacheHint["scope"]

/**
 * The thinking modes canonical accepts, as a runtime-checkable list.
 *
 * Canonical `thinking.mode` and Claude's `thinking.type` share the same three-word vocabulary
 * (`enabled`, `disabled`, `adaptive`), so the mapping is identity **once the wire value has been
 * narrowed**. It still needs a guard: `ClaudeMessagesRequest.thinking` is a union with
 * `JsonObject`, so `type` arrives as `unknown` as far as the compiler is concerned, and the body
 * itself came off the network.
 */
const CANONICAL_THINKING_MODES: readonly CanonicalThinking["mode"][] = ["enabled", "disabled", "adaptive"]

/**
 * Map every generation control, thinking request, cache marker, and parallel-tool preference a
 * Claude Messages request can carry into its canonical member.
 *
 * Returns a partial canonical request for `./convert.ts` to spread (task 14.2). Nothing here
 * reads or writes anything outside `body`, so it is a pure function of the wire body and can be
 * tested without a gateway.
 */
export function claudeSamplingMembers(body: ClaudeMessagesRequest): ClaudeSamplingMembers {
  const sampling = claudeSampling(body)
  const thinking = claudeThinking(body.thinking)
  const cacheHint = claudeCacheHints(body)
  const parallelToolCalls = claudeParallelToolCalls(body)

  return {
    ...(sampling && { sampling }),
    ...(thinking && { thinking }),
    ...(cacheHint.length > 0 && { cacheHint }),
    ...(parallelToolCalls !== undefined && { parallelToolCalls }),
  }
}

/**
 * `max_tokens` / `temperature` / `top_p` / `stop_sequences` → `sampling`.
 *
 * Built as an object literal of conditional spreads and then dropped whole when it came out
 * empty, so there is no path on which `sampling` exists carrying four `undefined` values.
 *
 * `temperature: 0` and `top_p: 0` are meaningful values a client can send, so presence is tested
 * with {@link Number.isFinite} on the value rather than with truthiness — the bug that would make
 * "be fully deterministic" read as "expressed no preference".
 */
function claudeSampling(body: ClaudeMessagesRequest): CanonicalSampling | undefined {
  const maxOutputTokens = finiteNumber(body.max_tokens)
  const temperature = finiteNumber(body.temperature)
  const topP = finiteNumber(body.top_p)
  const stopSequences = stopSequenceList(body.stop_sequences)

  const sampling: CanonicalSampling = {
    ...(maxOutputTokens !== undefined && { maxOutputTokens }),
    ...(temperature !== undefined && { temperature }),
    ...(topP !== undefined && { topP }),
    ...(stopSequences && { stopSequences }),
  }

  return Object.keys(sampling).length > 0 ? sampling : undefined
}

/**
 * `thinking.type` → `thinking.mode`, `thinking.budget_tokens` → `thinking.budgetTokens`.
 *
 * `mode` is required in canonical, and the wire supplies `type`, so this function has to decide
 * what an absent or unrecognized `type` means. Three outcomes, in order:
 *
 * 1. **A recognized `type`** — `enabled`, `disabled`, or `adaptive` — becomes `mode` unchanged.
 *    The two vocabularies coincide, so no translation table is warranted; the guard is what
 *    turns a network string into that union without a cast.
 * 2. **No recognized `type`, but a usable `budget_tokens`** — `mode: "enabled"`. A token budget
 *    is only meaningful when thinking runs, so a client that named one asked for thinking whether
 *    or not it also spelled the type. Discarding it would throw away the single piece of intent
 *    the object carried, and `thinkingBudget` is exactly the feature Kiro declares `degrade`:
 *    the notice that tells the client its budget became an effort level needs the budget to exist
 *    in canonical to be written at all.
 * 3. **Neither** — the member is omitted. `thinking: {}`, `thinking: { type: "turbo" }`, and a
 *    `thinking` that is not an object all land here. Inventing a mode for them would be worse
 *    than dropping them: a present `thinking` member is read downstream as "the client made a
 *    choice", and guessing which choice would attribute a decision to a client that never made
 *    one. An unrecognized type is a request this gateway does not understand, and the honest
 *    canonical representation of that is silence.
 *
 * `budgetTokens` is carried whenever it is a positive finite number, including alongside
 * `mode: "disabled"`. Inbound reports what arrived; reconciling a contradictory pair is a policy
 * question, and policy belongs to the upstream that owns the model.
 */
function claudeThinking(thinking: ClaudeMessagesRequest["thinking"]): CanonicalThinking | undefined {
  if (!isRecord(thinking)) return

  const budgetTokens = positiveNumber(thinking.budget_tokens)
  const mode = isCanonicalThinkingMode(thinking.type) ? thinking.type : budgetTokens !== undefined ? "enabled" : undefined
  if (!mode) return

  return { mode, ...(budgetTokens !== undefined && { budgetTokens }) }
}

/**
 * `cache_control` markers → `cacheHint`, with the scope derived from **where** the marker was
 * found rather than from anything the client wrote.
 *
 * Claude has no request-level cache field. `cache_control` appears on individual blocks — system
 * blocks, tool definitions, message content blocks — and canonical narrows `scope` to three
 * values. There is no wire string to narrow, which is why {@link collectCacheHints} takes the
 * scope as a {@link CanonicalCacheScope} parameter and each call site below passes a literal: the
 * literal is checked against the canonical union by the compiler at the call, so the narrowing is
 * a real type check rather than an `as` that would silence one. A marker in a location this
 * function does not classify produces no entry, instead of an invented scope.
 *
 * Order is tools → system → history, the order the marked segments occupy in the prompt prefix
 * Anthropic caches. Key order in a decoded JSON body is not a fact about what the client wrote,
 * so prompt order is the only stable order available; within a location, entries keep their array
 * order.
 *
 * Returns a plain array. {@link claudeSamplingMembers} is what drops it when empty, so the
 * "omitted rather than empty" rule lives in exactly one place.
 */
function claudeCacheHints(body: ClaudeMessagesRequest): CanonicalCacheHint[] {
  return [
    ...collectCacheHints(body.tools, "tools"),
    ...collectCacheHints(body.system, "system"),
    ...(body.messages ?? []).flatMap((message) => collectCacheHints(message?.content, "history")),
  ]
}

function collectCacheHints(blocks: unknown, scope: CanonicalCacheScope): CanonicalCacheHint[] {
  if (!Array.isArray(blocks)) return []

  return blocks.flatMap((block): CanonicalCacheHint[] => {
    const marker = cacheControlMarker(block)
    if (!marker) return []
    const ttl = nonEmptyString(marker.ttl)
    return [{ scope, ...(ttl !== undefined && { ttl }) }]
  })
}

/**
 * The `cache_control` object on one block, or nothing.
 *
 * Any object counts as a marker, including `{}`: the client wrote `cache_control` on that block,
 * and the presence of the marker is the hint. Only its `ttl` is read, and only as a string —
 * `ttl` is a client-supplied duration token (`"5m"`, `"1h"`), not a quantity this layer is
 * entitled to parse into a number and hand on as if it had understood it.
 */
function cacheControlMarker(block: unknown): Record<string, unknown> | undefined {
  if (!isRecord(block)) return
  const marker = block.cache_control
  return isRecord(marker) ? marker : undefined
}

/**
 * `disable_parallel_tool_use` → `parallelToolCalls`, inverted.
 *
 * The inversion happens here, at the inbound boundary, so core can state the preference
 * positively; the negative spelling is Anthropic's, not the canonical contract's.
 *
 * Tri-state, deliberately. An absent wire field returns `undefined` and the member is omitted,
 * which lets the upstream default stand — a different answer from an explicit `true`. A present
 * `tool_choice.disable_parallel_tool_use` is inverted as a boolean in both directions: `true`
 * becomes `false` (Requirement 13.3), and an explicit `false` becomes `true`, because the client
 * did express a preference even though it matches the usual default.
 *
 * A `mcp_toolset` entry carries the same field per toolset. It is read only in the narrowing
 * direction: any toolset disabling parallel use yields `false`, and no toolset can yield `true`.
 * A per-toolset permission is not a request-level one, so it must not be widened into the
 * request-level member; a per-toolset prohibition, on the other hand, is intent this member can
 * report without overstating it. The request-level field wins whenever it is present.
 */
function claudeParallelToolCalls(body: ClaudeMessagesRequest): boolean | undefined {
  const toolChoice = body.tool_choice?.disable_parallel_tool_use
  if (typeof toolChoice === "boolean") return !toolChoice

  const disabledByToolset = (body.tools ?? []).some((tool) => tool.disable_parallel_tool_use === true)
  return disabledByToolset ? false : undefined
}

function isCanonicalThinkingMode(value: unknown): value is CanonicalThinking["mode"] {
  return typeof value === "string" && CANONICAL_THINKING_MODES.some((mode) => mode === value)
}

/**
 * Whether a decoded JSON value is a keyed object.
 *
 * A type guard rather than an `as` at each site: the check and the narrowing stay in one place, so
 * every caller below reads properties off a value the compiler agrees is keyed instead of one it
 * was told to trust.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function positiveNumber(value: unknown): number | undefined {
  const numeric = finiteNumber(value)
  return numeric !== undefined && numeric > 0 ? numeric : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

/**
 * The stop sequences worth carrying, or nothing.
 *
 * Non-string entries and empty strings are dropped, and an array that leaves nothing behind
 * returns `undefined` so the sub-member is omitted rather than present-and-empty. An empty stop
 * sequence would stop generation nowhere, and `requestedStopSequences()`
 * (`src/upstream/kiro/features.ts`) already discards it — filtering here keeps presence in
 * canonical equal to presence of intent, which is what the `stopSequences` policy reads.
 */
function stopSequenceList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return
  const sequences = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  return sequences.length > 0 ? sequences : undefined
}
