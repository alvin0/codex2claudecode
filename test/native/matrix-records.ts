// Role: derive matrix observation records from a case run and write them where
// `scripts/native-verify.ts` reads them (Requirement 24.9).
//
// Every field a record carries is read from the registry or from the observation. Nothing
// here decides a policy — the walk in `verify-matrix.ts` owns that comparison, and a cell no
// run touched stays `unresolved` rather than being filled in with a guess.
//
// A case's *requested* features are read from its assertion ids, which is the same signal
// `coveringCaseIds()` in `verify-matrix.ts` already uses to link a cell to a case. That keeps
// one source of truth: adding `expectDeclaredOutcome("stopSequences")` to a case makes the
// cell both covered and observed, with no second list to update.
import { writeTextFile } from "../../src/core/bun-fs"

import { nativeObservationsFile } from "./matrix-source"
import { featureNotices, noticeFor } from "./observation"
import type { NativeLiveCase, NativeLiveObservation } from "./types"
import type { NativeMatrixObservation } from "./verify-matrix"

/** Assertion-id prefixes that name a `Provider_Feature` the case deliberately sent. */
export const NATIVE_FEATURE_ASSERTION_PREFIXES = ["declared-outcome-", "no-notice-", "notice-"] as const

/**
 * `expectNoticeMentions("max")` produces `notice-mentions-max`, whose suffix is a needle, not
 * a feature. Excluded explicitly so no record ever claims a feature named `mentions-max`.
 */
const NOT_A_FEATURE_PREFIX = "notice-mentions-"

/** Features the case's assertions name, in first-seen order and without duplicates. */
export function nativeCaseFeatures(liveCase: NativeLiveCase): string[] {
  const features: string[] = []

  for (const assertion of liveCase.assertions) {
    if (assertion.id.startsWith(NOT_A_FEATURE_PREFIX)) continue
    const prefix = NATIVE_FEATURE_ASSERTION_PREFIXES.find((candidate) => assertion.id.startsWith(candidate))
    if (!prefix) continue
    const feature = assertion.id.slice(prefix.length)
    if (feature && !features.includes(feature)) features.push(feature)
  }

  return features
}

/**
 * One record per feature this run can speak to: the features the case's assertions named,
 * plus any feature a notice actually mentioned. `requested` is true for the first group
 * because the case body sent the field, and for the second because a notice named it.
 */
export function nativeMatrixObservationsFor(
  liveCase: NativeLiveCase,
  observation: NativeLiveObservation,
): NativeMatrixObservation[] {
  const records: NativeMatrixObservation[] = []
  const seen = new Set<string>()

  for (const feature of nativeCaseFeatures(liveCase)) {
    seen.add(feature)
    const notice = noticeFor(observation, feature)
    records.push({
      route: liveCase.route,
      upstream: liveCase.upstream,
      feature,
      noticeObserved: notice !== undefined,
      requested: true,
      caseId: liveCase.id,
      detail: `status ${observation.status}${notice?.policy ? `; notice policy ${notice.policy}` : ""}`,
    })
  }

  for (const notice of featureNotices(observation)) {
    if (seen.has(notice.feature)) continue
    seen.add(notice.feature)
    records.push({
      route: liveCase.route,
      upstream: liveCase.upstream,
      feature: notice.feature,
      noticeObserved: true,
      requested: true,
      caseId: liveCase.id,
      detail: `observed through ${notice.source}${notice.policy ? ` as ${notice.policy}` : ""}`,
    })
  }

  return records
}

/**
 * Writes the `{ "observations": [ … ] }` shape `loadNativeMatrixObservations()` accepts. The
 * file is rewritten per run, so the walk always reads the run that just finished rather than
 * an accumulation of stale cells.
 */
export async function writeNativeMatrixObservations(
  records: readonly NativeMatrixObservation[],
  file = nativeObservationsFile(),
): Promise<string> {
  await writeTextFile(file, `${JSON.stringify({ observations: records }, null, 2)}\n`)
  return file
}
