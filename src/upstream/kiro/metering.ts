// Role: classify and parse the Kiro `meteringEvent` payload. This module answers "what does this
// decoded object mean", never "where does it start in the byte stream" — framing lives in
// `./event-frames`.
//
// Seam contract (design D1): the later frame-decoder rewrite deletes `event-frames.ts` and moves
// this call into a `meteringEvent` switch case, leaving this file and its tests unchanged. That
// holds because recognition here is by **payload shape**, not by framing: the real decoder produces
// the same payload objects, merely keyed by `:event-type`, so `parseKiroMeteringUsage()` keeps
// returning the same answer for the same object. The rewrite changes how a payload is located, not
// what it looks like.
//
// Scope (Requirement 5.5): metering reachability and the credit amount only. No `:event-type`
// header dispatch, no `reasoningContentEvent` signature handling, no payload-size-limit change.

/**
 * The structural minimum of the measured `meteringEvent` payload
 * `{"unit":"credit","unitPlural":"credits","usage":0.0148}`
 * (`.omc/research/kiro-wire-spike.md` §2).
 *
 * `unit` is what separates this payload from the token-usage shape `{"usage":{…}}`, whose `usage`
 * is an object and which carries no `unit`. Declared as an open shape: the measured payload also
 * carries `unitPlural`, and the provider may add more fields.
 */
export interface KiroMeteringPayload {
  unit: string
  usage: number
}

/**
 * True when `value` is a metering payload: an object with a **string** `unit` and a **finite
 * numeric** `usage`.
 *
 * Deliberate edge cases:
 *
 * - `usage: 0` — accepted. A zero-credit turn is a real measurement, and the caller summing it
 *   still records that metering arrived.
 * - Negative `usage` — accepted. The guard classifies by shape, not by plausible value. Narrowing
 *   on sign would push an unexpected-valued metering frame back into the token-usage branch, which
 *   would report it as an output-token count — exactly what Requirement 5.4 forbids.
 * - `NaN`, `Infinity`, `-Infinity` — rejected. These are the one value-level exception because a
 *   non-finite amount poisons the running credit total permanently once summed, and it is not a
 *   credit amount in any case. The rejection costs nothing on real wire data: JSON has no literal
 *   for either, so `JSON.parse` cannot produce one.
 * - `unit: ""` — accepted. The discriminator is that `unit` is present and is a string; the unit
 *   vocabulary (`"credit"` / `"credits"`) belongs to the provider and may change without this
 *   guard becoming wrong.
 * - Extra unknown keys — accepted. Structural minimum, not exact match, so a provider adding a
 *   field does not silently turn metering frames back into noise.
 * - `null`-prototype objects — accepted. Only `typeof` and direct property reads are used, so an
 *   object built without `Object.prototype` classifies the same as a `JSON.parse` result.
 * - `null`, primitives, and arrays — rejected. None of them can be a metering payload.
 */
export function isKiroMeteringPayload(value: unknown): value is KiroMeteringPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const candidate = value as { unit?: unknown; usage?: unknown }
  if (typeof candidate.unit !== "string") return false
  return typeof candidate.usage === "number" && Number.isFinite(candidate.usage)
}

/**
 * The credit amount carried by a metering payload, or `undefined` when `value` is not one.
 *
 * The return type is a bare `number` rather than an object carrying `unit` / `unitPlural` because
 * the caller **sums** across frames — one gateway request can make two upstream calls (web-search
 * preflight plus the main generate), each emitting its own metering payload, and the request's
 * spend is their total. A number makes that `total = (total ?? 0) + credits`, with no field access
 * and no rule for what to do when two frames disagree on unit — a decision no measured payload
 * requires, since every measured frame reads `"credit"`. It also makes summing a non-metering
 * payload impossible by accident: `undefined` is not addable, so the mistake is a type error at
 * the call site rather than a `NaN` in the credit total. `unit` stays available through
 * `isKiroMeteringPayload()` for any caller that needs to display it.
 */
export function parseKiroMeteringUsage(value: unknown): number | undefined {
  return isKiroMeteringPayload(value) ? value.usage : undefined
}
