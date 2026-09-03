import type { Canonical_Request } from "../../core/canonical"
import type { JsonObject } from "../../core/types"

/**
 * The canonical members an OpenAI-shaped wire body can populate (Requirement 13.4).
 *
 * A `Pick` of the canonical request rather than a fresh interface, so the mapper cannot drift from
 * the contract it feeds: renaming a sub-member in `src/core/canonical.ts` fails to compile here.
 *
 * `thinking` and `cacheHint` are absent from this type on purpose. The OpenAI wire has no field
 * this subtask maps to either of them, and widening the return type would invite a caller to
 * believe the mapper decided they were absent when in fact it never looked.
 */
export type OpenAISamplingMembers = Pick<Canonical_Request, "sampling" | "parallelToolCalls">

/**
 * Map the generation controls of an OpenAI-shaped body onto their canonical members.
 *
 * Returns a **partial** canonical request meant to be spread: every member is omitted entirely
 * when the body carries no source field for it, and no sub-member ever holds `undefined`
 * (Requirement 13.5). That is load-bearing rather than tidy — upstream feature resolvers key their
 * `sampling` / `outputLength` / `stopSequences` decisions off *presence*
 * (`typeof sampling.temperature === "number"` in each upstream's `features.ts`), so an object of
 * `undefined` sub-members would make those cells fire for a request that expressed no intent.
 *
 * Only finite numbers count as present. JSON has no `NaN` or `Infinity` spelling, so a body
 * carrying one of them cannot be forwarded to any upstream wire as a number; treating it as absent
 * keeps a value that no upstream could transmit from reading downstream as client intent.
 */
export function openAISamplingMembers(body: JsonObject): OpenAISamplingMembers {
  const sampling: NonNullable<Canonical_Request["sampling"]> = {}

  const maxOutputTokens = firstFiniteNumber(body, MAX_OUTPUT_TOKENS_FIELDS)
  if (maxOutputTokens !== undefined) sampling.maxOutputTokens = maxOutputTokens

  const temperature = finiteNumber(body.temperature)
  if (temperature !== undefined) sampling.temperature = temperature

  const topP = finiteNumber(body.top_p)
  if (topP !== undefined) sampling.topP = topP

  const stopSequences = normalizeStopSequences(body.stop)
  if (stopSequences) sampling.stopSequences = stopSequences

  return {
    ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
    // Positive on this wire — `parallel_tool_calls: false` means the client asked for one call at a
    // time — so there is nothing to invert, unlike Claude's `disable_parallel_tool_use`. Tri-state
    // is preserved by only reading an actual boolean: `undefined` stays "no preference expressed",
    // which is a different answer from an explicit `true`.
    ...(typeof body.parallel_tool_calls === "boolean" ? { parallelToolCalls: body.parallel_tool_calls } : {}),
  }
}

/**
 * The three wire spellings of one canonical member, in precedence order.
 *
 * `max_output_tokens` first because it is the Responses API's own field and the only one of the
 * three that route defines — a client that sent it named the limit in the vocabulary of the
 * endpoint it called. `max_completion_tokens` next: it is the current chat-completions spelling,
 * and OpenAI deprecated `max_tokens` in its favour. `max_tokens` last, as the legacy spelling a
 * client is most likely to be sending out of habit or from an older SDK.
 *
 * Order matters only for a body carrying more than one, which is already self-contradictory; the
 * point is that the resolution is *stated* rather than falling out of member order in a literal.
 * Every route reads all three: `normalize.ts` branches per route for input and tool shape, but a
 * client mixing spellings is common enough — chat SDKs pointed at `/v1/responses` and vice versa —
 * that refusing to read a spelling because of the path would silently drop the client's limit.
 */
const MAX_OUTPUT_TOKENS_FIELDS = ["max_output_tokens", "max_completion_tokens", "max_tokens"] as const

function firstFiniteNumber(body: JsonObject, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const value = finiteNumber(body[field])
    if (value !== undefined) return value
  }
  return undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * `stop` is a bare string or an array of strings on this wire; canonical carries an array.
 *
 * Empty entries are dropped, and an input that yields no entry at all yields no member: the
 * upstream resolvers already filter with `typeof entry === "string" && entry.length > 0`, so
 * `stop: ""` and `stop: []` carry no sequence any upstream would act on. Reporting them as a
 * present-but-useless `stopSequences` would make a `degrade` or `reject` cell fire over nothing.
 */
function normalizeStopSequences(value: unknown): string[] | undefined {
  const entries = typeof value === "string" ? [value] : Array.isArray(value) ? value : []
  const stopSequences = entries.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  return stopSequences.length > 0 ? stopSequences : undefined
}
