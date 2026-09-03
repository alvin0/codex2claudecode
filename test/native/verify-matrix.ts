// Role: pure row building and rendering for the capability matrix walk (Requirement 24.9).
// No I/O and no dynamic imports live here, so `scripts/native-verify.ts` and the harness
// property test (Property 36) can drive the same logic from opposite directions.
//
// The walk is total by construction: every route × upstream × Provider_Feature triple
// produces exactly one row. A cell whose declared policy or observation is not available
// yet reads `unresolved` — never an invented policy. Only a row whose observation
// contradicts its declaration is a failure, and that is the signal that would have caught
// the `inferenceConfig` mistake.

import { NATIVE_LIVE_CASES } from "./cases"
import type { NativeLiveCase, NativeRoutePath, NativeUpstreamKind } from "./types"

/** The four policies of the design's `FeaturePolicy` vocabulary. */
export const MATRIX_POLICIES = ["native", "emulate", "degrade", "reject"] as const

export type MatrixPolicy = (typeof MATRIX_POLICIES)[number]

/**
 * The 11 `ProviderFeature` members the design plans for `src/core/provider-capabilities.ts`,
 * in declaration order. Used only while core exports no `PROVIDER_FEATURES`; once it does,
 * `matrix-source.ts` walks the real vocabulary and this list becomes the fallback that the
 * source note names explicitly.
 */
export const PLANNED_PROVIDER_FEATURES = [
  "sampling",
  "stopSequences",
  "thinkingBudget",
  "systemPrompt",
  "promptCache",
  "strictToolSchema",
  "toolChoiceForced",
  "structuredOutput",
  "webSearch",
  "webFetch",
  "mcpToolset",
] as const

/** Both inbound routes the harness exercises, matching `NativeRoutePath`. */
export const NATIVE_MATRIX_ROUTES: readonly NativeRoutePath[] = ["/v1/messages", "/v1/responses"]

/** Both connected upstreams (Requirement 24.12). Copilot is declaration-only, so it has no row. */
export const NATIVE_MATRIX_UPSTREAMS: readonly NativeUpstreamKind[] = ["kiro", "codex"]

/** Where the walked feature vocabulary came from. */
export type MatrixFeatureSource = "core" | "planned"

/** One upstream's declared policies, as far as they can be read today. */
export interface MatrixDeclaration {
  /** Feature name to declared policy. A feature absent from the map is unresolved, not native. */
  features: Readonly<Record<string, MatrixPolicy>>
  /** Human-readable origin, printed so a reader knows what they are looking at. */
  source: string
}

export interface NativeMatrixSource {
  features: readonly string[]
  featureSource: MatrixFeatureSource
  declarations: Readonly<Partial<Record<NativeUpstreamKind, MatrixDeclaration>>>
  /** Honest degradation notes: every cell the walk could not resolve says why. */
  notes: readonly string[]
}

/**
 * One recorded observation for a triple, produced by a live run. `noticeObserved` is the
 * column Requirement 24.9 asks for; `requested` distinguishes "no notice because the
 * feature was never sent" from "no notice although the feature was sent".
 */
export interface NativeMatrixObservation {
  route: NativeRoutePath
  upstream: NativeUpstreamKind
  feature: string
  noticeObserved: boolean
  requested?: boolean
  caseId?: string
  detail?: string
}

export type MatrixVerdict = "match" | "mismatch" | "unresolved"

export interface NativeMatrixRow {
  route: NativeRoutePath
  upstream: NativeUpstreamKind
  feature: string
  /** Undefined until the upstream declares this cell. */
  declaredPolicy?: MatrixPolicy
  declarationSource?: string
  /** Undefined when no run recorded this triple. */
  noticeObserved?: boolean
  verdict: MatrixVerdict
  /** Why the verdict reads the way it does. Always non-empty. */
  reason: string
  /** Registry case ids that exercise this triple, for pasting context into a Run_Record. */
  caseIds: readonly string[]
}

export interface NativeMatrixSummary {
  total: number
  match: number
  mismatch: number
  unresolved: number
}

export interface BuildNativeMatrixRowsInput {
  source: NativeMatrixSource
  observations?: readonly NativeMatrixObservation[]
  /** Overridable so a test can drive the walk without the 14-case registry. */
  cases?: readonly NativeLiveCase[]
}

