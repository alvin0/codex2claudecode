// Feature: native-api-mode, Property 9: Upstream modules carry no inbound-shaped notice text.
//
// For any file under `src/upstream/`, the file contains none of the inbound notice marker
// strings, so notice wording lives only in `src/inbound/claude/notice.ts` and
// `src/inbound/openai/notice.ts` (Requirement 9.5).
//
// ## Why this lives here and not as a row in `test/architecture.property.test.ts`
//
// Task 5.3 built `FORBIDDEN_TOKEN_SCOPES` so a later grep-style invariant is a table row
// rather than a new block of logic, and that is the right default. Three things make this
// property the exception:
//
//  1. **The markers are imported, not spelled.** Requirement 9.5 is about *wording*, and the
//     wording's source of truth is `CLAUDE_NOTICE_MARKER` / `OPENAI_NOTICE_MARKER`. A
//     `ForbiddenTokenScope` row carries literal `tokens: readonly string[]`, so expressing it
//     there means either restating the marker — which lets the marker change while this check
//     keeps grepping the stale string, the exact failure mode that separates an invariant from
//     a hardcoded grep — or importing two inbound provider modules into the architecture
//     harness, which is deliberately filesystem-only and provider-agnostic today.
//  2. **The row shape does not fit.** This property has an inverse half (the wording lives in
//     *exactly* the two owner modules) and a per-owner rot guard. `ForbiddenTokenScope` has no
//     place to put either; it models "these files must not contain these tokens" only.
//  3. **`FORBIDDEN_TOKEN_SCOPES` is not open in practice.** Its consuming clause asserts
//     `expect(scopeFiles.length).toBe(2)`, so a new row fails that test body until the number
//     is edited. Adding a row is not the zero-edit extension its doc comment advertises.
//
// Keeping Property 9 in its own file also keeps it individually identifiable: `bun test
// test/upstream/notice-boundary.property.test.ts` runs exactly this numbered property, and a
// failure names Requirement 9.5 rather than surfacing inside a Property 2 clause.
//
// ## The pre-existing upstream warning is not a collision
//
// `src/upstream/kiro/payload.ts` owns `trimNoticeText()`, whose text opens with
// `"[Gateway warning] …"`, and `src/upstream/kiro/index.ts` carries it as `payloadTrimWarning`
// (`src/upstream/kiro/parse.ts` threads it as `prefaceText`). That is upstream-owned
// payload-trimming text and predates this feature. It does **not** contain either inbound
// marker: the character after `gateway` is a space, not `]`, so it matches neither
// case-sensitively nor case-insensitively. Checked rather than assumed — the last clause below
// asserts it over generated trim notices, so a future edit that reshapes that prefix into the
// inbound marker fails here instead of quietly making upstream speak inbound wording.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_FeatureNotice } from "../../src/core/canonical"
import { PROVIDER_FEATURES } from "../../src/core/provider-capabilities"
import { CLAUDE_NOTICE_MARKER, renderClaudeFeatureWarning } from "../../src/inbound/claude/notice"
import { OPENAI_NOTICE_MARKER, renderOpenAIFeatureWarning } from "../../src/inbound/openai/notice"
import { trimNoticeText, type KiroPayloadTrimNotice } from "../../src/upstream/kiro/payload"
import { mkdir, mkdtemp, path, readFile, rm, writeFile } from "../helpers"

// ---------------------------------------------------------------------------
// The markers, derived from their owning modules
// ---------------------------------------------------------------------------

interface MarkerSource {
  /** The exported binding that owns this wording. */
  exportName: string
  /** Root-relative path of the module that owns it. */
  owner: string
  /** The value as the owner defines it today — imported, never restated. */
  value: string
}

/**
 * Every inbound notice marker, each read from the module that defines it. Nothing below
 * writes the marker text out, so changing a marker changes what this test greps for in the
 * same commit; it cannot leave the check pointed at a string that no longer exists.
 *
 * A third inbound provider that renders notices adds a row here and to
 * {@link NOTICE_WORDING_OWNERS}.
 */
const NOTICE_MARKER_SOURCES: readonly MarkerSource[] = [
  { exportName: "CLAUDE_NOTICE_MARKER", owner: "src/inbound/claude/notice.ts", value: CLAUDE_NOTICE_MARKER },
  { exportName: "OPENAI_NOTICE_MARKER", owner: "src/inbound/openai/notice.ts", value: OPENAI_NOTICE_MARKER },
]

