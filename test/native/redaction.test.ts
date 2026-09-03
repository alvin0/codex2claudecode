// Role: the Requirement 25.10 scan — open every Transcript this harness can produce and prove no
// secret value reached it. Offline: nothing here talks to a provider, so the scan runs in
// `bun test test/`. The corpus is one rendered Transcript per registry case, built from captured
// input carrying planted credentials, plus every `*.transcript.md` a previous live run left in the
// Transcript directory.
//
// What the scan looks for (Requirement 25.10): `Bearer` followed by token characters, and the raw
// values of `accessToken`, `refreshToken`, `idToken`, `authorization`, and `signature`. For the
// on-disk files the planted values are unknown, so those are scanned for the same five keys still
// holding a value other than the placeholder — the same leak, expressed without knowing the value.
//
// One representation deserves a note, because a green scan here does not mean redaction is total.
// `describe("recorded redaction gaps")` states it as a `.failing` test rather than leaving it
// unsaid; it flips loudly the moment the underlying behavior changes.
//
//  1. The Kiro frame hexdump in `## upstream response (raw)`. `transcript.ts` redacts the
//     *rendered* text, and `kiro-frames.ts` builds the dump from the captured bytes before that
//     rendering, so the hex column and the 16-character ASCII gutter carry pre-redaction bytes.
//     A value of 17 characters or more can never sit whole on one gutter line, which is the only
//     reason the raw-value scan passes over a Kiro Transcript. Property 12's strong clause — no
//     surviving run of eight characters — does not hold on those lines.
//
// A second gap used to be recorded here: a short `signature` value survived because
// `redactSensitiveText` did not list the key. That gap is closed — `signature` is now a member of
// the key list in `src/core/debug-capture.ts`, which is the list this scan's redaction runs
// through, so a `signature` value is redacted at any length. Note that the list in
// `src/core/debug-capture.ts` is separate from `SECRET_KEYS` in `src/upstream/kiro/errors.ts`,
// which task 34.1 changed: that one governs Kiro error messages, not Transcript rendering, so
// closing the transcript half took its own edit.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { pathExists, readDirectory, readTextFile } from "../../src/core/bun-fs"
import { bunPath as path, tempDir } from "../../src/core/paths"
import type { JsonObject, RequestLogEntry } from "../../src/core/types"
import { mkdtemp, rm } from "../helpers"

import { NATIVE_LIVE_CASES, resolveNativeCaseBody } from "./cases"
import { KIRO_FRAME_HEXDUMP_BYTES } from "./kiro-frames"
import {
  nativeTranscriptDir,
  redactTranscriptText,
  renderNativeTranscript,
  writeNativeTranscript,
  type NativeTranscriptInput,
} from "./transcript"
import type { NativeLiveCase, NativeLiveObservation } from "./types"

/** Exactly the five keys Requirement 25.10 names. */
const SCANNED_SECRET_KEYS = ["accessToken", "refreshToken", "idToken", "authorization", "signature"] as const

const PLACEHOLDER = "[redacted]"

/** `Bearer` followed by token characters. `Bearer [redacted]` cannot match: `[` is not a token char. */
const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._~+/=-]+/g

/**
 * A scanned key still holding a value. The value class excludes newlines on purpose: a hexdump
 * gutter line is 16 characters wide, too narrow to hold `"accessToken":"` plus a value plus the
 * closing quote, so a same-line match is a real rendered field and never a gutter fragment.
 */
const SECRET_KEY_VALUE = /"(accessToken|refreshToken|idToken|authorization|signature)"\s*:\s*"([^"\n]*)"/gi

/** Property 12 calls a surviving run of eight characters a leak. */
const MIN_LEAK_LENGTH = 8

/**
 * The length at or above which redaction covers a value under *any* key, known or not, through
 * `redactDebugText`'s token rule. Below it, coverage comes from the key list in
 * `src/core/debug-capture.ts` instead — which names all five scanned keys, `signature` included.
 */
