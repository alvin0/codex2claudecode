// Offline coverage for the matrix walk `scripts/native-verify.ts` prints (Requirement 24.9).
// Everything here is pure over injected declarations and observations, so no live run and no
// capability module from a later task is needed.
import { describe, expect, test } from "bun:test"

import { mkdtemp, rm, writeFile } from "../helpers"
import { joinPath } from "../../src/core/paths"

import {
  loadNativeMatrixObservations,
  loadNativeMatrixSource,
  nativeMatrixFile,
  nativeMatrixOutputDir,
  nativeObservationsFile,
  DEFAULT_NATIVE_TRANSCRIPT_DIR,
} from "./matrix-source"
import {
  buildNativeMatrixRows,
  hasMatrixContradiction,
  matrixRowKey,
  renderNativeMatrixConsole,
  renderNativeMatrixMarkdown,
  summarizeNativeMatrixRows,
  MATRIX_POLICIES,
  NATIVE_MATRIX_ROUTES,
  NATIVE_MATRIX_UPSTREAMS,
  PLANNED_PROVIDER_FEATURES,
  type MatrixPolicy,
  type NativeMatrixObservation,
  type NativeMatrixSource,
} from "./verify-matrix"

function source(overrides: Partial<NativeMatrixSource> = {}): NativeMatrixSource {
  return {
    features: [...PLANNED_PROVIDER_FEATURES],
    featureSource: "planned",
    declarations: {},
    notes: [],
    ...overrides,
  }
}

function declaring(upstream: "kiro" | "codex", features: Record<string, MatrixPolicy>): NativeMatrixSource {
  return source({ declarations: { [upstream]: { features, source: "TEST_CAPABILITIES.features" } } })
}

function rowFor(rows: ReturnType<typeof buildNativeMatrixRows>, feature: string, upstream = "kiro", route = "/v1/messages") {
  const found = rows.find((row) => row.feature === feature && row.upstream === upstream && row.route === route)
  if (!found) throw new Error(`no row for ${route} ${upstream} ${feature}`)
  return found
}

function observation(overrides: Partial<NativeMatrixObservation> = {}): NativeMatrixObservation {
  return { route: "/v1/messages", upstream: "kiro", feature: "sampling", noticeObserved: false, ...overrides }
}

