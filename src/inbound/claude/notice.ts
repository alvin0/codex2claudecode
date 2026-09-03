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
 * Prefix of the header line. The native harness locates the warning segment by this marker
 * (`test/native/observation.ts`), so it is part of the observable contract, not decoration.
 */
export const CLAUDE_NOTICE_MARKER = "[gateway]"

/** Separator between the warning segment and the model text that follows it. */
const WARNING_SEPARATOR = "\n\n"

/**
 * One rendered notice line. The harness parses `- <feature>: <detail>` lines, one notice per
 * line, so a detail spanning lines would truncate the list — details are flattened first.
 */
function noticeLine(feature: string, detail: string) {
  return `- ${feature}: ${detail}`
}

/** Collapses any whitespace run (including newlines) to a single space, so one notice is one line. */
function flattenDetail(detail: string) {
  return detail.replace(/\s+/g, " ").trim()
}

function headerLine(count: number) {
  const subject = count === 1 ? "1 requested feature was" : `${count} requested features were`
  return `${CLAUDE_NOTICE_MARKER} ${subject} not honored as sent:`
}

/**
 * Renders every `degrade` notice of one request as a single warning segment: one header line
 * plus one line per notice (Requirement 9.4 — one combined warning, not one per notice).
 *
 * Returns `""` when the list holds no `degrade` notice. `emulate` notices are telemetry-only
 * (Requirement 9.2), so an `emulate`-only list renders exactly what an empty list renders.
 *
 * Duplicate notices are collapsed by `(feature, detail)` — the collectors keep one entry per
 * event on purpose, so deduping is this renderer's job. First-seen order is preserved; two
 * notices sharing a feature but differing in detail are two distinct lines.
 */
export function renderClaudeFeatureWarning(notices: readonly Canonical_FeatureNotice[]): string {
  const lines: string[] = []
  const seen = new Set<string>()

  for (const notice of notices) {
    if (notice.policy !== "degrade") continue
    const detail = flattenDetail(notice.detail)
    const key = `${notice.feature}\u0000${detail}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(noticeLine(notice.feature, detail))
  }

  if (!lines.length) return ""
  return [headerLine(lines.length), ...lines].join("\n")
}

/**
 * Places a rendered warning in front of model text. Empty inputs are pass-throughs, so a
 * request with no degrade notice produces text byte-identical to the un-warned response
 * (Requirement 9.2). A blank line separates the notice lines from the model text, which is
 * also what ends the notice list for the harness parser.
 */
export function prependClaudeWarning(text: string, warning: string): string {
  if (!warning) return text
  if (!text) return warning
  return `${warning}${WARNING_SEPARATOR}${text}`
}
