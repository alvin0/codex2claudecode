import type { Canonical_FeatureNotice } from "./canonical"
import type { FeatureOutcome } from "./feature-policy"
import { featureOutcomeNotice, isFeatureRejection, resolveFeature } from "./feature-policy"
import type { FeaturePolicy, ProviderFeature } from "./provider-capabilities"

/**
 * Per-request bookkeeping for feature resolution.
 *
 * Role, and only this role: remember what one request decided. Policy → outcome
 * is `./feature-policy.ts`'s job and is not duplicated here; notice *shape* is
 * `./canonical.ts`'s; rendering a notice into an API's wire form is
 * `src/inbound/<provider>/`'s. This module adds the three answers a caller needs
 * *after* resolving several features: what to report, whether to fail, and what
 * was covered.
 *
 * The split exists because {@link resolveFeature} is pure and stateless — it
 * cannot know that `toolChoiceForced` was already resolved with the same detail,
 * or which rejection came first. That memory is per-request, so it lives in a
 * per-request object rather than in module state.
 */

/**
 * The rejection a caller turns into a single 400.
 *
 * Deliberately *not* `Extract<FeatureOutcome, { kind: "reject" }>`: dropping
 * `kind` means an upstream that handles a rejection never touches the literal
 * `"reject"`, which is what the task 10.5 enforcement test requires of every
 * module under `src/upstream/` outside its `capabilities.ts`.
 */
export interface FeatureRejection {
  /** The feature that failed the request. */
  feature: ProviderFeature
  /** The 400 message, already naming the feature and an alternative. */
  message: string
}

/**
 * One upstream's declared policy per feature — `ProviderCapabilities.features`.
 *
 * Read-only here because a collector observes a declaration; it never edits the
 * matrix.
 */
export type DeclaredFeaturePolicies = Readonly<Record<ProviderFeature, FeaturePolicy>>

/**
 * Dedup key for a notice: the pair `(feature, detail)`.
 *
 * `JSON.stringify` of the pair rather than a delimiter join, so no detail text
 * can forge a key — `("sampling", "a|b")` and `("sampling|a", "b")` stay
 * distinct. Two notices for the same feature with *different* details are two
 * different keys and both survive; the same pair twice collapses to one.
 */
function noticeKey(feature: ProviderFeature, detail: string): string {
  return JSON.stringify([feature, detail])
}

/**
 * The outcomes of one request, in the order they were decided.
 *
 * Built once per request by an upstream's `proxy()`, then:
 *
 * ```ts
 * const decisions = new FeatureDecisions(CAPABILITIES.features, strict)
 * decisions.resolve("sampling", "temperature=0.2 was not sent upstream", "an upstream that honours it")
 * // …one resolve() per client-supplied field the matrix covers…
 * const rejection = decisions.firstRejection()
 * if (rejection) return canonicalError(400, rejection.message)
 * for (const notice of decisions.notices()) yield { type: "feature_notice", ...notice }
 * ```
 *
 * Three deliberate choices:
 *
 * 1. **Resolution does not stop at the first rejection.** Every `resolve()` call
 *    still records, so `resolvedFeatures()` stays a complete account of what was
 *    covered even on a request that will end in a 400. The caller decides when
 *    to bail — usually after resolving everything, so one request produces one
 *    400 rather than a race between two failing fields.
 * 2. **`strict` is held, never read.** It is stored only to be handed to
 *    {@link resolveFeature}, which is the single function in the repository that
 *    interprets it (design decision D3). There is no `if (this.strict)` here,
 *    and adding one would put escalation policy in two places.
 * 3. **No `kind` string is exposed for branching.** Callers use
 *    {@link FeatureDecisions.firstRejection} and
 *    {@link FeatureDecisions.notices}; the `FeatureOutcome` returned by
 *    `resolve()` is there for the rare caller that needs the value back (e.g. to
 *    keep a native forward), and it carries its own type guards.
 */