/** Stable identity of a matrix cell — one row per key, no key twice. */
export function matrixRowKey(cell: { route: string; upstream: string; feature: string }) {
  return `${cell.route}|${cell.upstream}|${cell.feature}`
}

export function buildNativeMatrixRows(input: BuildNativeMatrixRowsInput): NativeMatrixRow[] {
  const cases = input.cases ?? NATIVE_LIVE_CASES
  const observed = indexObservations(input.observations ?? [])
  const rows: NativeMatrixRow[] = []

  for (const route of NATIVE_MATRIX_ROUTES) {
    for (const upstream of NATIVE_MATRIX_UPSTREAMS) {
      const declaration = input.source.declarations[upstream]
      for (const feature of input.source.features) {
        const key = matrixRowKey({ route, upstream, feature })
        rows.push(
          buildRow({
            route,
            upstream,
            feature,
            declaration,
            observation: observed.get(key),
            caseIds: coveringCaseIds(cases, route, upstream, feature),
          }),
        )
      }
    }
  }

  return rows
}

interface BuildRowInput {
  route: NativeRoutePath
  upstream: NativeUpstreamKind
  feature: string
  declaration?: MatrixDeclaration
  observation?: MergedObservation
  caseIds: readonly string[]
}

function buildRow(input: BuildRowInput): NativeMatrixRow {
  const declaredPolicy = input.declaration?.features[input.feature]
  const base = {
    route: input.route,
    upstream: input.upstream,
    feature: input.feature,
    ...(declaredPolicy ? { declaredPolicy, declarationSource: input.declaration?.source } : {}),
    ...(input.observation ? { noticeObserved: input.observation.noticeObserved } : {}),
    caseIds: input.caseIds,
  }

  if (!declaredPolicy) {
    return { ...base, verdict: "unresolved", reason: declarationGap(input.declaration, input.upstream, input.feature) }
  }

  if (!input.observation) {
    return { ...base, verdict: "unresolved", reason: "no recorded observation for this cell" }
  }

  const expectsNotice = declaredPolicy === "degrade" || declaredPolicy === "emulate"
  const { noticeObserved, requested, detail } = input.observation

  if (noticeObserved && !expectsNotice) {
    return {
      ...base,
      verdict: "mismatch",
      reason: appendDetail(`declared ${declaredPolicy} but a notice was observed`, detail),
    }
  }

  if (!noticeObserved && expectsNotice) {
    if (requested === false) {
      return { ...base, verdict: "unresolved", reason: `declared ${declaredPolicy}; the recorded run never sent this feature` }
    }
    return {
      ...base,
      verdict: "mismatch",
      reason: appendDetail(`declared ${declaredPolicy} but no notice was observed`, detail),
    }
  }

  const observedText = noticeObserved ? "a notice was observed" : "no notice was observed"
  return { ...base, verdict: "match", reason: appendDetail(`declared ${declaredPolicy} and ${observedText}`, detail) }
}

function declarationGap(declaration: MatrixDeclaration | undefined, upstream: string, feature: string) {
  if (!declaration) return `${upstream} declares no capability feature map yet`
  return `${upstream} declares no policy for ${feature}`
}

function appendDetail(reason: string, detail?: string) {
  return detail ? `${reason} — ${detail}` : reason
}

interface MergedObservation {
  noticeObserved: boolean
  requested?: boolean
  detail?: string
}

/**
 * Several cases can observe one triple, so observations fold: a notice observed anywhere
 * counts as observed, and the cell is "requested" unless every record says it was not.
 */
function indexObservations(observations: readonly NativeMatrixObservation[]) {
  const merged = new Map<string, MergedObservation>()

  for (const observation of observations) {
    const key = matrixRowKey(observation)
    const previous = merged.get(key)
    const details = [previous?.detail, observation.detail].filter((value): value is string => Boolean(value))
    merged.set(key, {
      noticeObserved: Boolean(previous?.noticeObserved) || observation.noticeObserved,
      requested: mergeRequested(previous?.requested, observation.requested),
      ...(details.length ? { detail: [...new Set(details)].join("; ") } : {}),
    })
  }

  return merged
}

function mergeRequested(previous: boolean | undefined, next: boolean | undefined) {
  if (previous === true || next === true) return true
  if (previous === undefined) return next
  if (next === undefined) return previous
  return previous || next
}