const REDACTED_TOKEN_FLOOR = 32

/** `0000  00 11 ..  |gutter|` — the hexdump body lines, the one pre-redaction view of a Transcript. */
const HEXDUMP_LINE = /^[0-9a-f]{4} {2}[0-9a-f ]+\|.*\|$/

const TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const TOKEN_CHAR_LIST = TOKEN_CHARS.split("")

const MCP_FIXTURE_URL = "http://127.0.0.1:8765/mcp"

/** Stride 7 is coprime with 62, so a generated value has no short repeating run to confuse a substring check. */
function tokenValue(length: number, offset = 0) {
  return Array.from({ length }, (_, index) => TOKEN_CHARS[(index * 7 + offset) % TOKEN_CHARS.length]).join("")
}

/** Planted credentials, shaped like the real ones — the measured Kiro signature is ~360 characters. */
const SECRETS = {
  bearer: `sk-live-${tokenValue(40, 1)}`,
  accessToken: `aoa-${tokenValue(48, 2)}`,
  refreshToken: `aor-${tokenValue(48, 3)}`,
  idToken: `eyJhbGciOiJub25lIn0.${tokenValue(56, 4)}.${tokenValue(43, 5)}`,
  authorization: `authz-${tokenValue(44, 6)}`,
  signature: tokenValue(360, 8),
} as const

const PLANTED_VALUES = Object.values(SECRETS)

// ---------------------------------------------------------------------------
// Scanners
// ---------------------------------------------------------------------------

/** Every `Bearer` token still in the text. Any match is a leak (Requirement 25.10). */
function bearerLeaks(content: string): string[] {
  return content.match(BEARER_TOKEN) ?? []
}

/** Every scanned key whose rendered value is something other than the placeholder. */
function unredactedSecretKeyValues(content: string): Array<{ key: string; value: string }> {
  const found: Array<{ key: string; value: string }> = []
  for (const match of content.matchAll(SECRET_KEY_VALUE)) {
    const value = match[2]
    if (value === PLACEHOLDER || value === "") continue
    found.push({ key: match[1], value })
  }
  return found
}

/** Planted values that reached the text verbatim. */
function rawValueLeaks(content: string, values: readonly string[] = PLANTED_VALUES): string[] {
  return values.filter((value) => content.includes(value))
}

function windows(value: string, length: number): string[] {
  if (value.length < length) return [value]
  return Array.from({ length: value.length - length + 1 }, (_, index) => value.slice(index, index + length))
}

function hexdumpLines(content: string) {
  return content.split("\n").filter((line) => HEXDUMP_LINE.test(line))
}

/** The Transcript minus the hexdump body lines — everything redaction actually reaches (gap 1). */
function withoutHexdump(content: string) {
  return content
    .split("\n")
    .filter((line) => !HEXDUMP_LINE.test(line))
    .join("\n")
}

// ---------------------------------------------------------------------------
// Captured input carrying planted credentials
// ---------------------------------------------------------------------------

/** A credential-bearing body of the shape upstream traffic actually carries. */
function secretPayload(extra: JsonObject = {}): JsonObject {
  return {
    ...extra,
    accessToken: SECRETS.accessToken,
    refreshToken: SECRETS.refreshToken,
    idToken: SECRETS.idToken,
    authorization: SECRETS.authorization,
    signature: SECRETS.signature,
    // `Bearer` rides in a header, which is where it rides on the wire.
    headers: { authorization: `Bearer ${SECRETS.bearer}` },
  }
}

/** One EventStream frame in the shape `onResponseBodyChunk` delivers it: decoded text. */
function eventStreamFrame(eventType: string, payload: string) {
  const prelude = `\u0000\u0000\u0000${String.fromCharCode(payload.length % 256)}\u0000\u0000\u0000\u000b\u0011\u0022\u0033\u0044`
  const header = `\u000b:event-type\u0007\u0000${String.fromCharCode(eventType.length)}${eventType}`
  // The CRC32 trailer is where the UTF-8 decode loses bytes; U+FFFD is what the harness receives.
  return `${prelude}${header}${payload}\ufffd\ufffd`
}

