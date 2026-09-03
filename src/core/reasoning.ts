import type { JsonObject } from "./types"

/**
 * Reasoning normalization for the inbound request body.
 *
 * Two things live here and they are deliberately different in kind:
 *
 *  - {@link splitModelSuffix} is **generic**. It knows no model family and no level vocabulary; it
 *    performs one lexical operation on an identifier. Requirement 16.12 keeps `src/core/` free of
 *    additional model-family names, and a purely lexical split is the largest piece of suffix
 *    handling that can honestly sit in core.
 *  - {@link REASONING_MODEL_PATTERN} and {@link parseReasoningModel} are the **pre-existing**
 *    normalization, unchanged. The pattern text is byte-for-byte what it was before
 *    native-api-mode: Requirement 16.11 pins its behavior, and Requirement 16.12 forbids widening
 *    it with further model-family names. Recognizing a level for a *new* model family is the
 *    upstream layer's job, because that is where the per-model level enum lives
 *    (`src/upstream/kiro/effort.ts`, Requirement 16.10).
 *
 * So: nothing is added to the pattern, ever. A new family gets handled upstream.
 */

export function normalizeReasoningBody(body: JsonObject): JsonObject {
  return {
    ...Object.fromEntries(Object.entries(body).filter((entry) => entry[0] !== "reasoning_effort")),
    ...normalizeReasoningModel(body),
  }
}

/**
 * The only identifier shape this module has ever recognized, extracted to a constant so the one
 * model-family name in `src/core/` is written exactly once and is trivially greppable.
 *
 * **Do not add alternatives to this pattern.** Requirement 16.12 is asserted by
 * `test/architecture.property.test.ts` (Property 2), which counts model-family tokens under
 * `src/core/` against a pinned baseline.
 */
const REASONING_MODEL_PATTERN = /^(gpt-5(?:\.[^_]+)?)(?:_(none|low|medium|high|xhigh|max|ultra))?$/

/** The base identifier and effort level recognized by {@link REASONING_MODEL_PATTERN}. */
export interface ReasoningModel {
  /** The identifier with any effort suffix removed. */
  base: string
  /** The effort level, already normalized (`ultra` reads as `max`); `medium` when no suffix. */
  effort: string
}

/**
 * Resolve an identifier this module recognizes into its base and its effort level.
 *
 * Exported so the upstream layer can reuse it instead of restating the pattern: an upstream copy
 * would be a second place where "the level a recognized identifier carries" could drift, and
 * Requirement 16.11 asks for *the same* base and level as before this feature, not a lookalike.
 * Returns `undefined` for every identifier the pattern does not recognize — which is most of them,
 * and which is exactly the signal an upstream caller needs to fall back on its own model enum.
 */
export function parseReasoningModel(model: string): ReasoningModel | undefined {
  const match = model.match(REASONING_MODEL_PATTERN)
  if (!match) return undefined
  const [, base, effort = "medium"] = match
  return { base, effort: normalizeReasoningEffort(effort) as string }
}

/**
 * Split an identifier on its **last** underscore.
 *
 * Purely lexical, and provider-agnostic in the strict sense: it names no model family, consults no
 * level vocabulary, and makes no claim that `suffix` *is* an effort level. Deciding that is the
 * caller's, because only the layer holding the model enum can know (Requirement 16.10).
 *
 * The last underscore rather than the first, because a base identifier may legitimately contain
 * one — `a_b_high` has base `a_b`. `suffix` is absent when there is no underscore, and also when
 * either side of it would be empty: `_high` and `foo_` carry no base/suffix pair worth reporting,
 * and returning one would invite a caller to route a request at the empty-string model.
 */
export function splitModelSuffix(model: string): { base: string; suffix?: string } {
  const cut = model.lastIndexOf("_")
  if (cut <= 0 || cut === model.length - 1) return { base: model }
  return { base: model.slice(0, cut), suffix: model.slice(cut + 1) }
}

function normalizeReasoningModel(body: JsonObject): JsonObject {
  if (typeof body.model !== "string") return {}

  const parsed = parseReasoningModel(body.model)
  if (!parsed) return {}

  const reasoning = body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning) ? body.reasoning : {}

  return {
    model: parsed.base,
    reasoning: {
      ...reasoning,
      effort: normalizeReasoningEffort((reasoning as JsonObject).effort ?? body.reasoning_effort ?? parsed.effort),
    },
  }
}

function normalizeReasoningEffort(effort: unknown) {
  return effort === "ultra" ? "max" : effort
}