interface NoticeMarker {
  value: string
  /** Modules permitted to contain this value. */
  owners: readonly string[]
}

/**
 * The distinct marker values. The two markers are the same string today on purpose (one
 * harness parser for both wire formats), so scanning is keyed by value; should they ever
 * diverge, this list grows and every clause below covers both without an edit.
 */
const DISTINCT_MARKERS: readonly NoticeMarker[] = [...new Set(NOTICE_MARKER_SOURCES.map((source) => source.value))].map(
  (value) => ({ value, owners: NOTICE_MARKER_SOURCES.filter((source) => source.value === value).map((source) => source.owner) }),
)

/**
 * The only `src/` files allowed to contain a marker value (the inverse half of Requirement
 * 9.5: the wording lives in exactly these modules). Placement code such as
 * `src/inbound/claude/response.ts` imports the constant instead of spelling it, so it does not
 * belong here.
 */
const NOTICE_WORDING_OWNERS: readonly string[] = NOTICE_MARKER_SOURCES.map((source) => source.owner)

/** Directory whose files must be free of every marker. */
const UPSTREAM_GLOB = "src/upstream/**/*.{ts,tsx}"
const SRC_GLOB = "src/**/*.{ts,tsx}"

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

interface MarkerOccurrence {
  file: string
  marker: string
  /** 1-based line number, so a failure message points at the offending line. */
  line: number
  /** The offending line, trimmed and clipped. */
  text: string
  /** True when the marker matched exactly; false when it matched only case-insensitively. */
  caseSensitive: boolean
}

/**
 * Every marker occurrence in one file's content, line by line.
 *
 * Two passes, same reasoning as the provider-identifier clause of Property 2. The
 * case-sensitive pass is Requirement 9.5's own verification. The case-insensitive pass is
 * stricter and catches a re-cased leak (`[GATEWAY]`) that the exact pass would miss; both are
 * reported, distinguished by `caseSensitive`, so a failure says which kind it found.
 */
export function findMarkerOccurrences(
  file: string,
  content: string,
  markers: readonly NoticeMarker[],
): MarkerOccurrence[] {
  const occurrences: MarkerOccurrence[] = []
  const lines = content.split("\n")
  for (const [index, line] of lines.entries()) {
    const lowered = line.toLowerCase()
    for (const marker of markers) {
      const exact = line.includes(marker.value)
      const loose = lowered.includes(marker.value.toLowerCase())
      if (!exact && !loose) continue
      occurrences.push({
        file,
        marker: marker.value,
        line: index + 1,
        text: line.trim().slice(0, 160),
        caseSensitive: exact,
      })
    }
  }
  return occurrences
}

async function scanFiles(pattern: string, root: string): Promise<string[]> {
  const files: string[] = []
  for await (const file of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
    files.push(file.replace(/\\/g, "/"))
  }
  return files.sort()
}

interface ScanResult {
  files: readonly string[]
  occurrences: readonly MarkerOccurrence[]
}

/**
 * Run the detector over every file matching `pattern` beneath `root`.
 *
 * `root` is a parameter rather than `process.cwd()` so the same walk — glob, read, detect —
 * can be pointed at a scratch tree outside the repository. That is how the clause below proves
 * the walk fires on a violation without ever putting one in `src/`.
 */
async function scanForMarkers(root: string, pattern: string): Promise<ScanResult> {
  const files = await scanFiles(pattern, root)
  const occurrences: MarkerOccurrence[] = []
  for (const file of files) {
    const content = await readFile(path.join(root, file), "utf8")
    occurrences.push(...findMarkerOccurrences(file, content, DISTINCT_MARKERS))
  }
  return { files, occurrences }
}

function describeOccurrence(occurrence: MarkerOccurrence): string {
  const kind = occurrence.caseSensitive ? "exact" : "case-variant"
  return `${occurrence.file}:${occurrence.line} carries the ${kind} marker "${occurrence.marker}" — ${occurrence.text}`
}

/**
 * Check `check` against every member of a closed finite set.
 *
 * The exhaustive loop is the assertion: the files under `src/upstream/` are a closed finite
 * set, so visiting all of them is strictly stronger than sampling. The fast-check pass over
 * the same set follows the repo convention of at least 100 iterations per property and shrinks
 * to a minimal counterexample; it adds no coverage the loop lacks, and it is not where this
 * property's generative power lives — that is the two synthesis clauses below.
 */