/** Registry cases on this route and upstream whose assertion ids name the feature. */
function coveringCaseIds(
  cases: readonly NativeLiveCase[],
  route: NativeRoutePath,
  upstream: NativeUpstreamKind,
  feature: string,
): string[] {
  const needle = feature.toLowerCase()
  return cases
    .filter((liveCase) => liveCase.route === route && liveCase.upstream === upstream)
    .filter((liveCase) => liveCase.assertions.some((assertion) => assertion.id.toLowerCase().includes(needle)))
    .map((liveCase) => liveCase.id)
}

export function summarizeNativeMatrixRows(rows: readonly NativeMatrixRow[]): NativeMatrixSummary {
  return {
    total: rows.length,
    match: rows.filter((row) => row.verdict === "match").length,
    mismatch: rows.filter((row) => row.verdict === "mismatch").length,
    unresolved: rows.filter((row) => row.verdict === "unresolved").length,
  }
}

/** The exit-code decision: a contradiction between observation and declaration fails the walk. */
export function hasMatrixContradiction(rows: readonly NativeMatrixRow[]) {
  return rows.some((row) => row.verdict === "mismatch")
}

const POLICY_PLACEHOLDER = "unresolved"
const NOTICE_PLACEHOLDER = "not observed"

function policyCell(row: NativeMatrixRow) {
  return row.declaredPolicy ?? POLICY_PLACEHOLDER
}

function noticeCell(row: NativeMatrixRow) {
  if (row.noticeObserved === undefined) return NOTICE_PLACEHOLDER
  return row.noticeObserved ? "yes" : "no"
}

/** Aligned console table. One line per row, so the walk reads top to bottom in a terminal. */
export function renderNativeMatrixConsole(rows: readonly NativeMatrixRow[]): string {
  const header = ["ROUTE", "UPSTREAM", "FEATURE", "DECLARED", "NOTICE", "OUTCOME", "REASON"]
  const body = rows.map((row) => [
    row.route,
    row.upstream,
    row.feature,
    policyCell(row),
    noticeCell(row),
    row.verdict === "mismatch" ? "MISMATCH" : row.verdict,
    row.reason,
  ])

  const widths = header.map((_, column) =>
    Math.max(header[column].length, ...body.map((cells) => cells[column].length), 0),
  )

  return [header, ...body]
    .map((cells) => cells.map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]))).join("  "))
    .join("\n")
}

export interface RenderNativeMatrixMarkdownInput {
  rows: readonly NativeMatrixRow[]
  source: NativeMatrixSource
  /** Injected so a test can render a byte-stable document. */
  generatedAt?: string
  /** Where the observations came from, or why there are none. */
  observationSource?: string
}

/**
 * `.native-transcripts/matrix.md` — a self-contained section that pastes into a Run_Record
 * without editing: header, provenance, counts, notes, then the table.
 */
export function renderNativeMatrixMarkdown(input: RenderNativeMatrixMarkdownInput): string {
  const { rows, source } = input
  const summary = summarizeNativeMatrixRows(rows)
  const lines: string[] = []

  lines.push("## native capability matrix walk")
  lines.push("")
  lines.push(`- generated: ${input.generatedAt ?? new Date().toISOString()}`)
  lines.push(`- feature vocabulary: ${source.featureSource} (${source.features.length} features)`)
  lines.push(`- observations: ${input.observationSource ?? "none recorded"}`)
  lines.push(
    `- rows: ${summary.total} — ${summary.match} match, ${summary.mismatch} mismatch, ${summary.unresolved} unresolved`,
  )
  lines.push(`- outcome: ${summary.mismatch ? "FAIL" : "pass"}`)
  lines.push("")

  if (source.notes.length) {
    lines.push("### unresolved sources")
    lines.push("")
    for (const note of source.notes) lines.push(`- ${note}`)
    lines.push("")
  }

  lines.push("| route | upstream | feature | declared policy | notice observed | outcome | reason | cases |")
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |")
  for (const row of rows) {
    lines.push(
      `| \`${row.route}\` | ${row.upstream} | ${row.feature} | ${policyCell(row)} | ${noticeCell(row)} | ${row.verdict} | ${escapeCell(row.reason)} | ${row.caseIds.length ? row.caseIds.map((id) => `\`${id}\``).join(", ") : "—"} |`,
    )
  }
  lines.push("")

  return lines.join("\n")
}

function escapeCell(value: string) {
  return value.split("|").join("\\|")
}