function kiroResponseBody() {
  return [
    eventStreamFrame("assistantResponseEvent", '{"content":"ok"}'),
    eventStreamFrame("metadataEvent", JSON.stringify(secretPayload({ usage: { inputTokens: 4, outputTokens: 1 } }))),
  ].join("")
}

function codexResponseBody() {
  return [
    'event: response.output_text.delta\ndata: {"delta":"ok"}\n\n',
    `event: response.completed\ndata: ${JSON.stringify({ response: { status: "completed", credentials: secretPayload() } })}\n\n`,
    "event: response.done\ndata: [DONE]\n\n",
  ].join("")
}

function clientRequestHeaders() {
  return {
    authorization: `Bearer ${SECRETS.bearer}`,
    "x-api-key": SECRETS.accessToken,
    "content-type": "application/json",
  }
}

function clientResponseBody(status: number) {
  if (status >= 400) {
    return JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: `require_approval: always is not supported; retry with never (upstream said: Bearer ${SECRETS.bearer})`,
      },
    })
  }
  return JSON.stringify({
    type: "message",
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 4, output_tokens: 1 },
  })
}

function requestLogFor(liveCase: NativeLiveCase, status: number, responseBody: string): RequestLogEntry {
  return {
    id: "log-redaction",
    at: "2024-01-01T00:00:00.000Z",
    method: "POST",
    path: liveCase.route,
    status,
    durationMs: 7,
    error: "-",
    requestHeaders: clientRequestHeaders(),
    proxy: {
      label: `${liveCase.upstream} ${liveCase.route}`,
      method: "POST",
      target: `https://upstream.invalid/${liveCase.upstream}`,
      status,
      durationMs: 6,
      error: "-",
      requestBody: JSON.stringify(secretPayload({ model: liveCase.body.model })),
      responseBody,
    },
  }
}

/** One Transcript input per registry case, every text-bearing field carrying a planted credential. */
function transcriptInputFor(liveCase: NativeLiveCase): NativeTranscriptInput {
  const status = liveCase.id === "mcp-approval-reject" ? 400 : 200
  const responseBody = liveCase.upstream === "kiro" ? kiroResponseBody() : codexResponseBody()
  const clientBody = clientResponseBody(status)

  const observation: NativeLiveObservation = {
    caseId: liveCase.id,
    status,
    headers: { "content-type": "application/json", "x-amzn-requestid": "req-redaction" },
    clientBody,
    clientEvents: [],
    upstreamRequestCount: 1,
    requestLog: requestLogFor(liveCase, status, responseBody),
    ...(liveCase.requiresDirectUpstreamCall ? { directUpstreamBody: responseBody } : {}),
  }

  return {
    liveCase,
    observation,
    clientRequest: {
      method: "POST",
      path: liveCase.route,
      headers: clientRequestHeaders(),
      body: resolveNativeCaseBody(liveCase, { mcpServerUrl: MCP_FIXTURE_URL }),
    },
    volatile: { "gateway port": 51234, "upstream authorization": `Bearer ${SECRETS.bearer}` },
  }
}

interface CorpusEntry {
  liveCase: NativeLiveCase
  input: NativeTranscriptInput
  content: string
}

function transcriptCorpus(): CorpusEntry[] {
  return NATIVE_LIVE_CASES.map((liveCase) => {
    const input = transcriptInputFor(liveCase)
    return { liveCase, input, content: renderNativeTranscript(input) }
  })
}

const CORPUS = transcriptCorpus()

