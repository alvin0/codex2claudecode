// `bun run test:native:verify` — the capability matrix walk (Requirement 24.9).
//
// Prints one row per route × upstream × Provider_Feature: the declared policy, whether a
// notice was observed, and whether the observation matches the declaration. Writes
// `.native-transcripts/matrix.md` (or `$NATIVE_TRANSCRIPT_DIR/matrix.md`) so the table pastes
// straight into a Run_Record.
//
// Exit code is the check: non-zero only when a row's observation contradicts its declaration.
// A cell that cannot be resolved yet — no declared policy, or no recorded run — is reported as
// `unresolved` and does not fail the walk, so this stays runnable at every point in the plan.
//
// The row logic lives in `test/native/verify-matrix.ts` next to the case registry it reads,
// so the harness property test asserts on the same code this script prints.
import { writeTextFile } from "../src/core/bun-fs"
import { makeDir } from "../src/core/paths"

import {
  loadNativeMatrixObservations,
  loadNativeMatrixSource,
  nativeMatrixFile,
  nativeMatrixOutputDir,
  nativeObservationsFile,
} from "../test/native/matrix-source"
import {
  buildNativeMatrixRows,
  hasMatrixContradiction,
  renderNativeMatrixConsole,
  renderNativeMatrixMarkdown,
  summarizeNativeMatrixRows,
} from "../test/native/verify-matrix"

const source = await loadNativeMatrixSource()
const observed = await loadNativeMatrixObservations(nativeObservationsFile())
const notes = [...source.notes, ...observed.notes]

const rows = buildNativeMatrixRows({ source, observations: observed.observations })
const summary = summarizeNativeMatrixRows(rows)

console.log(renderNativeMatrixConsole(rows))
console.log("")
console.log(`feature vocabulary: ${source.featureSource} (${source.features.length} features)`)
console.log(`observations: ${observed.source}`)
if (notes.length) {
  console.log("")
  for (const note of notes) console.log(`note: ${stripBackticks(note)}`)
}

const outputFile = nativeMatrixFile()
await makeDir(nativeMatrixOutputDir())
await writeTextFile(
  outputFile,
  renderNativeMatrixMarkdown({ rows, source: { ...source, notes }, observationSource: observed.source }),
)

console.log("")
console.log(
  `${summary.total} rows — ${summary.match} match, ${summary.mismatch} mismatch, ${summary.unresolved} unresolved`,
)
console.log(`wrote ${outputFile}`)

if (hasMatrixContradiction(rows)) {
  console.error("")
  for (const row of rows.filter((candidate) => candidate.verdict === "mismatch")) {
    console.error(`MISMATCH ${row.route} ${row.upstream} ${row.feature}: ${row.reason}`)
  }
  console.error(`\nnative verify failed: ${summary.mismatch} row(s) contradict their declared policy.`)
  process.exitCode = 1
} else if (summary.match === 0) {
  console.log("native verify passed: zero contradictions, and no cell is resolved yet.")
} else {
  console.log(`native verify passed: zero contradictions across ${summary.match} resolved cell(s).`)
}

function stripBackticks(value: string) {
  return value.split("`").join("")
}

export {}