describe("native matrix walk row building", () => {
  test("produces exactly one row per route × upstream × feature triple", () => {
    const rows = buildNativeMatrixRows({ source: source() })
    const expected = NATIVE_MATRIX_ROUTES.length * NATIVE_MATRIX_UPSTREAMS.length * PLANNED_PROVIDER_FEATURES.length

    expect(rows).toHaveLength(expected)
    expect(new Set(rows.map(matrixRowKey)).size).toBe(expected)

    for (const route of NATIVE_MATRIX_ROUTES) {
      for (const upstream of NATIVE_MATRIX_UPSTREAMS) {
        for (const feature of PLANNED_PROVIDER_FEATURES) {
          const matching = rows.filter((row) => row.route === route && row.upstream === upstream && row.feature === feature)
          expect(matching).toHaveLength(1)
        }
      }
    }
  })

  test("every row names a feature, a declared policy column, and a notice observation", () => {
    const rows = buildNativeMatrixRows({
      source: declaring("kiro", { sampling: "reject" }),
      observations: [observation({ noticeObserved: true })],
    })

    for (const row of rows) {
      expect(row.feature.length).toBeGreaterThan(0)
      expect(row.reason.length).toBeGreaterThan(0)
      expect(["match", "mismatch", "unresolved"]).toContain(row.verdict)
      if (row.declaredPolicy) expect(MATRIX_POLICIES).toContain(row.declaredPolicy)
    }
  })

  test("an undeclared cell is unresolved rather than an invented policy", () => {
    const rows = buildNativeMatrixRows({ source: source() })
    const row = rowFor(rows, "sampling")

    expect(row.declaredPolicy).toBeUndefined()
    expect(row.verdict).toBe("unresolved")
    expect(row.reason).toContain("no capability feature map")
    expect(hasMatrixContradiction(rows)).toBe(false)
  })

  test("a declared cell with no recorded run is unresolved", () => {
    const rows = buildNativeMatrixRows({ source: declaring("kiro", { sampling: "degrade" }) })
    const row = rowFor(rows, "sampling")

    expect(row.declaredPolicy).toBe("degrade")
    expect(row.noticeObserved).toBeUndefined()
    expect(row.verdict).toBe("unresolved")
    expect(row.reason).toContain("no recorded observation")
  })

  test("a notice observed against a native declaration is a mismatch", () => {
    const rows = buildNativeMatrixRows({
      source: declaring("codex", { sampling: "native" }),
      observations: [observation({ upstream: "codex", route: "/v1/responses", noticeObserved: true })],
    })
    const row = rowFor(rows, "sampling", "codex", "/v1/responses")

    expect(row.verdict).toBe("mismatch")
    expect(row.reason).toContain("declared native but a notice was observed")
    expect(hasMatrixContradiction(rows)).toBe(true)
    expect(summarizeNativeMatrixRows(rows).mismatch).toBe(1)
  })

  test("an exercised degrade cell with no notice is a mismatch", () => {
    const rows = buildNativeMatrixRows({
      source: declaring("kiro", { sampling: "degrade" }),
      observations: [observation({ requested: true, noticeObserved: false })],
    })

    expect(rowFor(rows, "sampling").verdict).toBe("mismatch")
    expect(rowFor(rows, "sampling").reason).toContain("no notice was observed")
  })

  test("a degrade cell the run never exercised is unresolved, not a mismatch", () => {
    const rows = buildNativeMatrixRows({
      source: declaring("kiro", { sampling: "degrade" }),
      observations: [observation({ requested: false, noticeObserved: false })],
    })

    expect(rowFor(rows, "sampling").verdict).toBe("unresolved")
    expect(hasMatrixContradiction(rows)).toBe(false)
  })

  test("declaration and observation agreeing is a match for every policy", () => {
    for (const policy of MATRIX_POLICIES) {
      const expectsNotice = policy === "degrade" || policy === "emulate"
      const rows = buildNativeMatrixRows({
        source: declaring("kiro", { sampling: policy }),
        observations: [observation({ requested: true, noticeObserved: expectsNotice })],
      })

      expect(rowFor(rows, "sampling").verdict).toBe("match")
      expect(hasMatrixContradiction(rows)).toBe(false)
    }
  })

  test("several observations of one triple fold into that single row", () => {
    const rows = buildNativeMatrixRows({
      source: declaring("kiro", { sampling: "degrade" }),
      observations: [
        observation({ caseId: "sampling-declared", noticeObserved: false, requested: true, detail: "first run" }),
        observation({ caseId: "no-silent-drop", noticeObserved: true, requested: true, detail: "second run" }),
      ],
    })

    const matching = rows.filter((row) => row.feature === "sampling" && row.upstream === "kiro" && row.route === "/v1/messages")
    expect(matching).toHaveLength(1)
    expect(matching[0].verdict).toBe("match")
    expect(matching[0].reason).toContain("first run; second run")
  })

  test("registry cases that exercise a cell are named on its row", () => {
    const rows = buildNativeMatrixRows({ source: source() })
    expect(rowFor(rows, "sampling", "kiro", "/v1/messages").caseIds).toEqual(["sampling-declared", "no-silent-drop"])
    expect(rowFor(rows, "promptCache", "kiro", "/v1/messages").caseIds).toEqual([])
  })
})

describe("native matrix rendering", () => {
  test("the console table carries a line per row plus a header", () => {
    const rows = buildNativeMatrixRows({ source: source() })
    const lines = renderNativeMatrixConsole(rows).split("\n")

    expect(lines).toHaveLength(rows.length + 1)
    expect(lines[0]).toContain("DECLARED")
    expect(lines[0]).toContain("NOTICE")
    expect(lines[0]).toContain("OUTCOME")
  })

  test("matrix.md holds one table row per triple with the three required columns", () => {
    const walked = source({ notes: ["core exports no PROVIDER_FEATURES yet"] })
    const rows = buildNativeMatrixRows({
      source: walked,
      observations: [observation({ noticeObserved: true })],
    })
    const markdown = renderNativeMatrixMarkdown({
      rows,
      source: walked,
      generatedAt: "2026-01-01T00:00:00.000Z",
      observationSource: "1 record(s)",
    })

    expect(markdown).toContain("## native capability matrix walk")
    expect(markdown).toContain("- generated: 2026-01-01T00:00:00.000Z")
    expect(markdown).toContain("core exports no PROVIDER_FEATURES yet")
    expect(markdown).toContain("| route | upstream | feature | declared policy | notice observed | outcome | reason | cases |")

    for (const row of rows) {
      const line = markdown
        .split("\n")
        .find((candidate) => candidate.startsWith(`| \`${row.route}\` | ${row.upstream} | ${row.feature} |`))
      expect(line).toBeDefined()
      expect(line).toContain(row.declaredPolicy ?? "unresolved")
      expect(line).toContain(row.verdict)
    }
    expect(markdown).toContain("notice observed")
    expect(markdown).toContain("| yes |")
  })

  test("rendering the same rows twice is byte-identical when the timestamp is fixed", () => {
    const walked = source()
    const rows = buildNativeMatrixRows({ source: walked })
    const render = () => renderNativeMatrixMarkdown({ rows, source: walked, generatedAt: "2026-01-01T00:00:00.000Z" })

    expect(render()).toBe(render())
  })
})