async function existingTranscriptFiles() {
  const dir = nativeTranscriptDir()
  if (!(await pathExists(dir))) return []
  const entries = await readDirectory(dir)
  return entries.filter((entry) => entry.endsWith(".transcript.md")).map((entry) => path.join(dir, entry))
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

describe("native transcript redaction scan", () => {
  test("covers one transcript per registry case", () => {
    expect(CORPUS.map((entry) => entry.liveCase.id)).toEqual(NATIVE_LIVE_CASES.map((liveCase) => liveCase.id))
    expect(CORPUS).toHaveLength(14)
    // A transcript that never saw a credential proves nothing, so each one must show the placeholder.
    for (const { liveCase, content } of CORPUS) {
      expect(content, `${liveCase.id} rendered no redaction placeholder`).toContain(PLACEHOLDER)
    }
  })

  test("no transcript carries `Bearer` followed by token characters", () => {
    for (const { liveCase, content } of CORPUS) {
      expect(bearerLeaks(content), `${liveCase.id} leaked a bearer token`).toEqual([])
    }
  })

  test("no transcript carries a raw secret value", () => {
    for (const { liveCase, content } of CORPUS) {
      expect(rawValueLeaks(content), `${liveCase.id} leaked a raw secret value`).toEqual([])
    }
  })

  test("every rendered value under a scanned secret key is the placeholder", () => {
    for (const { liveCase, content } of CORPUS) {
      expect(unredactedSecretKeyValues(content), `${liveCase.id} left a secret key unredacted`).toEqual([])
    }
  })

  test("scans the written file, not only the rendered string", async () => {
    const dir = await mkdtemp(path.join(tempDir(), "native-redaction-"))
    try {
      for (const { liveCase, input } of CORPUS) {
        const written = await writeNativeTranscript({ ...input, dir })
        const onDisk = await readTextFile(written.path)
        expect(onDisk).toBe(written.content)
        expect(bearerLeaks(onDisk), `${liveCase.id} leaked a bearer token on disk`).toEqual([])
        expect(rawValueLeaks(onDisk), `${liveCase.id} leaked a raw secret value on disk`).toEqual([])
        expect(unredactedSecretKeyValues(onDisk), `${liveCase.id} left a secret key unredacted on disk`).toEqual([])
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("scans transcripts a previous live run already wrote", async () => {
    const files = await existingTranscriptFiles()
    for (const file of files) {
      const content = await readTextFile(file)
      // The planted values are unknown for these, so the leak is expressed key-side instead.
      expect(bearerLeaks(content), `${file} leaked a bearer token`).toEqual([])
      expect(unredactedSecretKeyValues(content), `${file} left a secret key unredacted`).toEqual([])
    }
  })

  test("the scanners flag a planted leak, so a green scan is not vacuous", () => {
    const leaky = `authorization: Bearer ${SECRETS.bearer}\n"signature": "sig-Ab12cdEF"\n${SECRETS.accessToken}`
    expect(bearerLeaks(leaky)).toEqual([`Bearer ${SECRETS.bearer}`])
    expect(unredactedSecretKeyValues(leaky)).toEqual([{ key: "signature", value: "sig-Ab12cdEF" }])
    expect(rawValueLeaks(leaky)).toContain(SECRETS.accessToken)
    // And the placeholder form is not mistaken for a leak.
    expect(bearerLeaks(`authorization: Bearer ${PLACEHOLDER}`)).toEqual([])
    expect(unredactedSecretKeyValues(`"accessToken": "${PLACEHOLDER}"`)).toEqual([])
  })

  // Both rules cover a `signature` value now — the length rule above the floor, the key list
  // below it — so this records that the long measured shape is redacted by either path.
  test("records where the `signature` threshold sits today", () => {
    expect(SECRETS.signature.length).toBeGreaterThanOrEqual(360)
    expect(redactTranscriptText(`{"signature":"${SECRETS.signature}"}`)).toBe(`{"signature":"${PLACEHOLDER}"}`)
    expect(redactTranscriptText(`{"signature":"${tokenValue(REDACTED_TOKEN_FLOOR, 11)}"}`)).toBe(
      `{"signature":"${PLACEHOLDER}"}`,
    )
  })
})

// ---------------------------------------------------------------------------
// Property 12, transcript half
// ---------------------------------------------------------------------------

/** Embeds one generated secret under one generated key in every text-bearing field of a Transcript. */
function generatedInput(liveCase: NativeLiveCase, key: string, secret: string): NativeTranscriptInput {
  const payload: JsonObject = { [key]: secret, nested: { [key]: secret } }
  const responseBody =
    liveCase.upstream === "kiro"
      ? eventStreamFrame("metadataEvent", JSON.stringify({ usage: { inputTokens: 1 }, ...payload }))
      : `event: response.completed\ndata: ${JSON.stringify({ response: payload })}\n\n`

  return {
    liveCase,
    observation: {
      caseId: liveCase.id,
      status: 200,
      headers: { "content-type": "application/json" },
      clientBody: JSON.stringify({ error: { message: `upstream said: Bearer ${secret}` } }),
      clientEvents: [],
      upstreamRequestCount: 1,
      requestLog: {
        id: "log-property",
        at: "2024-01-01T00:00:00.000Z",
        method: "POST",
        path: liveCase.route,
        status: 200,
        durationMs: 1,
        error: "-",
        requestHeaders: {},
        proxy: {
          label: liveCase.upstream,
          method: "POST",
          target: "https://upstream.invalid",
          status: 200,
          durationMs: 1,
          error: "-",
          requestBody: JSON.stringify(payload),
          responseBody,
        },
      },
    },
    clientRequest: {
      method: "POST",
      path: liveCase.route,
      headers: { authorization: `Bearer ${secret}`, "x-api-key": secret },
      body: { model: "m" },
    },
    volatile: { "upstream authorization": `Bearer ${secret}` },
  }
}

/**
 * Values of at least `REDACTED_TOKEN_FLOOR` characters. The floor is stated rather than assumed:
 * above it every value is covered by `redactDebugText`'s token rule whatever key it sits under, so
 * the property does not depend on the key list. The short-value case — where the key list is the
 * only thing doing the work — is asserted separately by the `signature` unit below.
 */
const secretArb = fc
  .array(fc.constantFrom(...TOKEN_CHAR_LIST), { minLength: REDACTED_TOKEN_FLOOR, maxLength: 96 })
  .map((chars) => chars.join(""))

/** Words of at most 20 token characters, so no 32-character run and no secret key can appear. */
const safeTextArb = fc
  .array(
    fc.array(fc.constantFrom(...TOKEN_CHAR_LIST), { minLength: 1, maxLength: 20 }).map((chars) => chars.join("")),
    { minLength: 1, maxLength: 8 },
  )
  .map((words) => words.join(" "))
  .filter((text) => !text.includes("Bearer"))

describe("native transcript redaction properties", () => {
  /**
   * Feature: native-api-mode, Property 12: Redaction leaves no secret value in any output.
   *
   * **Validates: Requirements 25.5, 25.10**
   */
  test("Feature: native-api-mode, Property 12: Redaction leaves no secret value in any output", () => {
    fc.assert(
      fc.property(
        secretArb,
        fc.constantFrom(...SCANNED_SECRET_KEYS),
        fc.constantFrom(...NATIVE_LIVE_CASES),
        (secret, key, liveCase) => {
          const content = renderNativeTranscript(generatedInput(liveCase, key, secret))

          expect(content).toContain(PLACEHOLDER)
          expect(bearerLeaks(content)).toEqual([])
          expect(unredactedSecretKeyValues(content)).toEqual([])
          expect(rawValueLeaks(content, [secret])).toEqual([])

          // Every line redaction reaches. The hexdump body lines are gap 1, asserted below.
          const reached = withoutHexdump(content)
          for (const window of windows(secret, MIN_LEAK_LENGTH)) {
            expect(reached.includes(window), `an ${MIN_LEAK_LENGTH}-character run survived: ${window}`).toBe(false)
          }
        },
      ),
      { numRuns: 100 },
    )

    // Second half of the property: text with no secret key and no token-like run is untouched.
    fc.assert(
      fc.property(safeTextArb, (text) => {
        expect(redactTranscriptText(text)).toBe(text)
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Recorded gaps — each asserts the requirement, each fails until the gap closes
// ---------------------------------------------------------------------------

describe("recorded redaction gaps", () => {
  /**
   * The closed gap. A `signature` value shorter than `REDACTED_TOKEN_FLOOR` is below
   * `redactDebugText`'s token rule, so its redaction rests entirely on `signature` being a member
   * of the key list in `src/core/debug-capture.ts`. Was `.failing` while that list omitted the key.
   */
  test("a short `signature` value is redacted like the other four keys", () => {
    const short = "sig-Ab12cdEF"
    expect(short.length).toBeLessThan(REDACTED_TOKEN_FLOOR)
    // The key list, not the length rule, is what covers this.
    expect(redactTranscriptText(`{"signature":"${short}"}`)).toBe(`{"signature":"${PLACEHOLDER}"}`)

    const liveCase = NATIVE_LIVE_CASES[0]
    const input = transcriptInputFor(liveCase)
    const content = renderNativeTranscript({
      ...input,
      observation: {
        ...input.observation,
        requestLog: {
          ...input.observation.requestLog!,
          proxy: { ...input.observation.requestLog!.proxy!, requestBody: JSON.stringify({ signature: short }) },
        },
      },
    })

    expect(content).not.toContain(short)
    expect(unredactedSecretKeyValues(content)).toEqual([])
  })

  /** A Kiro frame whose payload starts with a boundary pattern, so the secret lands inside the cap. */
  function kiroHexdumpContent(secret: string) {
    const liveCase = NATIVE_LIVE_CASES[0]
    const input = transcriptInputFor(liveCase)
    return renderNativeTranscript({
      ...input,
      observation: {
        ...input.observation,
        requestLog: {
          ...input.observation.requestLog!,
          proxy: {
            ...input.observation.requestLog!.proxy!,
            responseBody: eventStreamFrame("usageEvent", `{"usage":"${secret}"}`),
          },
        },
      },
    })
  }

  /**
   * Gap 1. The Kiro hexdump is built from the captured bytes before `transcript.ts` redacts the
   * rendered text, so the ASCII gutter shows up to 16 raw characters per line and the hex column
   * shows the same bytes as hex pairs — neither of which any redaction rule matches. Closing this
   * means redacting before hexdumping, which is `transcript.ts` / `kiro-frames.ts` work, not this
   * scan's. Recorded here so the green scan above is not read as "redaction covers the hexdump".
   */
  test.failing("a secret inside a Kiro frame does not survive the hexdump view", () => {
    const secret = tokenValue(48, 13)
    const dump = hexdumpLines(kiroHexdumpContent(secret)).join("\n")
    expect(dump).not.toBe("")
    for (const window of windows(secret, MIN_LEAK_LENGTH)) {
      expect(dump.includes(window), `an ${MIN_LEAK_LENGTH}-character run survived in the hexdump: ${window}`).toBe(false)
    }
  })

  /**
   * The measured bound on gap 1, which is why the Requirement 25.10 raw-value scan is green over a
   * Kiro Transcript: the dump stops at `KIRO_FRAME_HEXDUMP_BYTES` per frame and the prelude plus
   * `:event-type` header already consume 35 to 50 of those bytes, so only the first bytes of a
   * payload are ever exposed, 16 characters at a time. A whole credential never appears.
   */
  test("bounds gap 1: only the payload bytes inside the per-frame cap are exposed", () => {
    const secret = tokenValue(48, 13)
    const dump = hexdumpLines(kiroHexdumpContent(secret)).join("\n")
    const all = windows(secret, MIN_LEAK_LENGTH)
    const surviving = all.filter((window) => dump.includes(window))

    expect(KIRO_FRAME_HEXDUMP_BYTES).toBe(64)
    expect(dump).not.toContain(secret)
    expect(surviving.length).toBeGreaterThan(0)
    expect(surviving.length).toBeLessThan(all.length)
  })
})
