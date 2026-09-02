// Offline property coverage for the four harness invariants of task 1.7 (Properties 35–38).
// Nothing here makes a live call, reads a real account file, or reaches the internet: the
// credential property writes its own fixture credential file into a temp directory and the
// gateway property answers every upstream request from a stubbed `globalThis.fetch`.
//
// Where an invariant is defined over a fixed finite domain — the 14 case ids, the 44 matrix
// cells of the planned vocabulary, the 7 transcript section headers — the test enumerates the
// domain exhaustively **and** drives a generated version of the same claim. Exhaustive
// enumeration is stronger than sampling on a closed set; the generated half is what proves
// the invariant is a property of the code rather than of the current table contents.
import { afterEach, describe, expect, test } from "bun:test"
import fc from "fast-check"

import { bunPath as path, tempDir } from "../../src/core/paths"
import { writeTextFile } from "../../src/core/bun-fs"
import type { RequestLogEntry } from "../../src/core/types"
import { mkdtemp, rm } from "../helpers"

import {
  NATIVE_LIVE_CASES,
  NATIVE_LIVE_CASE_IDS,
  NATIVE_MCP_SERVER_URL_PLACEHOLDER,
  nativeBaselineCaseIds,
  nativeLiveCase,
  resolveNativeCaseBody,
  type NativeLiveCaseId,
} from "./cases"
import { copyNativeCredentials, credentialFingerprint, protectedCredentialFingerprints } from "./credentials"
import { startNativeGateway } from "./gateway"
import { detectKiroFrames } from "./kiro-frames"
import { isLoopbackMcpUrl, startNativeMcpFixture } from "./mcp-fixture"
import {
  DEFAULT_NATIVE_TRANSCRIPT_LIMIT,
  NATIVE_TRANSCRIPT_SECTIONS,
  limitTranscriptSection,
  nativeTranscriptPath,
  nativeTranscriptTruncationMarker,
  renderNativeTranscript,
  type NativeTranscriptInput,
} from "./transcript"
import type { NativeLiveObservation } from "./types"
import {
  MATRIX_POLICIES,
  NATIVE_MATRIX_ROUTES,
  NATIVE_MATRIX_UPSTREAMS,
  PLANNED_PROVIDER_FEATURES,
  buildNativeMatrixRows,
  matrixRowKey,
  renderNativeMatrixConsole,
  renderNativeMatrixMarkdown,
  type MatrixPolicy,
  type NativeMatrixObservation,
  type NativeMatrixSource,
} from "./verify-matrix"

const ENCODER = new TextEncoder()
const originalFetch = globalThis.fetch
const tempDirs: string[] = []

