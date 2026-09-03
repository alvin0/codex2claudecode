/**
 * The Responses spelling of each canonical `sampling` control, and the denylist of field names
 * this endpoint refuses.
 *
 * Its own file rather than three more spread expressions inside `./parse.ts`, which already owns
 * one job — turning a canonical request into the Responses envelope (`input`, `tools`,
 * `instructions`, `store`, `stream`). This one changes when the Responses parameter list changes;
 * that one changes when the canonical conversation shape changes.
 *
 * ## The measurement this module now records, and what it removed
 *
 * `.omc/research/kiro-wire-spike.md` §11.2 sent each of the three sampling parameters to
 * `POST /backend-api/codex/responses` one per run, on the model the live cases use:
 *
 * | field sent | status | body |
 * | --- | --- | --- |
 * | none (control) | 200 | `response.completed` |
 * | `temperature: 0.2` | 400 | `{"detail":"Unsupported parameter: temperature"}` |
 * | `top_p: 0.9` | 400 | `{"detail":"Unsupported parameter: top_p"}` |
 * | `max_output_tokens: 16` | 400 | `{"detail":"Unsupported parameter: max_output_tokens"}` |
 *
 * All three refused, on two different models (§11.4), and refused rather than accepted-and-ignored
 * — §11.3 records the endpoint echoing all three names inside `response.created` while rejecting
 * all three as request parameters. An earlier version of this docstring asserted that
 * `max_output_tokens` **is** the correct Responses spelling and would therefore be honoured here.
 * That sentence is withdrawn: it was wire-format reasoning about the documented OpenAI Responses
 * API, and this endpoint is measurably not that API. `max_output_tokens` is the spelling the
 * Responses *documentation* gives, and it is also a name this endpoint answers 400 to. Both facts
 * are true and only the second one governs what may reach the wire.
 *
 * ## The design decision: this module no longer emits, it only refuses (§11.7 item 2)
 *
 * With all three names refused, {@link CODEX_SAMPLING_RESPONSES_FIELDS} — the complete set of
 * spellings a canonical sampling control could be emitted under — is a **subset of**
 * {@link RESPONSES_REJECTED_FIELDS}. There is no emittable field left, so the canonical → wire
 * emit function that used to live here has been removed rather than kept as a function whose every
 * output is deleted one line later. `sampling` on this upstream is drop-and-notice in full.
 *
 * The layering is unchanged, which is why the module stays:
 *
 * - **This module owns spelling.** It states which wire name each canonical control would take
 *   ({@link CODEX_SAMPLING_RESPONSES_FIELDS}) and which names must never reach the wire
 *   ({@link RESPONSES_REJECTED_FIELDS}), and it enforces the second through
 *   {@link omitResponsesRejectedFields}. The two lists overlapping completely is the drop; it is
 *   recorded as a relation between two named lists rather than as absent code, so the day the
 *   endpoint accepts one of them, removing that name from the denylist is the whole change.
 * - **`./features.ts` owns the notice.** The `sampling` and `outputLength` cells of
 *   `./capabilities.ts` are `degrade` (§11.5), and the resolver turns those declarations into
 *   exactly one Feature_Notice each. Nothing here reads a policy, emits a notice, or looks at the
 *   environment — dropping without the notice would be precisely the silent drop Requirement 10
 *   forbids, and it is not this module's job to prevent that alone.
 *
 * ## What this module still does not decide
 *
 * - **Whether the values are sensible.** Range checking belongs to the endpoint that owns the
 *   range, and the inbound mappers already drop non-numeric and non-finite values
 *   (`src/inbound/claude/sampling.ts`) so canonical carries what a client actually asked for.
 * - **`reasoning_effort`.** It is a rejected parameter on this endpoint by measurement (§10.2), and
 *   it is deliberately **absent** from the denylist below. `canonicalToCodexBody()` no longer emits
 *   the flat spelling at all — task 19b.1 moved it to the nested `reasoning: { effort, summary }`
 *   §10.4 measured as honoured — so there is nothing left here to deny, and the name stays off the
 *   list rather than being added to it for symmetry. `normalizeReasoningBody()`
 *   (`src/core/reasoning.ts`) still deletes the flat key inside `CodexStandaloneClient.request()`
 *   and still re-emits a nested object for a model matching its `gpt-5` regex; adding
 *   `reasoning_effort` here would run the filter over a body that never carries it while risking
 *   the regex path's working behavior. This denylist covers the sampling domain only.
 */

