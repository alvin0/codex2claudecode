// Role: render Canonical feature notices as Claude-visible warning text and place that text
// in front of model text. Pure string work — no I/O, no upstream knowledge, no wire types.
//
// This module is the only home for the Claude notice wording (Requirement 9.5): modules under
// `src/upstream/` must contain zero Claude-shaped notice strings, so the marker below never
// travels outward. Delivery of the rendered string reuses the existing `payloadTrimWarning`
// channel (design D2) — leading text of the first text block, never a new block type, SSE
// event name, or header.
import type { Canonical_FeatureNotice } from "../../core/canonical"

/**
 * Prefix of the warning line. The native harness locates the warning segment by this marker
 * (`test/native/observation.ts`), so it is part of the observable contract, not decoration.
 */
export const CLAUDE_NOTICE_MARKER = "[gateway]"

/** Separator between the warning segment and the model text that follows it. */
const WARNING_SEPARATOR = "\n\n"

/**
 * Renders every `degrade` notice of one request as a single warning line naming the features
 * (Requirement 9.4 — one combined warning, not one per notice).
 *
 * Names only, no `detail`. The details are long — the four a routine Claude Code turn produces
 * ran to roughly 900 characters — and they are identical on every turn of a session, because
 * each describes the upstream rather than the request. Prepended to every reply they crowd out
 * the model's own text and accumulate in the transcript. The client still learns which of its
 * fields were changed, which is what Requirement 10.1 asks of this channel; the prose
 * explaining each one stays on `Canonical_Response.featureNotices`, which reaches stream
 * telemetry and the request log untouched (`src/core/stream-telemetry-summary.ts`), so the
 * detail is moved off the conversation rather than lost.
 *
 * Returns `""` when the list holds no `degrade` notice. `emulate` notices are telemetry-only
 * (Requirement 9.2), so an `emulate`-only list renders exactly what an empty list renders.
 *
 * Deduped by feature in first-seen order. The key is the feature alone rather than the
 * `(feature, detail)` pair the per-notice lines used: with the detail gone, two notices for one
 * feature would otherwise render as the same name twice.
 */
export function renderClaudeFeatureWarning(notices: readonly Canonical_FeatureNotice[]): string {
  const features: string[] = []
  const seen = new Set<string>()

  for (const notice of notices) {
    if (notice.policy !== "degrade") continue
    if (seen.has(notice.feature)) continue
    seen.add(notice.feature)
    features.push(notice.feature)
  }

  if (!features.length) return ""
  return `${CLAUDE_NOTICE_MARKER} not honored as sent: ${features.join(", ")}`
}

/**
 * Places a rendered warning in front of model text. Empty inputs are pass-throughs, so a
 * request with no degrade notice produces text byte-identical to the un-warned response
 * (Requirement 9.2). A blank line separates the warning line from the model text, which is
 * also what ends the warning segment for the harness parser.
 */
export function prependClaudeWarning(text: string, warning: string): string {
  if (!warning) return text
  if (!text) return warning
  return `${warning}${WARNING_SEPARATOR}${text}`
}