afterEach(async () => {
  globalThis.fetch = originalFetch
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function byteLength(text: string) {
  return ENCODER.encode(text).length
}

const LOWER = "abcdefghijklmnopqrstuvwxyz".split("")

/** Lowercase identifiers, short enough that `redactDebugText` never collapses them as a token. */
function identifierArb(minLength = 3, maxLength = 12) {
  return fc.array(fc.constantFrom(...LOWER), { minLength, maxLength }).map((chars) => chars.join(""))
}

/**
 * Single-line text with no `#`, `"`, `\`, or newline. Those exclusions keep a generated value
 * from forging a section header, a JSON escape, or a frame boundary, so a failure means the
 * invariant broke rather than that the generator wrote adversarial markup.
 */
function safeTextArb(maxLength = 16) {
  return fc
    .array(fc.constantFrom(...LOWER, ..."0123456789 -_.:=".split("")), { minLength: 1, maxLength })
    .map((chars) => chars.join(""))
}

// ---------------------------------------------------------------------------
// Property 35: the live case registry is exactly the fourteen named cases
// ---------------------------------------------------------------------------

describe("native harness registry properties", () => {
  test("Property 35: the live case registry is exactly the fourteen named cases", () => {
    // Exhaustive half: the id set is closed and finite, so enumerate it rather than sample.
    const ids = NATIVE_LIVE_CASES.map((liveCase) => liveCase.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(ids)).toEqual(new Set(NATIVE_LIVE_CASE_IDS))
    expect(NATIVE_LIVE_CASE_IDS).toHaveLength(14)
    expect(new Set(NATIVE_LIVE_CASE_IDS).size).toBe(14)

    // Generated half: for any name in the set, the registry holds exactly one case under it,
    // that case answers to its own id, and its baseline puts it in exactly one of the two
    // recorded baseline lists.
    fc.assert(
      fc.property(fc.constantFrom(...NATIVE_LIVE_CASE_IDS), (id) => {
        const matching = NATIVE_LIVE_CASES.filter((liveCase) => liveCase.id === id)
        expect(matching).toHaveLength(1)
        expect(nativeLiveCase(id).id).toBe(id)

        const red = nativeBaselineCaseIds("red")
        const green = nativeBaselineCaseIds("green")
        expect(red.includes(id) !== green.includes(id)).toBe(true)
        expect(red.length + green.length).toBe(NATIVE_LIVE_CASE_IDS.length)
      }),
      { numRuns: 100 },
    )

    // Closure: a name outside the set is not silently accepted as a fifteenth case.
    fc.assert(
      fc.property(identifierArb(1, 24), fc.constantFrom("", "-x", "2"), (stem, suffix) => {
        const candidate = `${stem}${suffix}`
        fc.pre(!(NATIVE_LIVE_CASE_IDS as readonly string[]).includes(candidate))
        expect(NATIVE_LIVE_CASES.some((liveCase) => liveCase.id === candidate)).toBe(false)
        expect(() => nativeLiveCase(candidate as NativeLiveCaseId)).toThrow(/Unknown native live case/)
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 36: the verification table covers every matrix cell
// ---------------------------------------------------------------------------

function matrixSourceArb() {
  return fc
    .record({
      features: fc.uniqueArray(identifierArb(3, 10), { minLength: 1, maxLength: 6 }),
      declaredKiro: fc.dictionary(identifierArb(3, 10), fc.constantFrom(...MATRIX_POLICIES), { maxKeys: 4 }),
      declaredCodex: fc.dictionary(identifierArb(3, 10), fc.constantFrom(...MATRIX_POLICIES), { maxKeys: 4 }),
      declareKiro: fc.boolean(),
      declareCodex: fc.boolean(),
      notes: fc.array(safeTextArb(20), { maxLength: 2 }),
    })
    .map(({ features, declaredKiro, declaredCodex, declareKiro, declareCodex, notes }) => {
      // Declarations are drawn independently of the vocabulary on purpose: a real
      // `capabilities.ts` can declare a feature the walk does not know and can omit one it does.
      const pick = (declared: Record<string, MatrixPolicy>, subset: readonly string[]) => ({
        features: { ...declared, ...Object.fromEntries(subset.map((feature, index) => [feature, MATRIX_POLICIES[index % MATRIX_POLICIES.length]])) },
        source: "GENERATED_CAPABILITIES.features",
      })

      const source: NativeMatrixSource = {
        features,
        featureSource: "planned",
        declarations: {
          ...(declareKiro ? { kiro: pick(declaredKiro, features.slice(0, Math.ceil(features.length / 2))) } : {}),
          ...(declareCodex ? { codex: pick(declaredCodex, features.slice(1)) } : {}),
        },
        notes,
      }
      return source
    })
}

function matrixObservationsArb(source: NativeMatrixSource) {
  return fc.array(
    fc.record({
      route: fc.constantFrom(...NATIVE_MATRIX_ROUTES),
      upstream: fc.constantFrom(...NATIVE_MATRIX_UPSTREAMS),
      feature: fc.constantFrom(...source.features),
      noticeObserved: fc.boolean(),
      requested: fc.boolean(),
    }),
    { maxLength: 6 },
  ) as fc.Arbitrary<NativeMatrixObservation[]>
}

describe("native matrix walk properties", () => {
  test("Property 36: the verification table covers every matrix cell", () => {
    // Exhaustive half: today's walk is 2 routes × 2 upstreams × 11 planned features = 44 cells.
    // The set is closed, so every cell is checked rather than sampled.
    const exhaustive = buildNativeMatrixRows({
      source: { features: [...PLANNED_PROVIDER_FEATURES], featureSource: "planned", declarations: {}, notes: [] },
    })
    expect(exhaustive).toHaveLength(NATIVE_MATRIX_ROUTES.length * NATIVE_MATRIX_UPSTREAMS.length * PLANNED_PROVIDER_FEATURES.length)
    for (const route of NATIVE_MATRIX_ROUTES) {
      for (const upstream of NATIVE_MATRIX_UPSTREAMS) {
        for (const feature of PLANNED_PROVIDER_FEATURES) {
          expect(exhaustive.filter((row) => row.route === route && row.upstream === upstream && row.feature === feature)).toHaveLength(1)
        }
      }
    }

    // Generated half: the coverage claim holds for any vocabulary, any declaration subset, and
    // any recorded observations — not only for the eleven features the plan happens to name.
    fc.assert(
      fc.property(
        matrixSourceArb().chain((source) => fc.tuple(fc.constant(source), matrixObservationsArb(source))),
        ([source, observations]) => {
          const rows = buildNativeMatrixRows({ source, observations })
          const expected = NATIVE_MATRIX_ROUTES.length * NATIVE_MATRIX_UPSTREAMS.length * source.features.length

          // One row per triple, no triple twice, no triple missing.
          expect(rows).toHaveLength(expected)
          expect(new Set(rows.map(matrixRowKey)).size).toBe(expected)
          for (const route of NATIVE_MATRIX_ROUTES) {
            for (const upstream of NATIVE_MATRIX_UPSTREAMS) {
              for (const feature of source.features) {
                const key = matrixRowKey({ route, upstream, feature })
                expect(rows.filter((row) => matrixRowKey(row) === key)).toHaveLength(1)
              }
            }
          }

          const markdown = renderNativeMatrixMarkdown({ rows, source, generatedAt: "2026-01-01T00:00:00.000Z" })
          const consoleLines = renderNativeMatrixConsole(rows).split("\n")
          expect(consoleLines).toHaveLength(rows.length + 1)

          rows.forEach((row, index) => {
            // Every row names the feature, states a declared policy, and states a notice
            // observation. A cell nothing declared reads `unresolved`, never an invented policy.
            expect(row.feature).toBe(row.feature.trim())
            expect(row.feature.length).toBeGreaterThan(0)
            expect(row.reason.length).toBeGreaterThan(0)
            expect(["match", "mismatch", "unresolved"]).toContain(row.verdict)

            const declared = source.declarations[row.upstream]?.features[row.feature]
            expect(row.declaredPolicy).toBe(declared)
            if (row.declaredPolicy) expect(MATRIX_POLICIES).toContain(row.declaredPolicy)

            const policyCell = row.declaredPolicy ?? "unresolved"
            const noticeCell = row.noticeObserved === undefined ? "not observed" : row.noticeObserved ? "yes" : "no"

            // The markdown row is located by its exact `route | upstream | feature |` prefix and
            // then compared cell by cell, so a value landing in the wrong column is a failure
            // rather than something a substring search can absorb.
            const line = markdown
              .split("\n")
              .find((candidate) => candidate.startsWith(`| \`${row.route}\` | ${row.upstream} | ${row.feature} | `))
            expect(line).toBeDefined()
            const markdownCells = (line ?? "").split("|").map((cell) => cell.trim())
            expect(markdownCells.slice(1, 7)).toEqual([
              `\`${row.route}\``,
              row.upstream,
              row.feature,
              policyCell,
              noticeCell,
              row.verdict,
            ])

            // The console table is positional: line `index + 1` is this row's line (line 0 is
            // the header). Columns are compared by position and by exact value rather than by
            // substring search, because the free-text REASON column legitimately contains the
            // other columns' vocabulary — "declares" contains a feature named `are`, "observed"
            // contains `ved`, "cell" contains `ell` — so a substring search can select a
            // different row's line and then compare the wrong cells.
            const consoleLine = consoleLines[index + 1]
            expect(consoleLine).toBeDefined()
            const consoleCells = consoleLine.split(/ {2,}/)
            expect(consoleCells.slice(0, 6)).toEqual([
              row.route,
              row.upstream,
              row.feature,
              policyCell,
              noticeCell,
              row.verdict === "mismatch" ? "MISMATCH" : row.verdict,
            ])
            // The reason is the last, unpadded column, so it closes the line verbatim.
            expect(consoleLine.endsWith(row.reason)).toBe(true)
          })

          // The three required columns exist even when every cell is unresolved.
          expect(markdown).toContain("| route | upstream | feature | declared policy | notice observed | outcome | reason | cases |")
          expect(markdown).toContain(`- rows: ${expected}`)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 37: the harness never mutates source credentials
// ---------------------------------------------------------------------------

/** A standalone Kiro auth file, the shape `copyNativeCredentials` treats as a source account. */
async function writeSourceCredential(secret: { access: string; refresh: string; region: string }) {
  const dir = await mkdtemp(path.join(tempDir(), "native-prop-source-"))
  tempDirs.push(dir)
  const file = path.join(dir, "kiro-auth-token.json")
  await writeTextFile(
    file,
    `${JSON.stringify({
      accessToken: secret.access,
      refreshToken: secret.refresh,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      region: secret.region,
      sourceAuthFile: "~/.aws/sso/cache/kiro-auth-token.json",
      sourceAccountIndex: 0,
    })}\n`,
  )
  return file
}

/** Answers every upstream call the runtime makes, so no packet leaves the machine. */
function stubUpstreamFetch() {
  globalThis.fetch = ((url: unknown) => {
    const target = String(url)
    if (target.includes("/ListAvailableModels")) {
      return Promise.resolve(Response.json({ models: [{ modelId: "claude-sonnet-4.5" }] }))
    }
    if (target.includes("/generateAssistantResponse")) {
      return Promise.resolve(new Response('{"content":"ok"}{"stop":true}', { status: 200 }))
    }
    return Promise.resolve(Response.json({ ok: true }))
  }) as unknown as typeof fetch
}

describe("native harness credential properties", () => {
  test("Property 37: the harness never mutates source credentials", async () => {
    // The two files Requirement 24.11 names must be untouched by this whole test, whether or
    // not they exist on the machine running it.
    const protectedBefore = await protectedCredentialFingerprints()

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          access: identifierArb(8, 20),
          refresh: identifierArb(8, 20),
          region: fc.constantFrom("us-east-1", "eu-west-1", "ap-northeast-1"),
        }),
        fc.constantFrom<Record<string, string>>({}, { NATIVE_STRICT: "1" }, { NATIVE_PASSTHROUGH: "1", NATIVE_MCP_EMULATION: "1" }),
        fc.constantFrom(...NATIVE_LIVE_CASES.filter((liveCase) => liveCase.upstream === "kiro").map((liveCase) => liveCase.id)),
        async (secret, flags, caseId) => {
          const source = await writeSourceCredential(secret)
          const before = await credentialFingerprint(source)
          expect(before.exists).toBe(true)
          expect(before.sha256).toBeDefined()

          stubUpstreamFetch()
          const credentials = await copyNativeCredentials("kiro", { sourceAuthFile: source })
          // The copy carries the secret; the source keeps its write-back links.
          expect(credentials.sourceAuthFile).toBe(source)
          expect(credentials.authFile).not.toBe(source)

          const gateway = await startNativeGateway({ upstream: "kiro", flags, credentials })
          try {
            const body = resolveNativeCaseBody(nativeLiveCase(caseId), { mcpServerUrl: "http://127.0.0.1:1/mcp" })
            const response = await originalFetch(`${gateway.url}/v1/messages`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
            await response.text()
          } finally {
            await gateway.stop()
            await credentials.cleanup()
          }

          // Content hash, size, and mtime are all unchanged: the run read the source and
          // never opened it for writing (Requirement 24.11).
          expect(await credentialFingerprint(source)).toEqual(before)
        },
      ),
      { numRuns: 100 },
    )

    expect(await protectedCredentialFingerprints()).toEqual(protectedBefore)
  })

  test("Property 37: every MCP fixture URL resolves to loopback", async () => {
    // Exhaustive half: the only two cases that carry an MCP server URL are the two MCP cases,
    // and a real fixture binds loopback.
    const fixture = await startNativeMcpFixture()
    try {
      expect(isLoopbackMcpUrl(fixture.url)).toBe(true)
      expect(fixture.hostname).toBe("127.0.0.1")

      const withPlaceholder = NATIVE_LIVE_CASES.filter((liveCase) =>
        JSON.stringify(liveCase.body).includes(NATIVE_MCP_SERVER_URL_PLACEHOLDER),
      )
      expect(withPlaceholder.map((liveCase) => liveCase.id)).toEqual(["mcp-toolset-kiro", "mcp-approval-reject"])

      for (const liveCase of NATIVE_LIVE_CASES) {
        const resolved = JSON.stringify(resolveNativeCaseBody(liveCase, { mcpServerUrl: fixture.url }))
        for (const url of resolved.match(/https?:\/\/[^"\s]+/g) ?? []) {
          // A case body may name a public URL as prompt text (`web-fetch-emulate` does), but
          // never as an `mcp_servers` endpoint.
          const isMcpEndpoint = (liveCase.body.mcp_servers as unknown[] | undefined) !== undefined
          if (isMcpEndpoint && url.includes("/mcp")) expect(isLoopbackMcpUrl(url)).toBe(true)
        }
        if (liveCase.requiresMcpFixture) {
          const servers = JSON.parse(resolved).mcp_servers as Array<{ url: string }>
          expect(servers.length).toBeGreaterThan(0)
          for (const server of servers) expect(isLoopbackMcpUrl(server.url)).toBe(true)
        }
      }
    } finally {
      await fixture.stop()
    }

    // Generated half: the predicate the guarantee rests on accepts every loopback form and
    // rejects every routable host, so it is a real check rather than a constant `true`.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 65_535 }),
        identifierArb(1, 8),
        fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 1, max: 254 })),
        (port, segment, [b, c, d]) => {
          for (const host of ["127.0.0.1", "localhost", `127.${b}.${c}.${d}`, "[::1]"]) {
            expect(isLoopbackMcpUrl(`http://${host}:${port}/${segment}`)).toBe(true)
          }
          for (const host of ["example.com", `${segment}.example.org`, "0.0.0.0", `10.${b}.${c}.${d}`, `192.168.${c}.${d}`, "169.254.169.254"]) {
            expect(isLoopbackMcpUrl(`http://${host}:${port}/${segment}`)).toBe(false)
          }
          expect(isLoopbackMcpUrl(`not a url ${segment}`)).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 38: transcripts are structurally complete, bounded, and diffable
// ---------------------------------------------------------------------------

const KIRO_CASE_IDS = NATIVE_LIVE_CASES.filter((liveCase) => liveCase.upstream === "kiro").map((liveCase) => liveCase.id)

/** One EventStream frame in the shape `onResponseBodyChunk` delivers it: already UTF-8 decoded. */
function eventStreamFrame(eventType: string, payload: string) {
  const prelude = `\u0000\u0000\u0000${String.fromCharCode(payload.length % 256)}\u0000\u0000\u0000\u000b\u0011\u0022\u0033\u0044`
  const header = `\u000b:event-type\u0007\u0000${String.fromCharCode(eventType.length)}${eventType}`
  // U+FFFD stands where the CRC32 trailer was before the decode replaced it (design decision D5).
  return `${prelude}${header}${payload}\ufffd\ufffd`
}

interface CapturedInput {
  caseId: NativeLiveCaseId
  status: number
  marker: string
  payloads: string[]
  clientBody: string
  upstreamRequestBody: string
  responseBody: string
}

function capturedInputArb() {
  return fc
    .record({
      caseId: fc.constantFrom(...KIRO_CASE_IDS),
      status: fc.constantFrom(200, 400, 500),
      marker: identifierArb(4, 10),
      payloadTexts: fc.array(safeTextArb(12), { minLength: 1, maxLength: 6 }),
      clientText: safeTextArb(24),
    })
    .map<CapturedInput>(({ caseId, status, marker, payloadTexts, clientText }) => {
      const payloads = payloadTexts.map((text) => `{"content":"${text}"}`)
      return {
        caseId,
        status,
        marker,
        payloads,
        clientBody: `{"content":[{"type":"text","text":"${clientText}"}]}`,
        upstreamRequestBody: JSON.stringify({ conversationState: { probe: marker } }),
        responseBody: payloads.map((payload) => eventStreamFrame("assistantResponseEvent", payload)).join(""),
      }
    })
}

function observationFor(
  captured: CapturedInput,
  volatile: { logId: string; at: string; durationMs: number; requestId: string },
): NativeLiveObservation {
  const proxy: NonNullable<RequestLogEntry["proxy"]> = {
    label: "Kiro messages",
    method: "POST",
    target: "https://upstream.example/generateAssistantResponse",
    status: captured.status,
    durationMs: volatile.durationMs,
    error: "-",
    requestBody: captured.upstreamRequestBody,
    responseBody: captured.responseBody,
  }

  return {
    caseId: captured.caseId,
    status: captured.status,
    headers: { "content-type": "application/json", "x-request-id": volatile.requestId, date: volatile.at },
    clientBody: captured.clientBody,
    clientJson: JSON.parse(captured.clientBody),
    clientEvents: [],
    upstreamRequestCount: 1,
    requestLog: {
      id: volatile.logId,
      at: volatile.at,
      method: "POST",
      path: "/v1/messages",
      status: captured.status,
      durationMs: volatile.durationMs,
      error: "-",
      requestHeaders: {},
      proxy,
    },
  }
}

function transcriptInputFor(captured: CapturedInput, volatile: Parameters<typeof observationFor>[1], limit: number): NativeTranscriptInput {
  return {
    liveCase: nativeLiveCase(captured.caseId),
    observation: observationFor(captured, volatile),
    volatile: { "gateway port": volatile.durationMs + 40_000 },
    limit,
  }
}

const STABLE_VOLATILE = { logId: "log-1", at: "2024-01-01T00:00:00.000Z", durationMs: 11, requestId: "req-1" }
const OTHER_VOLATILE = { logId: "log-2", at: "2025-06-02T03:04:05.000Z", durationMs: 97, requestId: "req-2" }

/**
 * Body of each section, keyed by header. Throws when a header is missing or out of order, so
 * the completeness and ordering claims are checked by construction.
 */
function transcriptSectionBodies(content: string): Record<string, string> {
  const bodies: Record<string, string> = {}
  let cursor = 0

  NATIVE_TRANSCRIPT_SECTIONS.forEach((header, index) => {
    const marker = `\n${header}\n\n`
    const start = content.indexOf(marker, cursor)
    if (start < 0) throw new Error(`transcript is missing ${header} at or after byte ${cursor}`)
    if (content.indexOf(marker, start + 1) >= 0) throw new Error(`transcript repeats ${header}`)

    const bodyStart = start + marker.length
    const next = NATIVE_TRANSCRIPT_SECTIONS[index + 1]
    const end = next ? content.indexOf(`\n${next}\n\n`, bodyStart) : content.length
    if (end < 0) throw new Error(`transcript places ${next} before ${header}`)

    bodies[header] = content.slice(bodyStart, end).replace(/\n+$/, "")
    cursor = bodyStart
  })

  return bodies
}

const TRUNCATION_PREFIX = "\n...[truncated: "

describe("native transcript properties", () => {
  test("Property 38: transcripts are structurally complete and record all three bodies", () => {
    fc.assert(
      fc.property(capturedInputArb(), (captured) => {
        const content = renderNativeTranscript(transcriptInputFor(captured, STABLE_VOLATILE, DEFAULT_NATIVE_TRANSCRIPT_LIMIT))

        // Every section header, exactly once, in the fixed order. `transcriptSectionBodies`
        // throws on a missing, repeated, or out-of-order header.
        const bodies = transcriptSectionBodies(content)
        expect(Object.keys(bodies)).toEqual([...NATIVE_TRANSCRIPT_SECTIONS])

        // The upstream request body, the raw upstream response, and the client response are
        // each recorded (Requirement 25.1).
        expect(bodies["## upstream request"]).toContain(captured.marker)
        expect(bodies["## upstream request"]).toContain("upstream request count: 1")
        expect(bodies["## client response"]).toContain(`status: ${captured.status}`)
        expect(bodies["## client response"]).toContain(captured.clientBody)

        // One frame entry per detected Kiro frame boundary, each carrying its payload
        // (Requirement 25.2).
        const detected = detectKiroFrames(captured.responseBody)
        expect(detected).toHaveLength(captured.payloads.length)
        const raw = bodies["## upstream response (raw)"]
        expect(raw).toContain(`frames detected: ${detected.length}`)
        expect(raw.match(/^### frame \d{3} /gm) ?? []).toHaveLength(detected.length)
        detected.forEach((frame, index) => {
          expect(frame.payload).toBe(captured.payloads[index])
          expect(raw).toContain(`### frame ${String(index + 1).padStart(3, "0")}`)
          expect(raw).toContain(frame.payload)
        })
      }),
      { numRuns: 100 },
    )
  })

  test("Property 38: every transcript section stays within the configured limit", () => {
    fc.assert(
      fc.property(capturedInputArb(), fc.integer({ min: 48, max: 4096 }), (captured, limit) => {
        const content = renderNativeTranscript(transcriptInputFor(captured, STABLE_VOLATILE, limit))
        const bodies = transcriptSectionBodies(content)

        for (const [header, body] of Object.entries(bodies)) {
          const cut = body.lastIndexOf(TRUNCATION_PREFIX)
          if (cut < 0) {
            expect(byteLength(body), `${header} exceeded the limit without a truncation marker`).toBeLessThanOrEqual(limit)
            continue
          }
          // A truncated section keeps at most `limit` bytes and then names the omitted count.
          const kept = body.slice(0, cut)
          expect(byteLength(kept), `${header} kept more than the limit`).toBeLessThanOrEqual(limit)
          const omitted = Number(/\[truncated: (\d+) bytes omitted]$/.exec(body)?.[1])
          expect(Number.isInteger(omitted)).toBe(true)
          expect(omitted).toBeGreaterThan(0)
          expect(body.endsWith(nativeTranscriptTruncationMarker(omitted))).toBe(true)
        }
      }),
      { numRuns: 100 },
    )
  })

  test("Property 38: truncation names the exact omitted byte count", () => {
    // `limitTranscriptSection` is where the exactness claim lives, so the property drives it
    // directly: it is the only place that can know the pre-truncation byte count.
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...LOWER, "é", "字", "🙂"), { minLength: 0, maxLength: 120 }).map((chars) => chars.join("")),
        fc.integer({ min: 0, max: 200 }),
        (text, limit) => {
          const total = byteLength(text)
          const limited = limitTranscriptSection(text, limit)

          if (total <= limit) {
            expect(limited).toBe(text)
            return
          }

          const cut = limited.lastIndexOf(TRUNCATION_PREFIX)
          expect(cut).toBeGreaterThanOrEqual(0)
          const kept = limited.slice(0, cut)
          const omitted = Number(/\[truncated: (\d+) bytes omitted]$/.exec(limited)?.[1])

          // Kept is a real prefix on a UTF-8 boundary, and kept + omitted accounts for every
          // byte of the input — no byte is lost and none is double-counted.
          expect(text.startsWith(kept)).toBe(true)
          expect(byteLength(kept)).toBeLessThanOrEqual(limit)
          expect(byteLength(kept) + omitted).toBe(total)
          expect(limited).toBe(kept ? `${kept}\n${nativeTranscriptTruncationMarker(omitted)}` : `\n${nativeTranscriptTruncationMarker(omitted)}`)
        },
      ),
      { numRuns: 100 },
    )
  })

  test("Property 38: the transcript path is a pure function of the case id", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NATIVE_LIVE_CASE_IDS),
        fc.constantFrom(...NATIVE_LIVE_CASE_IDS),
        identifierArb(3, 12),
        (left, right, dirName) => {
          const dir = `.native-transcripts-${dirName}`
          // Same id, same path, every time; different ids never collide.
          expect(nativeTranscriptPath(left, { dir })).toBe(nativeTranscriptPath(left, { dir }))
          expect(nativeTranscriptPath(left, { dir }) === nativeTranscriptPath(right, { dir })).toBe(left === right)
          expect(nativeTranscriptPath(left, { dir })).toBe(path.join(dir, `${left}.transcript.md`))
        },
      ),
      { numRuns: 100 },
    )

    // Exhaustive half: all 14 ids yield 14 distinct paths.
    const paths = NATIVE_LIVE_CASE_IDS.map((id) => nativeTranscriptPath(id, { dir: "d" }))
    expect(new Set(paths).size).toBe(NATIVE_LIVE_CASE_IDS.length)
  })

  test("Property 38: non-volatile sections are byte-identical across two runs of identical input", () => {
    fc.assert(
      fc.property(capturedInputArb(), fc.integer({ min: 256, max: 4096 }), (captured, limit) => {
        // Identical captured input plus identical run-specific values: the whole file matches.
        const first = renderNativeTranscript(transcriptInputFor(captured, STABLE_VOLATILE, limit))
        expect(renderNativeTranscript(transcriptInputFor(captured, STABLE_VOLATILE, limit))).toBe(first)

        // Identical captured input, different run-specific values: everything above
        // `## volatile` still matches, and the file as a whole does not (Requirement 25.8).
        const second = renderNativeTranscript(transcriptInputFor(captured, OTHER_VOLATILE, limit))
        const stable = (content: string) => content.slice(0, content.indexOf("## volatile"))
        expect(stable(second)).toBe(stable(first))
        expect(second).not.toBe(first)

        // Where each run-specific value lives is checked at the default limit: a section limit
        // small enough to truncate `## volatile` would hide a line without contradicting the
        // quarantine claim, which the section-limit property already covers.
        for (const run of [STABLE_VOLATILE, OTHER_VOLATILE]) {
          const content = renderNativeTranscript(transcriptInputFor(captured, run, DEFAULT_NATIVE_TRANSCRIPT_LIMIT))
          expect(stable(content)).not.toContain(run.logId)
          expect(stable(content)).not.toContain(run.requestId)
          expect(content).toContain(`request log id: ${run.logId}`)
          expect(content).toContain(`response header x-request-id: ${run.requestId}`)
        }
      }),
      { numRuns: 100 },
    )
  })
})
