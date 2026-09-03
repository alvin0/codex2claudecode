import type { Canonical_ErrorResponse, Canonical_Event, Canonical_FeatureNotice, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import type { UpstreamResult } from "../../core/interfaces"

/**
 * Put decided notices onto the result the client will actually read.
 *
 * Role, and only this role: delivery. Which features resolved and why is `./features.ts`'s
 * job; what a notice looks like is `src/core/canonical.ts`'s; turning one into visible text is
 * `src/inbound/<provider>/notice.ts`'s. Split out from `./features.ts` because the two change
 * for different reasons — a new feature edits the resolver, a new canonical result shape edits
 * this file.
 *
 * The delivery is deliberately **two-pathed**, because one path alone reaches nobody:
 *
 * - **Non-streaming** notices land on `Canonical_Response.featureNotices`. This is the path the
 *   live Kiro cases take (they send `stream: false`, and `Kiro_Upstream_Provider.proxy()`
 *   returns `collectKiroResponse()` rather than a canonical stream when `request.stream` is
 *   falsy). Both readers hang off that one field: `canonicalResponseTelemetrySummary()`
 *   projects it into `RequestProxyLog.telemetry`, and `canonicalResponseToClaudeMessage()`
 *   renders its `degrade` entries in front of the model text.
 * - **Streaming** notices are yielded as `feature_notice` events ahead of the upstream content,
 *   which is where the design places decisions made while building the payload — they are all
 *   known before the upstream request is even sent.
 *
 * - **Rejected** requests land on `Canonical_ErrorResponse.featureNotices`. Resolution keeps
 *   recording past a rejection, so an error result is the third place a decided notice has to be
 *   readable: which error ended the request does not change what the request decided about the
 *   other fields it carried.
 *
 * No path is a superset of another, so all three exist. Emitting only the events would leave
 * every non-streaming request silent; writing only the field would leave a stream silent; and
 * skipping the error result would drop every notice a 400 request decided.
 */

/**
 * Attach `notices` to `result`, choosing the channel from the result's own shape.
 *
 * A pass-through for an empty list, so a request that resolved everything natively produces a
 * result byte-identical to the pre-change one — including the *absence* of `featureNotices`
 * rather than an empty array, which is a meaningful distinction the accumulators preserve
 * (Requirement 8.3).
 *
 * `canonical_error` carries them too, on its own optional member: the request's one failing
 * field does not erase what it decided about the rest, and the error's `status`, `headers` and
 * `body` are left exactly as produced. `canonical_passthrough` is the one shape returned
 * untouched — those are bytes the client must receive unmodified, and adding anything to them
 * would break the guarantee that makes it that kind of result (Requirement 15).
 */
export function withKiroFeatureNotices(result: UpstreamResult, notices: readonly Canonical_FeatureNotice[]): UpstreamResult {
  if (!notices.length) return result
  if (result.type === "canonical_response") return responseWithNotices(result, notices)
  if (result.type === "canonical_stream") return streamWithNotices(result, notices)
  if (result.type === "canonical_error") return errorWithNotices(result, notices)
  return result
}

/**
 * Notices decided before the request are placed **ahead** of any the parser collected, so the
 * order the client reads matches the order the decisions were made. Existing entries are kept
 * rather than replaced: a mid-stream decision recorded by `collectKiroResponse()` is as real as
 * a payload-time one.
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
