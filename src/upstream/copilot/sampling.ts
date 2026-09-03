import type { Canonical_Request } from "../../core/canonical"
import type { JsonObject } from "../../core/types"

/**
 * Canonical `sampling` → GitHub Copilot wire fields.
 *
 * ## Why the Responses spellings and not the chat-completions ones
 *
 * `Copilot_Client.proxy()` (`./client.ts`) posts to `/responses`, and
 * `buildCopilotResponsesBody()` (`./parse.ts`) builds an OpenAI **Responses** body. So the
 * spellings here are `max_output_tokens`, `temperature`, and `top_p`. Requirement 14.4 words the
 * cell as "chat-completions fields", but the code says otherwise — see the wire-format correction
 * in `./capabilities.ts` — and the chat-completions spelling `max_tokens` would arrive at a
 * Responses endpoint as an unknown parameter, which is a latent 400 rather than a harmless no-op.
 *
 * ## What is dropped, and why that is not this file's decision to make
 *
 * `stopSequences` has no Responses field: the API takes no `stop` parameter, which is exactly why
 * `COPILOT_CAPABILITIES.features.stopSequences` is `degrade` rather than `native`. This mapper
 * therefore emits nothing for it and {@link COPILOT_SAMPLING_DROPPED_FIELDS} records the omission
 * in a form a test can read. Telling the client is a separate job, already done:
 * `resolveCopilotFeatures()` (`./features.ts`) resolves the `stopSequences` cell whenever the
 * request carries one, and the notice travels with the result. Nothing is silently lost.
 *
 * ## Values are forwarded as sent
 *
 * No clamping, no range check, no dropping of the non-finite numbers a client can put on the wire.
 * The canonical contract types these as `number`, `./features.ts` reports them as "passed on as
 * sent", and re-interpreting a client-supplied generation control is not a translation — it is a
 * policy this cell does not declare. A value out of the endpoint's accepted range comes back as
 * the upstream's own error, which is the honest outcome for a `native` cell.
 */

/** The Responses field names this mapper can emit, in body order. */
export const COPILOT_SAMPLING_RESPONSES_FIELDS = ["max_output_tokens", "temperature", "top_p"] as const

/**
 * The canonical sub-members with no Responses target, so they never reach the body.
 *
 * `stopSequences` is the whole list: the Responses API has no `stop` field. Exported so the
 * divergence test can assert the omission against a recorded list instead of restating it.
 */
export const COPILOT_SAMPLING_DROPPED_FIELDS = ["stopSequences"] as const

/**
 * The sampling fragment of a Copilot Responses body.
 *
 * Returns an empty object — spread-safe, adding no keys — when the client asked for nothing, so a
 * request carrying no `sampling` member produces a body byte-identical to the pre-mapping one.
 * Each sub-member is included only when it is present and numeric; an absent control is an absent
 * key rather than an explicit `undefined`, because `JSON.stringify` drops the latter but the
 * in-memory body a test reads would still carry it.
 */
export function copilotSamplingFields(sampling: Canonical_Request["sampling"]): JsonObject {
  if (!sampling) return {}
  return {
    ...(typeof sampling.maxOutputTokens === "number" ? { max_output_tokens: sampling.maxOutputTokens } : {}),
    ...(typeof sampling.temperature === "number" ? { temperature: sampling.temperature } : {}),
    ...(typeof sampling.topP === "number" ? { top_p: sampling.topP } : {}),
  }
}
