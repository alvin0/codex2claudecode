import type { Canonical_ErrorResponse, Canonical_Event, Canonical_FeatureNotice, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import type { UpstreamResult } from "../../core/interfaces"

/**
 * Put decided notices onto the result the client will actually read.
 *
 * Role, and only this role: delivery. Which features resolved and why is `./features.ts`'s job;
 * what a notice looks like is `src/core/canonical.ts`'s; turning one into visible text is
 * `src/inbound/<provider>/notice.ts`'s. Split out from `./features.ts` because the two change
 * for different reasons — a new feature edits the resolver, a new canonical result shape edits
 * this file. Same split, same reasoning, as `../kiro/feature-notices.ts`; the duplication is
 * per-upstream ownership rather than a missing abstraction, and neither file may reach into the
 * other's directory.
 *
 * All three channels exist because none is a superset of another. A streaming request never
 * reads `Canonical_Response.featureNotices`, a collected response never sees a `feature_notice`
 * event, and a rejected request reads neither — it reads
 * `Canonical_ErrorResponse.featureNotices`. Writing only one would leave that share of the
 * traffic silent.
 *
 * On this upstream both paths are live: `/v1/responses` requires `stream: true` upstream, while
 * a `/v1/messages` client can ask for either.
 */

/**
 * Attach `notices` to `result`, choosing the channel from the result's own shape.
 *
 * A pass-through for an empty list, so a request that resolved everything natively produces a
 * result identical to the pre-change one — including the *absence* of `featureNotices` rather
 * than an empty array, which is a meaningful distinction the accumulators preserve (Requirement
 * 8.3). That is the common case on this upstream today, and it is what keeps Requirement 10.6's
 * live case notice-free.
 *
 * `canonical_error` carries them too, on its own optional member: the field that failed does not
 * erase what the request decided about the others, and `status`, `headers` and `body` are left
 * exactly as produced. `canonical_passthrough` is the one shape returned untouched — a
 * passthrough is bytes the client must receive unmodified, and the byte-for-byte guarantee that
 * makes it that kind of result is exactly what anything injected here would break (Requirement
 * 15).
 */
export function withCodexFeatureNotices(result: UpstreamResult, notices: readonly Canonical_FeatureNotice[]): UpstreamResult {
  if (!notices.length) return result
  if (result.type === "canonical_response") return responseWithNotices(result, notices)
  if (result.type === "canonical_stream") return streamWithNotices(result, notices)
  if (result.type === "canonical_error") return errorWithNotices(result, notices)
  return result
}

/**
 * Notices decided before the request are placed **ahead** of any the parser collected, so the
 * order the client reads matches the order the decisions were made. Existing entries are kept
 * rather than replaced.
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
 * Wraps the event iterable instead of draining it, so the stream stays lazy and single-pass —
 * the notices are yielded when the consumer first pulls, not when this function is called.
 *
 * Ahead of the upstream content, because every decision this provider makes is made while
 * building the request (design §"Aggregation — streaming"). Notice events are token- and
 * content-neutral, so prepending them cannot split a content block or shift a usage count.
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