describe("native matrix source resolution", () => {
  test("degrades honestly while the capability layer is still missing", async () => {
    const resolved = await loadNativeMatrixSource()

    expect(resolved.features.length).toBeGreaterThanOrEqual(PLANNED_PROVIDER_FEATURES.length)
    if (resolved.featureSource === "planned") {
      expect(resolved.features).toEqual([...PLANNED_PROVIDER_FEATURES])
      expect(resolved.notes.join("\n")).toContain("PROVIDER_FEATURES")
    }
    for (const upstream of NATIVE_MATRIX_UPSTREAMS) {
      const declaration = resolved.declarations[upstream]
      if (declaration) continue
      expect(resolved.notes.join("\n")).toContain(upstream)
    }
    expect(hasMatrixContradiction(buildNativeMatrixRows({ source: resolved }))).toBe(false)
  })

  test("resolves the output paths from the environment with a default", () => {
    expect(nativeMatrixOutputDir({})).toBe(DEFAULT_NATIVE_TRANSCRIPT_DIR)
    expect(nativeMatrixOutputDir({ NATIVE_TRANSCRIPT_DIR: "  " })).toBe(DEFAULT_NATIVE_TRANSCRIPT_DIR)
    // joinPath emits the host separator, so the expectations are built the same way.
    expect(nativeMatrixFile({ NATIVE_TRANSCRIPT_DIR: "/tmp/native" })).toBe(joinPath("/tmp/native", "matrix.md"))
    expect(nativeObservationsFile({})).toBe(joinPath(DEFAULT_NATIVE_TRANSCRIPT_DIR, "observations.json"))
  })
})

describe("native matrix observation loading", () => {
  test("an absent file means not measured, never a match", async () => {
    const loaded = await loadNativeMatrixObservations("/definitely/missing/observations.json")

    expect(loaded.observations).toEqual([])
    expect(loaded.source).toContain("none recorded")
    expect(loaded.notes).toEqual([])
  })

  test("reads records from both accepted shapes and reports unusable entries", async () => {
    const dir = await mkdtemp("native-matrix-")
    try {
      const bare = joinPath(dir, "bare.json")
      await writeFile(bare, JSON.stringify([{ route: "/v1/messages", upstream: "kiro", feature: "sampling", noticeObserved: true }]))
      const bareLoaded = await loadNativeMatrixObservations(bare)
      expect(bareLoaded.observations).toEqual([
        { route: "/v1/messages", upstream: "kiro", feature: "sampling", noticeObserved: true },
      ])

      const wrapped = joinPath(dir, "wrapped.json")
      await writeFile(
        wrapped,
        JSON.stringify({
          observations: [
            { route: "/v1/responses", upstream: "codex", feature: "sampling", noticeObserved: false, requested: true },
            { route: "/nope", upstream: "kiro", feature: "sampling", noticeObserved: false },
          ],
        }),
      )
      const wrappedLoaded = await loadNativeMatrixObservations(wrapped)
      expect(wrappedLoaded.observations).toHaveLength(1)
      expect(wrappedLoaded.observations[0].requested).toBe(true)
      expect(wrappedLoaded.notes).toHaveLength(1)

      const broken = joinPath(dir, "broken.json")
      await writeFile(broken, "{ not json")
      const brokenLoaded = await loadNativeMatrixObservations(broken)
      expect(brokenLoaded.observations).toEqual([])
      expect(brokenLoaded.notes[0]).toContain("not valid JSON")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
