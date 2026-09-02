import type { Canonical_FeatureNotice, Canonical_FeatureNoticePolicy } from "./canonical"
import type { FeaturePolicy, HostedToolPolicyMap, ProviderFeature } from "./provider-capabilities"
import { FEATURE_POLICIES } from "./provider-capabilities"

/**
 * The single place a declared {@link FeaturePolicy} becomes a resolved outcome.
 *
 * Role, and only this role: policy in, outcome out. This module decides *what
 * happens* to a client-supplied field; it never builds wire output, never reads
 * the environment, and never names a provider. Notice construction for the
 * canonical event already lives in `./canonical.ts`
 * ({@link Canonical_FeatureNotice}); rendering a notice into an API's wire shape
 * belongs to `src/inbound/<provider>/notice.ts`. Neither is duplicated here.
 *
 * Two invariants make "no silent drop" (Requirement 10.1) a structural fact
 * rather than a per-feature audit:
 *
 * 1. {@link FeatureOutcome} is a closed four-member union, so there is no fifth
 *    outcome to fall through to.
 * 2. {@link resolveFeature} is total — every input returns one of those four
 *    kinds, with no `undefined` and no throw.
 *
 * `strict` arrives as a plain boolean parameter. **This is the only function in
 * the repository that interprets it** (design decision D3): task 11 reads
 * `NATIVE_STRICT` once in `src/app/native-flags.ts` and threads the boolean
 * through provider construction, so escalation policy lives at one choke point
 * instead of at eleven feature sites. Nothing here touches `process.env`.
 */

/**
 * What the Gateway decided to do with one client-supplied field.
 *
 * Closed by construction: `native` forwards the value and reports nothing,
 * `emulate` and `degrade` each carry exactly one notice, `reject` carries the
 * feature plus a 400 message. Callers branch on `kind`, never on a policy
 * string — see {@link isFeatureRejection} and {@link featureOutcomeNotice},
 * which exist so no module under `src/upstream/` needs to compare against the
 * literals `"degrade"` or `"reject"` (design decision D3, enforced by a test in
 * task 10.5).
 */
export type FeatureOutcome =
  | { kind: "native" }
  | { kind: "emulate"; notice: Canonical_FeatureNotice }
  | { kind: "degrade"; notice: Canonical_FeatureNotice }
  | { kind: "reject"; feature: ProviderFeature; message: string }

/** The outcome kind of a {@link FeatureOutcome}. */
export type FeatureOutcomeKind = FeatureOutcome["kind"]

/**
 * Runtime view of the closed union, for the totality tests.
 *
 * Same drift-guard idiom as `FEATURE_POLICIES` / `PROVIDER_FEATURES` in
 * `provider-capabilities.ts`: `satisfies` rejects a member outside the union,
 * and the alias below rejects a union member missing from the array, so the two
 * cannot diverge in either direction.
 */
export const FEATURE_OUTCOME_KINDS = ["native", "emulate", "degrade", "reject"] as const satisfies readonly FeatureOutcomeKind[]

type AssertNever<T extends never> = T
type _EveryOutcomeKindIsListed = AssertNever<Exclude<FeatureOutcomeKind, (typeof FEATURE_OUTCOME_KINDS)[number]>>

/**
 * One resolution question: this feature, this declared policy, this request.
 *
 * `detail` and `alternative` are authored by the upstream that owns the
 * measurement, because only it knows what it did with the value — but both are
 * plain prose about client intent, never a wire field name.
 */
export interface FeatureResolutionInput {
  /** The feature being resolved. Named in every notice and rejection message. */
  feature: ProviderFeature
  /** The policy this upstream declares for {@link feature} in its `capabilities.ts`. */
  policy: FeaturePolicy
  /** What happens to the client's value. Provider-authored, wire-format-free. */
  detail: string
  /** What the client should use instead. Required for reject, used in strict escalation. */
  alternative: string
  /** Whether `degrade` escalates to `reject`. The only reader of this flag is below. */
  strict: boolean
}

/**
 * Fallback `detail`, used only when a caller passes a blank one.
 *
 * A notice with an empty detail would be a silent drop wearing a notice's
 * clothes (Requirement 8.1 requires non-empty detail), and totality forbids
 * throwing, so the text is filled in rather than rejected. Non-emptiness is not
 * expressible in the type system without a branded type, so it is enforced here
 * instead of at every construction site.
 */
function resolvedDetail(input: FeatureResolutionInput): string {
  const detail = input.detail.trim()
  if (detail.length > 0) return detail
  return `${input.feature} was not applied as requested by this upstream`
}

/**
 * Fallback `alternative`, used only when a caller passes a blank one.
 *
 * Requirement 10.3 says a rejection states an alternative; a blank one would
 * leave a 400 with no way forward. Deliberately generic — a provider-specific
 * suggestion is the calling upstream's to author.
 */
function resolvedAlternative(input: FeatureResolutionInput): string {
  const alternative = input.alternative.trim()
  if (alternative.length > 0) return alternative
  return "a different upstream, or omit the field"
}

function buildNotice(input: FeatureResolutionInput, policy: Canonical_FeatureNoticePolicy): Canonical_FeatureNotice {
  return { feature: input.feature, policy, detail: resolvedDetail(input) }
}

