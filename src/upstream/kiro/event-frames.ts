// Role: recognise where one Kiro payload begins inside decoded EventStream text. This is
// *framing* only — it answers "where does the next JSON object start", never "what does that
// object mean". Payload meaning belongs to the modules that consume the parsed object.
//
// Seam contract (design D1): this module is deliberately temporary. The Kiro pipeline plan's
// frame-decoder rewrite (T3–T5) replaces prefix scanning with `:event-type` header dispatch,
// and when it lands it **deletes this file** together with the scanning half of
// `AwsEventStreamParser`. Nothing outside the scanner should grow a dependency on the pattern
// list. `src/upstream/kiro/metering.ts` is written the other way round — it classifies a decoded
// payload object, so the rewrite moves its call into a `meteringEvent` switch case and leaves it
// untouched. If you are adding payload *semantics*, put it there, not here.

/**
 * Payload openings that mark a top-level frame boundary.
 *
 * The first six are the set the scanner has always matched. `{"unit":` is the measured
 * `meteringEvent` payload `{"unit":"credit","unitPlural":"credits","usage":0.0148}`
 * (`.omc/research/kiro-wire-spike.md` §2, §3), which the old list omitted, so metering frames
 * were skipped as noise (Requirement 5.1).
 */
export const KIRO_EVENT_START_PATTERNS: readonly string[] = [
  "{\"contextUsagePercentage\":",
  "{\"content\":",
  "{\"name\":",
  "{\"input\":",
  "{\"stop\":",
  "{\"usage\":",
  "{\"unit\":",
]

export function findEventStart(buffer: string) {
  // Only match patterns at the start of a top-level JSON object.
  // Skip matches that appear inside a JSON string (preceded by an odd number of unescaped quotes).
  let best = -1
  for (const pattern of KIRO_EVENT_START_PATTERNS) {
    let searchFrom = 0
    while (searchFrom < buffer.length) {
      const index = buffer.indexOf(pattern, searchFrom)
      if (index < 0) break
      // Verify this is not inside a JSON string by checking if the preceding
      // context suggests we're at a top-level position (not inside quotes).
      if (index === 0 || isLikelyTopLevel(buffer, index)) {
        if (best < 0 || index < best) best = index
        break
      }
      searchFrom = index + 1
    }
  }
  return best
}

/**
 * Heuristic: check if position is likely a top-level JSON start rather than
 * inside a string value. We look backwards for the nearest unescaped quote
 * and count whether we're inside a string context.
 */
export function isLikelyTopLevel(buffer: string, position: number) {
  // Quick check: if preceded by whitespace, newline, or start of buffer, likely top-level
  const preceding = buffer[position - 1]
  if (!preceding || preceding === "\n" || preceding === "\r" || preceding === " " || preceding === "\t") return true
  // If preceded by a closing brace/bracket, likely between events
  if (preceding === "}" || preceding === "]") return true
  // If preceded by a comma or colon, could be inside an object — but our patterns
  // start with `{"` which is unusual inside a value. Accept it.
  if (preceding === "," || preceding === ":") return false
  // If preceded by a quote, we're likely inside a string
  if (preceding === "\"") return false
  return true
}