import type { JsonObject } from "../../core/types"

/**
 * The wire name each canonical `sampling` control would take on a Responses endpoint.
 *
 * Kept even though none of them may be emitted here, because it is the spelling knowledge this
 * module owns, and because it is what makes the drop checkable: an anchor test asserts every
 * member of this list is also on {@link RESPONSES_REJECTED_FIELDS}, which is the statement "no
 * canonical sampling control has an emittable target on this upstream" written as a relation
 * instead of as missing code.
 *
 * `stopSequences` is absent: the Responses API has no stop parameter under any spelling, so there
 * is no name to record for it. That is why its cell is `degrade` on absence-of-field grounds while
 * the other three are `degrade` on a measured 400.
 */
export const CODEX_SAMPLING_RESPONSES_FIELDS = ["max_output_tokens", "temperature", "top_p"] as const

export type CodexSamplingResponsesField = (typeof CODEX_SAMPLING_RESPONSES_FIELDS)[number]

/**
 * Top-level field names the Responses API refuses, recorded rather than inferred.
 *
 * This is the "recorded Responses-rejected field list" the design gives this module: the body
 * `canonicalToCodexBody()` produces is filtered against it, and Property 21 asserts the body's key
 * set is disjoint from it. Two kinds of entry, and the distinction matters when reading a failure:
 *
 * **Measured — a 400 with this exact name in the body (spike §11.2):**
 *
 * - `temperature` — `400 {"detail":"Unsupported parameter: temperature"}`, on `gpt-5.4-mini` and
 *   again on `gpt-5.5`, so the refusal is endpoint-level rather than model-level (§11.4).
 * - `top_p` — `400 {"detail":"Unsupported parameter: top_p"}`. New in §11.2; Run_Record 16 had
 *   only reached the first offender of each case and so named two fields where there are three.
 * - `max_output_tokens` — `400 {"detail":"Unsupported parameter: max_output_tokens"}`. The
 *   Responses documentation's own spelling of an output limit, and refused here all the same. This
 *   is the entry that contradicts what this module used to claim.
 *
 * **Inferred — a plausible spelling with no counterpart on this endpoint:**
 *
 * - `max_tokens`, `max_completion_tokens` — chat-completions spellings of an output limit. Neither
 *   has ever been sent to this endpoint; they are on the list because a translation layer reaches
 *   for them and, with `max_output_tokens` measured as refused, there is no output-limit name left
 *   that could be right.
 * - `stop`, `stop_sequences` — chat-completions and Claude spellings of a stop list. Responses has
 *   no stop-sequence parameter at all, which is why `stopSequences` is `degrade` in
 *   `./capabilities.ts`.
 * - `top_k` — an Anthropic sampling control with no Responses counterpart.
 *
 * Membership is by name, not by value: a name on this list is never emitted, whatever the client
 * sent. Kept as a `readonly` tuple of literals so the type and the runtime list cannot drift, and
 * kept in this provider directory rather than in `src/core/` because it describes one upstream's
 * wire protocol.
 */
export const RESPONSES_REJECTED_FIELDS = [
  "max_output_tokens",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "stop_sequences",
  "top_k",
] as const

export type ResponsesRejectedField = (typeof RESPONSES_REJECTED_FIELDS)[number]

const REJECTED_FIELD_SET: ReadonlySet<string> = new Set<string>(RESPONSES_REJECTED_FIELDS)

/**
 * Drop every top-level field on {@link RESPONSES_REJECTED_FIELDS} from a finished Responses body.
 *
 * Top-level only, deliberately. The denylist is a statement about request *parameters*, and the
 * nested values of `input`, `tools`, and `text` are client payload this gateway forwards verbatim —
 * a tool named `stop` or a message mentioning `max_tokens` is not a rejected parameter, and
 * rewriting either would corrupt the request to protect it from nothing.
 *
 * Returns a new object and leaves key order of the surviving fields intact, so the emitted body
 * stays byte-stable for a request that carries no rejected field — which is every request the
 * current builder produces.
 */
export function omitResponsesRejectedFields(body: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !REJECTED_FIELD_SET.has(key)))
}