/**
 * The 400 body for a rejection.
 *
 * Shape follows the pattern `validateUnsupportedServerTools()` already returns
 * today — "does not support X … Use Y instead." — so Requirement 10.3's
 * "matching the pattern already used" holds without that function's
 * provider-specific wording moving into core. The feature name and the
 * alternative both appear literally, which is what Property 4 asserts.
 */
function rejectionMessage(input: FeatureResolutionInput): string {
  return `This upstream does not support ${input.feature}: ${resolvedDetail(input)}. Use ${resolvedAlternative(input)} instead.`
}

function rejection(input: FeatureResolutionInput): FeatureOutcome {
  return { kind: "reject", feature: input.feature, message: rejectionMessage(input) }
}

/**
 * Turn a declared policy into exactly one outcome. Total.
 *
 * - `native` → forward, no notice.
 * - `emulate` → one `emulate` notice. **Never escalated**, in strict mode or
 *   out of it: emulation preserves the client's semantics, so there is nothing
 *   to fail loudly about (Requirement 11.3).
 * - `reject` → 400 naming the feature and an alternative (Requirement 10.3).
 * - `degrade` → one `degrade` notice, or a rejection when `strict` is set. This
 *   escalation is the whole of strict mode: `degrade → reject` and nothing else
 *   (Requirement 11.1, Property 5).
 */
export function resolveFeature(input: FeatureResolutionInput): FeatureOutcome {
  switch (input.policy) {
    case "native":
      return { kind: "native" }
    case "emulate":
      return { kind: "emulate", notice: buildNotice(input, "emulate") }
    case "reject":
      return rejection(input)
    case "degrade":
      return input.strict ? rejection(input) : { kind: "degrade", notice: buildNotice(input, "degrade") }
    default:
      // Unreachable for a well-typed input: this alias fails to compile the
      // moment a fifth `FeaturePolicy` member exists without a case above.
      return unknownPolicy(input, input.policy)
  }
}

/**
 * Runtime guard for a policy value the type system says cannot exist.
 *
 * Totality is a runtime promise as well as a type-level one, so an unrecognised
 * policy — a hand-written capabilities cell, a value crossing a JSON boundary —
 * resolves to the loudest of the four outcomes rather than throwing or
 * returning `undefined`. Silently forwarding it would be exactly the silent
 * drop Requirement 10.1 exists to remove.
 */
function unknownPolicy(input: FeatureResolutionInput, policy: never): FeatureOutcome {
  return {
    kind: "reject",
    feature: input.feature,
    message: `This upstream declares an unrecognised policy (${String(policy)}) for ${input.feature}. Use ${resolvedAlternative(input)} instead.`,
  }
}

/**
 * Whether this outcome fails the request.
 *
 * A type guard so callers branch on the outcome's shape instead of comparing a
 * string, which keeps the task 10.5 enforcement test satisfiable: outside
 * `capabilities.ts`, no module under `src/upstream/` needs the literals
 * `"degrade"` or `"reject"` anywhere.
 */
export function isFeatureRejection(outcome: FeatureOutcome): outcome is Extract<FeatureOutcome, { kind: "reject" }> {
  return outcome.kind === "reject"
}

/**
 * Whether the client's value was forwarded untouched. `native` is the one
 * outcome that reports nothing.
 */
export function isNativeFeatureOutcome(outcome: FeatureOutcome): outcome is Extract<FeatureOutcome, { kind: "native" }> {
  return outcome.kind === "native"
}

/**
 * The notice this outcome carries, or `undefined` when it carries none.
 *
 * Exactly the `emulate` and `degrade` outcomes carry one, which is the "a
 * notice exists if and only if" half of Property 4. Lets a collector append
 * without inspecting `kind`.
 */
export function featureOutcomeNotice(outcome: FeatureOutcome): Canonical_FeatureNotice | undefined {
  return "notice" in outcome ? outcome.notice : undefined
}

/**
 * Look up the declared policy for one hosted tool type.
 *
 * Returns `undefined` for a type absent from the matrix — and that is a lookup
 * miss, not a fifth outcome. The caller decides what an unlisted type means
 * (`ProviderCapabilities.hostedTools` documents it as a degrade notice, never a
 * throw) and then routes that decision through {@link resolveFeature} like any
 * other, so the four-outcome guarantee is unaffected.
 *
 * Keys stay opaque strings, so no hosted tool type name from any provider's
 * wire vocabulary enters core. `Object.hasOwn` plus the membership check mean
 * an inherited property (`"constructor"`, `"toString"`) or a malformed cell
 * reads as absent rather than as a policy.
 */
export function resolveHostedToolPolicy(map: HostedToolPolicyMap | undefined, type: string): FeaturePolicy | undefined {
  if (!map || !Object.hasOwn(map, type)) return undefined
  const policy = map[type]
  return isFeaturePolicy(policy) ? policy : undefined
}

function isFeaturePolicy(value: unknown): value is FeaturePolicy {
  return typeof value === "string" && (FEATURE_POLICIES as readonly string[]).includes(value)
}
