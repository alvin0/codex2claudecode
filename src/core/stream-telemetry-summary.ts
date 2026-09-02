// Both sides of this projection are core types — the in-process snapshot in
// `stream-telemetry.ts` and the persisted slice in `types.ts` — so the mapping
// between them is provider-agnostic and lives here rather than being written twice
// in `src/inbound/claude/` and `src/inbound/openai/`. It gets its own module rather
// than joining either type's file because it is a third role: neither declares the
// other, and only this function knows which fields cross the boundary.
import type { Canonical_Response } from "./canonical"
import type { StreamTelemetry } from "./stream-telemetry"
import type { StreamTelemetrySummary } from "./types"

/**
 * Project a finalized {@link StreamTelemetry} snapshot onto the narrower
 * {@link StreamTelemetrySummary} the request log persists.
 *
 * Copies exactly the two fields the summary declares, and preserves each one's
 * presence semantics so the persisted form reports the same answer the in-process
 * snapshot does:
 *
 * - `featureNotices` is **omitted** when the snapshot omitted it, never rewritten
 *   as `[]` or as present-with-`undefined`. Requirement 8.3 asks for omission, and
 *   for an array member the difference is observable through `"featureNotices" in
 *   summary` and `Object.keys()`.
 * - `providerCredits` is **always present**, carrying `undefined` when the upstream
 *   reported no spend. `undefined` means "not measured" and is distinct from `0`,
 *   which means "measured as free" (Requirement 5.3) — the same asymmetry
 *   `finalize()` establishes, kept rather than normalized away.
 *
 * The notice array is copied rather than aliased: `finalize()` caches and re-returns
 * one snapshot object, so handing its array to a log entry that is written later
 * would let the two share mutable state.
 */
export function streamTelemetrySummary(telemetry: StreamTelemetry): StreamTelemetrySummary {
  return {
    ...(telemetry.featureNotices ? { featureNotices: [...telemetry.featureNotices] } : {}),
    providerCredits: telemetry.providerCredits,
  }
}

/**
 * Project a finalized {@link Canonical_Response} onto the same
 * {@link StreamTelemetrySummary} the request log persists.
 *
 * The non-streaming counterpart of {@link streamTelemetrySummary}. On that path no
 * {@link StreamTelemetry} snapshot exists — no collector is constructed, because there
 * is no stream to instrument — but the two fields the summary carries were already
 * folded into the response: `providerCredits` by `mergeCanonicalUsage()` (summing, in
 * `usage.ts`) and `featureNotices` by the `feature_notice` fold in
 * `canonical-accumulator.ts` and in `collectKiroResponse()`. This function is the only
 * thing that carries them across to the log.
 *
 * It lives beside the streaming projection rather than being written out at the four
 * inbound call sites for three reasons. Both of its sides are core types, so the
 * mapping is provider-agnostic and duplicating it in `src/inbound/claude/` and
 * `src/inbound/openai/` would put provider-neutral logic in two provider directories.
 * The presence asymmetry below is subtle enough that four hand-written copies would
 * drift. And the module's role is already "produce a `StreamTelemetrySummary`" — a
 * second source shape is the same role, not a new one, so the two functions can be
 * read against each other and seen to agree.
 *
 * Presence semantics are identical to the streaming projection, field for field,
 * because the log's consumers cannot tell which path produced an entry:
 *
 * - `featureNotices` is **omitted** when the response omitted it, never rewritten as
 *   `[]` or as present-with-`undefined` (Requirement 8.3).
 * - `providerCredits` is **always present**, carrying `undefined` when the upstream
 *   reported no spend — "not measured", distinct from `0` meaning "measured as free"
 *   (Requirement 5.3). `Canonical_Response.usage` omits the member entirely in that
 *   case, and reading it yields `undefined`, which is the answer to report.
 *
 * The notice array is copied rather than aliased, for the same reason the streaming
 * projection copies: the response object outlives this call and the log entry is
 * written later, so sharing a mutable array would let the two disagree.
 */
export function canonicalResponseTelemetrySummary(response: Canonical_Response): StreamTelemetrySummary {
  return {
    ...(response.featureNotices ? { featureNotices: [...response.featureNotices] } : {}),
    providerCredits: response.usage.providerCredits,
  }
}
