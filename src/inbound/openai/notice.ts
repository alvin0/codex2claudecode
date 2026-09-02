// Role: render Canonical feature notices as OpenAI-visible warning text and place that text
// in front of model text. Pure string work — no I/O, no upstream knowledge, no wire types.
//
// This module is the only home for the OpenAI notice wording (Requirement 9.5): modules under
// `src/upstream/` must contain zero OpenAI-shaped notice strings, so the marker below never
// travels outward. It deliberately does not import `src/inbound/claude/notice.ts` — one inbound
// provider reaching into another's directory is the dependency edge the architecture rules
// forbid, and the two renderers are free to diverge in wording without breaking each other.
//
// What "OpenAI wire shape" means here (Requirement 9.3): the *delivery* differs, not the
// information. The text below is leading text of the first `output_text` part (Responses) or of
// `choices[0].message.content` (chat completions) — never a new output item type, a new SSE
// event name, or a new header (Requirement 9.6). The filtering, deduping, ordering and
// one-combined-warning rules are the same rules the Claude renderer applies, because
// Requirements 9.2 and 9.4 bind both inbound providers equally.
import type { Canonical_FeatureNotice } from "../../core/canonical"

/**
 * Prefix of the header line, identical to the Claude renderer's marker on purpose.
 *
 * The native harness locates a warning segment by this string and reads `- <feature>: <detail>`
 * lines under it (`textNotices()` in `test/native/observation.ts`). No live case reads notices
 * off an OpenAI response today — the notice-observing cases are all Kiro/Claude — but matching
 * the marker keeps one parser for both inbound formats, and a second marker would buy nothing
 * except a second thing to keep in sync. What makes this rendering OpenAI-shaped is where the
 * text lands on the wire, not the characters it is made of.
 */
export const OPENAI_NOTICE_MARKER = "[gateway]"

/** Separator between the warning segment and the model text next to it. */
export const OPENAI_WARNING_SEPARATOR = "\n\n"

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
  return `${OPENAI_NOTICE_MARKER} ${subject} not honored as sent:`
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
export function renderOpenAIFeatureWarning(notices: readonly Canonical_FeatureNotice[]): string {
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
export function prependOpenAIWarning(text: string, warning: string): string {
  if (!warning) return text
  if (!text) return warning
  return `${warning}${OPENAI_WARNING_SEPARATOR}${text}`
}
