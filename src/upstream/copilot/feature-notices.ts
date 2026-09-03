import type { Canonical_ErrorResponse, Canonical_Event, Canonical_FeatureNotice, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import type { UpstreamResult } from "../../core/interfaces"

/**
 * Put decided notices onto the result the client will actually read.
 *
 * Role, and only this role: delivery. Which features resolved and why is `./features.ts`'s job;
 * what a notice looks like is `src/core/canonical.ts`'s; turning one into visible text is
 * `src/inbound/<provider>/notice.ts`'s. Same split, same reasoning, as
 * `../kiro/feature-notices.ts` and `../codex/feature-notices.ts`; the duplication is per-upstream
 * ownership rather than a missing abstraction, and neither file may reach into the other's
 * directory.
 *
 * One wrinkle specific to this upstream: its stream is synthesized. `buildCopilotResponsesBody()`
 * hardcodes a non-streaming upstream call and `streamCopilotResponse()` (`./parse.ts`) replays the
 * collected response as events. So a streaming client here reads events, a non-streaming one reads
 * the response field, and both content channels below are reachable even though only one upstream
 * call shape exists. A rejected request reads neither and gets its notices on the error result.
 */

/**
 * Attach `notices` to `result`, choosing the channel from the result's own shape.
 *
 * A pass-through for an empty list, so a request that resolved everything natively produces a
 * result identical to the pre-change one — including the *absence* of `featureNotices` rather
 * than an empty array (Requirement 8.3).
 *
 * `canonical_error` carries them on its own optional member: the field that failed does not erase
 * what the request decided about the others, and `status`, `headers` and `body` are left exactly
 * as produced. This provider returns no passthrough result at all (`passthrough: false` in
 * `./capabilities.ts`), so that branch stays the closed-union default rather than a case with
 * behavior of its own.
 */
export function withCopilotFeatureNotices(result: UpstreamResult, notices: readonly Canonical_FeatureNotice[]): UpstreamResult {
  if (!notices.length) return result
  if (result.type === "canonical_response") return responseWithNotices(result, notices)
  if (result.type === "canonical_stream") return streamWithNotices(result, notices)
  if (result.type === "canonical_error") return errorWithNotices(result, notices)
  return result
}

/**
 * Notices decided before the request are placed **ahead** of any the parser collected, so the
 * order the client reads matches the order the decisions were made.
 */
function responseWithNotices(response: Canonical_Response, notices: readonly Canonical_FeatureNotice[]): Canonical_Response {
  return {
    ...response,
    featureNotices: [...notices.map(copyNotice), ...(response.featureNotices ?? [])],
  }
}

/**
 * Same placement rule as {@link responseWithNotices}: decided notices ahead of anything already
 * on the result, existing entries kept. A copy rather than a mutation, so the error object a
 * caller built stays what it was.
 */
function errorWithNotices(error: Canonical_ErrorResponse, notices: readonly Canonical_FeatureNotice[]): Canonical_ErrorResponse {
  return {
    ...error,
    featureNotices: [...notices.map(copyNotice), ...(error.featureNotices ?? [])],
  }
}

/**
 * Wraps the event iterable instead of draining it, so the stream stays lazy and single-pass.
 * Ahead of the content, because every decision this provider makes is made while building the
 * request. Notice events are token- and content-neutral, so prepending them cannot split a
 * content block or shift a usage count.
 */
function streamWithNotices(stream: Canonical_StreamResponse, notices: readonly Canonical_FeatureNotice[]): Canonical_StreamResponse {
  const upstream = stream.events
  const decided = notices.map(copyNotice)
  return {
    ...stream,
    events: {
      async *[Symbol.asyncIterator](): AsyncIterator<Canonical_Event> {
        for (const notice of decided) {
          yield { type: "feature_notice", feature: notice.feature, policy: notice.policy, detail: notice.detail }
        }
        yield* upstream
      },
    },
  }
}

/** Fresh objects, so a consumer that mutates a notice cannot reach back into the decision record. */
function copyNotice(notice: Canonical_FeatureNotice): Canonical_FeatureNotice {
  return { ...notice }
}