export class FeatureDecisions {
  private readonly features: DeclaredFeaturePolicies
  private readonly strict: boolean
  /**
   * Notices by {@link noticeKey}, first occurrence wins.
   *
   * A `Map` is the dedup and the ordering at once: insertion order is iteration
   * order, so `notices()` is emission order with no sort, no reverse, and no
   * separate index. First-wins rather than last-wins keeps the reported position
   * of a repeated pair at the point it was *first* decided.
   */
  private readonly noticesByKey = new Map<string, Canonical_FeatureNotice>()
  /** Features that went through `resolve()`, whatever the outcome. */
  private readonly resolved = new Set<ProviderFeature>()
  private rejection?: FeatureRejection

  constructor(features: DeclaredFeaturePolicies, strict: boolean) {
    this.features = features
    this.strict = strict
  }

  /**
   * Resolve one feature against this upstream's declared policy and record it.
   *
   * `detail` says what happened to the client's value and `alternative` what to
   * use instead; both are provider-authored prose, never a wire field name. A
   * feature missing from the declaration — possible only if the matrix crossed a
   * JSON boundary — reaches {@link resolveFeature} as an unrecognised policy and
   * comes back as a rejection, so it is loud rather than a silent forward.
   */
  resolve(feature: ProviderFeature, detail: string, alternative: string): FeatureOutcome {
    return this.resolveWithPolicy(feature, this.features[feature], detail, alternative)
  }

  /**
   * Resolve one feature against a policy the caller looked up elsewhere.
   *
   * For decisions whose policy does not live in the `features` record — a hosted
   * tool type read through `resolveHostedToolPolicy()`, or the documented
   * fallback for a type absent from that map. The policy must still come from a
   * matrix or a `capabilities.ts` constant, never from a literal written at the
   * call site, so the declaration stays the single source of truth.
   *
   * Recorded exactly like {@link FeatureDecisions.resolve}: same dedup, same
   * ordering, same rejection bookkeeping.
   */
  resolveWithPolicy(
    feature: ProviderFeature,
    policy: FeaturePolicy,
    detail: string,
    alternative: string,
  ): FeatureOutcome {
    const outcome = resolveFeature({ feature, policy, detail, alternative, strict: this.strict })
    this.resolved.add(feature)

    const notice = featureOutcomeNotice(outcome)
    if (notice) {
      const key = noticeKey(notice.feature, notice.detail)
      if (!this.noticesByKey.has(key)) this.noticesByKey.set(key, notice)
    }

    if (isFeatureRejection(outcome) && !this.rejection) {
      this.rejection = { feature: outcome.feature, message: outcome.message }
    }

    return outcome
  }

  /**
   * Every notice this request produced, in emission order, deduped by
   * `(feature, detail)`.
   *
   * Exactly the `emulate` and `degrade` outcomes contribute one each; `native`
   * contributes none and `reject` travels the error path instead. Fresh copies,
   * so a caller that mutates a notice on its way to the wire cannot corrupt the
   * record.
   */
  notices(): Canonical_FeatureNotice[] {
    return [...this.noticesByKey.values()].map((notice) => ({ ...notice }))
  }

  /**
   * The first rejection recorded, or `undefined` when nothing rejected.
   *
   * "First" is resolution order, so the 400 a client sees is stable for a given
   * request rather than dependent on which failing field happened to be
   * inspected last.
   */
  firstRejection(): FeatureRejection | undefined {
    return this.rejection ? { ...this.rejection } : undefined
  }

  /**
   * The features that went through resolution, `native` included.
   *
   * This is the right-hand side of the no-silent-drop set comparison
   * (Requirement 10.8): features present in the request minus this set is the
   * set of silently dropped fields, and it must be empty. Membership therefore
   * means "was resolved", not "produced a notice" — a `native` forward is a
   * declared outcome and belongs here.
   *
   * A snapshot: later `resolve()` calls do not mutate an already-returned set.
   */
  resolvedFeatures(): ReadonlySet<ProviderFeature> {
    return new Set(this.resolved)
  }
}