function assertForEvery<T>(items: readonly T[], check: (item: T) => void): void {
  for (const item of items) check(item)
  if (items.length === 0) return
  fc.assert(
    fc.property(fc.constantFrom(...items), (item) => {
      check(item)
    }),
    { numRuns: 100 },
  )
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const DETAIL_CHARS = [..."abcdefghijklmnopqrstuvwxyz0123456789 .,=-"]
/** Source-like filler that provably contains no bracket, so a clean control cannot false-positive. */
const FILLER_CHARS = [..."abcdefghijklmnopqrstuvwxyz0123456789 ={}()\";.,/*-_"]

function textArb(chars: readonly string[], maxLength: number) {
  return fc
    .array(fc.constantFrom(...chars), { minLength: 1, maxLength })
    .map((parts) => parts.join(""))
}

/** Non-empty detail text, mirroring the construction obligation the notice renderers assume. */
const detailArb = textArb(DETAIL_CHARS, 40).map((value) => value.trim() || "detail")

/** Multi-line filler with no `[` or `]` anywhere, so the clean control is guaranteed marker-free. */
const fillerArb = fc.array(textArb(FILLER_CHARS, 60), { minLength: 0, maxLength: 4 }).map((lines) => lines.join("\n"))

/** At least one `degrade` notice, so the renderers return a non-empty warning segment. */
const degradeNoticesArb = fc.array(
  fc.record({
    feature: fc.constantFrom(...PROVIDER_FEATURES),
    policy: fc.constant("degrade" as const),
    detail: detailArb,
  }),
  { minLength: 1, maxLength: 5 },
) as fc.Arbitrary<Canonical_FeatureNotice[]>

const RENDERERS = [
  { owner: "src/inbound/claude/notice.ts", render: renderClaudeFeatureWarning },
  { owner: "src/inbound/openai/notice.ts", render: renderOpenAIFeatureWarning },
] as const

const trimNoticeArb: fc.Arbitrary<KiroPayloadTrimNotice> = fc.record({
  originalSize: fc.integer({ min: 0, max: 5_000_000 }),
  finalSize: fc.integer({ min: 0, max: 5_000_000 }),
  limit: fc.integer({ min: 1, max: 5_000_000 }),
  removedHistoryEntries: fc.integer({ min: 0, max: 500 }),
  remainingHistoryEntries: fc.integer({ min: 0, max: 500 }),
})

// ---------------------------------------------------------------------------
// Property 9
// ---------------------------------------------------------------------------

describe("Upstream notice-string boundary", () => {
  /**
   * The markers this test greps for are the ones the owners define. Without this clause the
   * import above could drift into a stale constant that no owner file spells any more, and the
   * scan would keep passing against wording nothing produces.
   *
   * **Validates: Requirement 9.5**
   */
  test("Feature: native-api-mode, Property 9: each marker is defined by the module it is attributed to", async () => {
    expect(NOTICE_MARKER_SOURCES.length).toBeGreaterThan(0)

    for (const source of NOTICE_MARKER_SOURCES) {
      expect(source.value.length).toBeGreaterThan(0)
      const content = await readFile(path.join(process.cwd(), source.owner), "utf8")
      // The binding exists in the owner, and the value the import produced is the value written there.
      expect(content).toContain(`export const ${source.exportName} =`)
      expect(content).toContain(`export const ${source.exportName} = ${JSON.stringify(source.value)}`)
    }

    expect(DISTINCT_MARKERS.length).toBeGreaterThan(0)
    expect(DISTINCT_MARKERS.flatMap((marker) => marker.owners).sort()).toEqual([...NOTICE_WORDING_OWNERS].sort())
  })

  /**
   * Clause 1 — no file under `src/upstream/` contains an inbound notice marker. Exhaustive
   * over the closed set of upstream files × distinct markers.
   *
   * **Validates: Requirement 9.5**
   */
  test("Feature: native-api-mode, Property 9: no file under src/upstream/ contains an inbound notice marker", async () => {
    const { files, occurrences } = await scanForMarkers(process.cwd(), UPSTREAM_GLOB)

    // Anti-vacuity: a broken glob must fail loudly rather than pass by scanning nothing.
    expect(files.length).toBeGreaterThan(10)
    expect(files).toContain("src/upstream/kiro/payload.ts")
    expect(files).toContain("src/upstream/kiro/index.ts")
    expect(files).toContain("src/upstream/kiro/parse.ts")

    const cases = files.flatMap((file) => DISTINCT_MARKERS.map((marker) => ({ file, marker })))
    const byFile = new Map<string, MarkerOccurrence[]>()
    for (const occurrence of occurrences) {
      const list = byFile.get(occurrence.file)
      if (list) list.push(occurrence)
      else byFile.set(occurrence.file, [occurrence])
    }

    assertForEvery(cases, ({ file, marker }) => {
      const hits = (byFile.get(file) ?? []).filter((occurrence) => occurrence.marker === marker.value)
      if (hits.length > 0) {
        throw new Error(
          `Inbound notice wording leaked into an upstream module (Requirement 9.5):\n` +
            hits.map((hit) => `  ${describeOccurrence(hit)}`).join("\n") +
            `\n  Notice wording belongs to ${marker.owners.join(" and ")}. An upstream provider emits a` +
            ` Canonical_FeatureNotice and lets the inbound provider render it.` +
            `\n  All ${occurrences.length} occurrence(s):\n` +
            occurrences.map((all) => `    ${describeOccurrence(all)}`).join("\n"),
        )
      }
    })

    expect(occurrences.map(describeOccurrence)).toEqual([])
  })

  /**
   * Inverse direction — the wording lives in *exactly* the owner modules. Requirement 9.5
   * names those two files as the home of the wording, and a marker appearing at a third `src/`
   * location is the same drift viewed from the other side: a second copy of the wording that
   * can fall out of sync with the constant, and (if it lands in `src/core/`) provider-shaped
   * text in a provider-agnostic layer. Asserted rather than left implicit, because clause 1
   * alone would let a copy settle anywhere outside `src/upstream/`.
   *
   * **Validates: Requirement 9.5**
   */
  test("Feature: native-api-mode, Property 9: notice wording lives in exactly the inbound notice modules", async () => {
    const { files, occurrences } = await scanForMarkers(process.cwd(), SRC_GLOB)
    expect(files.length).toBeGreaterThan(50)

    const carriers = [...new Set(occurrences.map((occurrence) => occurrence.file))].sort()
    const unexpected = carriers.filter((file) => !NOTICE_WORDING_OWNERS.includes(file))
    if (unexpected.length > 0) {
      throw new Error(
        `Notice wording appears outside its owning modules (Requirement 9.5):\n` +
          occurrences
            .filter((occurrence) => unexpected.includes(occurrence.file))
            .map((occurrence) => `  ${describeOccurrence(occurrence)}`)
            .join("\n") +
          `\n  Import the marker constant from ${NOTICE_WORDING_OWNERS.join(" or ")} instead of restating the text.`,
      )
    }
    expect(carriers).toEqual([...NOTICE_WORDING_OWNERS].sort())

    // Rot guard: every declared owner really does carry its own marker, so this list cannot
    // outlive a renamed or deleted notice module and keep the assertion above satisfied.
    assertForEvery(NOTICE_MARKER_SOURCES, (source) => {
      const hits = occurrences.filter((occurrence) => occurrence.file === source.owner && occurrence.marker === source.value)
      if (hits.length === 0) {
        throw new Error(
          `Stale owner entry: ${source.owner} no longer contains the marker it is credited with.\n` +
            `  Update NOTICE_MARKER_SOURCES to name the module that owns the wording now.`,
        )
      }
    })
  })

  /**
   * Detector correctness — a *synthesized* leak is always flagged and marker-free filler never
   * is. A grep that passes proves nothing about whether it can fail, so the leak is not a
   * hand-written string: it is whatever the real renderers produce for generated notice lists,
   * embedded in generated source-like filler. Nothing is written into `src/`.
   *
   * The re-cased variant is checked in the same pass, which is what gives the case-insensitive
   * half of the detector its power rather than leaving it decorative.
   *
   * **Validates: Requirement 9.5**
   */
  test("Feature: native-api-mode, Property 9: the detector flags any synthesized notice text and passes marker-free filler", () => {
    fc.assert(
      fc.property(
        degradeNoticesArb,
        fc.constantFrom(...RENDERERS),
        fillerArb,
        fillerArb,
        (notices, renderer, before, after) => {
          const warning = renderer.render(notices)
          expect(warning.length).toBeGreaterThan(0)

          // Control: the filler alphabet excludes brackets, so a clean file reports nothing.
          const clean = `${before}\n${after}`
          expect(findMarkerOccurrences("scratch.ts", clean, DISTINCT_MARKERS)).toEqual([])

          // A leak spelled exactly as the renderer spells it.
          const leaked = `${before}\nconst warning = ${JSON.stringify(warning)}\n${after}`
          const exactHits = findMarkerOccurrences("scratch.ts", leaked, DISTINCT_MARKERS)
          expect(exactHits.length).toBeGreaterThan(0)
          expect(exactHits.some((hit) => hit.caseSensitive)).toBe(true)

          // A re-cased leak: missed by a case-sensitive grep, caught by the second pass.
          const recased = `${before}\nconst warning = ${JSON.stringify(warning.toUpperCase())}\n${after}`
          const looseHits = findMarkerOccurrences("scratch.ts", recased, DISTINCT_MARKERS)
          expect(looseHits.length).toBeGreaterThan(0)
          // In uppercased content an exact match is possible only for a marker that is itself
          // already uppercase, so every other hit must be reported as a case variant. Derived
          // from the markers rather than hardcoded, so an all-caps marker would not break it.
          const alreadyUppercase = DISTINCT_MARKERS.filter((marker) => marker.value === marker.value.toUpperCase()).map(
            (marker) => marker.value,
          )
          expect(looseHits.filter((hit) => hit.caseSensitive).every((hit) => alreadyUppercase.includes(hit.marker))).toBe(true)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * Walk correctness — the whole file-scan path (glob, read, detect, report) fires on a real
   * upstream file that has gained notice text. Proven on a scratch copy in a temp directory
   * outside the repository: the same `scanForMarkers` used by clause 1 is pointed at that tree,
   * so a violation is demonstrated without ever introducing one into `src/`.
   *
   * The clean copy of the same file is scanned first, in the same harness, so the pass is not
   * an artifact of the temp tree.
   *
   * **Validates: Requirement 9.5**
   */
  test("Feature: native-api-mode, Property 9: the file walk flags a scratch copy carrying notice text", async () => {
    const source = "src/upstream/kiro/payload.ts"
    const original = await readFile(path.join(process.cwd(), source), "utf8")
    const root = await mkdtemp("notice-boundary-")

    try {
      const target = path.join(root, source)
      await mkdir(path.dirname(target), { recursive: true })

      // Clean copy: the walk finds nothing, exactly as it does against the real tree.
      await writeFile(target, original)
      const clean = await scanForMarkers(root, UPSTREAM_GLOB)
      expect(clean.files).toEqual([source])
      expect(clean.occurrences).toEqual([])

      // Same file, plus the wording an inbound renderer owns.
      const leak = renderClaudeFeatureWarning([{ feature: "sampling", policy: "degrade", detail: "temperature was not sent upstream" }])
      await writeFile(target, `${original}\nconst leaked = ${JSON.stringify(leak)}\n`)
      const dirty = await scanForMarkers(root, UPSTREAM_GLOB)
      expect(dirty.files).toEqual([source])
      expect(dirty.occurrences.length).toBe(DISTINCT_MARKERS.length)
      expect(dirty.occurrences.every((occurrence) => occurrence.file === source && occurrence.caseSensitive)).toBe(true)
      // The report points at the appended line, not at the file as a whole.
      expect(dirty.occurrences[0]!.line).toBe(original.split("\n").length + 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * The pre-existing upstream warning stays on the upstream side of the boundary.
   * `trimNoticeText()` is payload-trimming text owned by `src/upstream/kiro/payload.ts`, and it
   * opens with a bracketed prefix of its own. Generated over the numbers it interpolates, its
   * rendered text carries no inbound marker — so the two warning vocabularies are provably
   * distinct rather than assumed to be.
   *
   * **Validates: Requirement 9.5**
   */
  test("Feature: native-api-mode, Property 9: the upstream payload-trim warning carries no inbound marker", () => {
    fc.assert(
      fc.property(trimNoticeArb, (notice) => {
        const text = trimNoticeText(notice)
        expect(text.length).toBeGreaterThan(0)
        const hits = findMarkerOccurrences("src/upstream/kiro/payload.ts", text, DISTINCT_MARKERS)
        if (hits.length > 0) {
          throw new Error(
            `The upstream payload-trim warning now carries inbound notice wording (Requirement 9.5):\n` +
              hits.map((hit) => `  ${describeOccurrence(hit)}`).join("\n"),
          )
        }
      }),
      { numRuns: 200 },
    )
  })
})
