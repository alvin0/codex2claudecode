// Role: declare the 14 Live_Cases (Requirement 24.1) and nothing else. The registry in
// `cases.ts` decides what runs, `run-case.ts` decides how, and this file only wires the two
// together behind the skip gate — so adding or renaming a case never touches this file.
//
// The describe name is exactly `live native API smoke test`, which the default `test` script
// pattern `^(?!.*live (Codex|Kiro|native API) smoke test)` filters out. With `NATIVE_LIVE`
// unset, continuous integration runs zero live cases and stays green without credentials
// (Requirements 24.2, 26.8).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { NATIVE_LIVE_CASES } from "./cases"
import {
  hasConnectedAccount,
  hasNativeCredentialFile,
  protectedCredentialFingerprints,
  type CredentialFingerprint,
} from "./credentials"
import { isEnablingValue } from "./gateway"
import { writeNativeMatrixObservations } from "./matrix-records"
import { DEFAULT_NATIVE_CASE_TIMEOUT_MS, runNativeLiveCase } from "./run-case"
import type { NativeMatrixObservation } from "./verify-matrix"

describe("live native API smoke test", () => {
  const requested = isEnablingValue(process.env.NATIVE_LIVE)

  // The design snippet reads `isEnablingValue(process.env.NATIVE_LIVE) && hasConnectedAccount()`.
  // `hasConnectedAccount()` is async, and a Promise is always truthy, so that expression as
  // written would enable the suite on a machine with no account at all. The sync half of the
  // same question decides here — `hasNativeCredentialFile()`, which is the `existsSync` check
  // of `test/live.test.ts` applied to the connected-account candidates — and each case narrows
  // to its own upstream with `await hasConnectedAccount(liveCase.upstream)` inside the body,
  // where awaiting is allowed. Requirement 24.2 asks exactly this: skip when `NATIVE_LIVE` is
  // unset or when no connected account credential file exists.
  const enabled = requested && hasNativeCredentialFile()
  const testOrSkip = enabled ? test : test.skip
  const reason = requested ? "no connected account credential file found" : "NATIVE_LIVE is unset"
  const suffix = enabled ? "" : ` (skipped: ${reason})`

  const records: NativeMatrixObservation[] = []
  let protectedBefore: CredentialFingerprint[] = []

  beforeAll(async () => {
    if (!enabled) return
    protectedBefore = await protectedCredentialFingerprints()
  })

  afterAll(async () => {
    // Written for `bun run test:native:verify` to read (Requirement 24.9). Skipped when the
    // run produced nothing, so a skipped suite never overwrites a real run's observations.
    if (!enabled || !records.length) return
    await writeNativeMatrixObservations(records)
  })

  for (const liveCase of NATIVE_LIVE_CASES) {
    testOrSkip(
      `${liveCase.id}: ${liveCase.title}${suffix}`,
      async () => {
        if (!(await hasConnectedAccount(liveCase.upstream))) {
          // Loud rather than silently green: a case that cannot reach its upstream must not
          // be counted as passing, because the baseline record in Requirements 24.5 and 24.6
          // is a count of red and green cases.
          throw new Error(
            `Case ${liveCase.id} needs a connected ${liveCase.upstream} account; the harness exercises kiro and codex (Requirement 24.12)`,
          )
        }

        const result = await runNativeLiveCase(liveCase)
        records.push(...result.matrixObservations)

        const failures = result.failures.map((failure) => `${failure.id} — ${failure.description}: ${failure.detail}`)
        if (failures.length) console.error(`${liveCase.id} transcript: ${result.transcript.path}`)
        expect(failures).toEqual([])
      },
      DEFAULT_NATIVE_CASE_TIMEOUT_MS,
    )
  }

  // Not one of the 14 cases: the guarantee that running them changed no real credential file
  // (Requirement 24.11). Declared last so it observes the state after every case has run.
  testOrSkip(`leaves the protected credential files untouched${suffix}`, async () => {
    expect(await protectedCredentialFingerprints()).toEqual(protectedBefore)
  })
})
