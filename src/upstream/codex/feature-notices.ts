import type { Canonical_Event, Canonical_FeatureNotice, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
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
 * Both channels exist because neither is a superset of the other. A streaming request never
 * reads `Canonical_Response.featureNotices`, and a collected response never sees a
 * `feature_notice` event, so writing only one would leave half the traffic silent.
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
 * `canonical_error` and `canonical_passthrough` are returned untouched. An error already carries
 * its own message down the rejection path, and a passthrough is bytes the client must receive
 * unmodified — the byte-for-byte guarantee that makes it that kind of result is exactly what a
 * message injected here would break (Requirement 15).
 */
export function withCodexFeatureNotices(result: UpstreamResult, notices: readonly Canonical_FeatureNotice[]): UpstreamResult {
  if (!notices.length) return result
  if (result.type === "canonical_response") return responseWithNotices(result, notices)
  if (result.type === "canonical_stream") return streamWithNotices(result, notices)
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
