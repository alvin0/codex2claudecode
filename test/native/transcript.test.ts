import { afterEach, describe, expect, test } from "bun:test"

import { readTextFile } from "../../src/core/bun-fs"
import { DEBUG_PREVIEW_LIMIT } from "../../src/core/debug-capture"
import { bunPath as path, tempDir } from "../../src/core/paths"
import { mkdtemp, rm } from "../helpers"

import { nativeLiveCase } from "./cases"
import { detectKiroFrames, KIRO_HEXDUMP_LABEL, kiroFrameView, renderKiroFrameView } from "./kiro-frames"
import {
  DEFAULT_NATIVE_TRANSCRIPT_LIMIT,
  NATIVE_TRANSCRIPT_DIR_NAME,
  NATIVE_TRANSCRIPT_SECTIONS,
  limitTranscriptSection,
  nativeTranscriptDir,
  nativeTranscriptLimit,
  nativeTranscriptPath,
  nativeTranscriptTruncationMarker,
  nativeUpstreamCapture,
  redactTranscriptText,
  renderNativeTranscript,
  writeNativeTranscript,
  type NativeTranscriptInput,
} from "./transcript"
import type { NativeLiveObservation } from "./types"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** One EventStream frame in the shape `onResponseBodyChunk` delivers it: decoded text. */
function eventStreamFrame(eventType: string, payload: string) {
  const prelude = `\u0000\u0000\u0000${String.fromCharCode(payload.length)}\u0000\u0000\u0000\u000b\u0011\u0022\u0033\u0044`
  const header = `\u000b:event-type\u0007\u0000${String.fromCharCode(eventType.length)}${eventType}`
  // The CRC32 trailer is where the decode loses bytes; U+FFFD is what the harness receives.
  return `${prelude}${header}${payload}\ufffd\ufffd`
}

const KIRO_STREAM = [
  eventStreamFrame("assistantResponseEvent", '{"content":"he"}'),
  eventStreamFrame("assistantResponseEvent", '{"content":"llo"}'),
  eventStreamFrame("toolUseEvent", '{"name":"WebSearch","input":"{}","toolUseId":"t1","stop":true}'),
].join("")

function observation(overrides: Partial<NativeLiveObservation> = {}): NativeLiveObservation {
  return {
    caseId: "sampling-declared",
    status: 200,
    headers: { "content-type": "application/json", date: "Mon, 01 Jan 2024 00:00:00 GMT" },
    clientBody: '{"content":[{"type":"text","text":"ok"}]}',
    clientJson: { content: [{ type: "text", text: "ok" }] },
    clientEvents: [],
    ...overrides,
  }
}

function transcriptInput(overrides: Partial<NativeTranscriptInput> = {}): NativeTranscriptInput {
  return {
    liveCase: nativeLiveCase("sampling-declared"),
    observation: observation(),
    limit: DEFAULT_NATIVE_TRANSCRIPT_LIMIT,
    ...overrides,
  }
}

describe("native transcript sections", () => {
  test("declares the fixed section order from the design", () => {
    expect([...NATIVE_TRANSCRIPT_SECTIONS]).toEqual([
      "## case",
      "## client request",
      "## upstream request",
      "## upstream response (raw)",
      "## client response",
      "## assertions",
      "## volatile",
    ])
  })

  test("emits every section exactly once, in that order", () => {
    const content = renderNativeTranscript(transcriptInput())
    let previous = -1
    for (const header of NATIVE_TRANSCRIPT_SECTIONS) {
      const index = content.indexOf(`\n${header}\n`)
      expect(index).toBeGreaterThan(previous)
      expect(content.split(`\n${header}\n`)).toHaveLength(2)
      previous = index
    }
  })

  test("records the case declaration, the client response, and one line per assertion", () => {
    const liveCase = nativeLiveCase("sampling-declared")
    const content = renderNativeTranscript(transcriptInput())

    expect(content).toContain(`# native transcript: ${liveCase.id}`)
    expect(content).toContain(`upstream: ${liveCase.upstream}`)
    expect(content).toContain("status: 200")

    const assertionLines = content
      .slice(content.indexOf("## assertions"), content.indexOf("## volatile"))
      .split("\n")
      .filter((line) => line.startsWith("- ["))
    expect(assertionLines).toHaveLength(liveCase.assertions.length)
    for (const line of assertionLines) expect(line).toMatch(/^- \[(pass|fail|error)] /)
  })

  test("reads the upstream bytes only from the two request-log proxy fields", () => {
    const content = renderNativeTranscript(
      transcriptInput({
        observation: observation({
          upstreamRequestCount: 1,
          requestLog: {
            id: "log-1",
            at: "2024-01-01T00:00:00.000Z",
            method: "POST",
            path: "/v1/messages",
            status: 200,
            durationMs: 12,
            error: "-",
            requestHeaders: {},
            proxy: {
              label: "Kiro messages",
              method: "POST",
              target: "https://upstream.example/generateAssistantResponse",
              status: 200,
              durationMs: 11,
              error: "-",
              requestBody: '{"conversationState":{"chatTriggerType":"MANUAL"}}',
              responseBody: KIRO_STREAM,
            },
          },
        }),
      }),
    )

    expect(content).toContain("upstream request count: 1")
    expect(content).toContain('"chatTriggerType": "MANUAL"')
    expect(content).toContain("frames detected: 3")
  })

  test("keeps the observation mirrors as the fallback for the same two fields", () => {
    const captured = nativeUpstreamCapture(
      observation({ upstreamRequestBody: '{"a":1}', upstreamResponseBody: "event: x\ndata: {}\n\n" }),
    )
    expect(captured).toEqual({ requestBody: '{"a":1}', responseBody: "event: x\ndata: {}\n\n" })
  })

  test("records Codex SSE text verbatim, including event names and data lines", () => {
    const sse = 'event: response.output_text.delta\ndata: {"delta":"ok"}\n\n'
    const content = renderNativeTranscript(
      transcriptInput({
        liveCase: nativeLiveCase("passthrough-bytes"),
        observation: observation({ caseId: "passthrough-bytes", upstreamResponseBody: sse }),
      }),
    )
    expect(content).toContain("event: response.output_text.delta")
    expect(content).toContain('data: {"delta":"ok"}')
  })
})

describe("native transcript path", () => {
  test("derives the path from the case id alone, and repeats it", () => {
    const dir = nativeTranscriptDir({})
    expect(dir).toBe(NATIVE_TRANSCRIPT_DIR_NAME)
    expect(nativeTranscriptPath("sampling-declared", { dir })).toBe(
      path.join(NATIVE_TRANSCRIPT_DIR_NAME, "sampling-declared.transcript.md"),
    )
    expect(nativeTranscriptPath("sampling-declared", { dir })).toBe(nativeTranscriptPath("sampling-declared", { dir }))
    expect(nativeTranscriptPath("sampling-native", { dir })).not.toBe(nativeTranscriptPath("sampling-declared", { dir }))
  })

  test("honors NATIVE_TRANSCRIPT_DIR and rejects an id that is not path-safe", () => {
    expect(nativeTranscriptDir({ NATIVE_TRANSCRIPT_DIR: "/tmp/elsewhere" })).toBe("/tmp/elsewhere")
    expect(nativeTranscriptDir({ NATIVE_TRANSCRIPT_DIR: "  " })).toBe(NATIVE_TRANSCRIPT_DIR_NAME)
    expect(() => nativeTranscriptPath("../escape")).toThrow(/not path-safe/)
  })

  test("writes the rendered transcript to that path", async () => {
    const dir = await mkdtemp(path.join(tempDir(), "native-transcript-"))
    tempDirs.push(dir)

    const written = await writeNativeTranscript(transcriptInput({ dir }))
    expect(written.path).toBe(path.join(dir, "sampling-declared.transcript.md"))
    expect(await readTextFile(written.path)).toBe(written.content)
  })
})

describe("native transcript limits", () => {
  test("defaults to 262144 bytes and leaves DEBUG_PREVIEW_LIMIT alone", () => {
    expect(DEFAULT_NATIVE_TRANSCRIPT_LIMIT).toBe(262_144)
    expect(nativeTranscriptLimit({})).toBe(262_144)
    expect(nativeTranscriptLimit({ NATIVE_TRANSCRIPT_LIMIT: "4096" })).toBe(4096)
    expect(nativeTranscriptLimit({ NATIVE_TRANSCRIPT_LIMIT: "nope" })).toBe(262_144)
    expect(DEBUG_PREVIEW_LIMIT).toBe(4000)
  })

  test("truncation names the exact omitted byte count", () => {
    const limited = limitTranscriptSection("x".repeat(100), 40)
    expect(limited).toBe(`${"x".repeat(40)}\n${nativeTranscriptTruncationMarker(60)}`)
    expect(limitTranscriptSection("x".repeat(40), 40)).toBe("x".repeat(40))
  })

  test("truncation lands on a UTF-8 boundary and still counts bytes, not characters", () => {
    const limited = limitTranscriptSection("é".repeat(10), 5)
    expect(limited).toBe(`${"é".repeat(2)}\n${nativeTranscriptTruncationMarker(16)}`)
  })

  test("applies the limit per section, so one huge section cannot hide the others", () => {
    const content = renderNativeTranscript(
      transcriptInput({
        limit: 200,
        observation: observation({ clientBody: "y".repeat(5000) }),
      }),
    )
    for (const header of NATIVE_TRANSCRIPT_SECTIONS) expect(content).toContain(header)
    expect(content).toContain("bytes omitted]")
  })
})

describe("native transcript redaction", () => {
  const secrets = {
    bearer: "sk-live-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    accessToken: "access-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    refreshToken: "refresh-AbCdEfGhIjKlMnOpQrStUvWxYz01234567",
    authorization: "authz-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    signature: "sig-AbCdEfGhIjKlMnOpQrStUvWxYz012345678901",
  }

  test("routes text through both debug-capture redactors", () => {
    const redacted = redactTranscriptText(`Authorization: Bearer ${secrets.bearer}`)
    expect(redacted).toContain("Bearer [redacted]")
    expect(redacted).not.toContain(secrets.bearer)
  })

  test("leaves no secret value anywhere in a rendered transcript", () => {
    const content = renderNativeTranscript(
      transcriptInput({
        clientRequest: {
          method: "POST",
          path: "/v1/messages",
          headers: { authorization: `Bearer ${secrets.bearer}`, "x-api-key": secrets.accessToken },
          body: { model: "claude-sonnet-4.5", messages: [] },
        },
        observation: observation({
          headers: { "content-type": "application/json", "x-amzn-requestid": "req-1" },
          clientBody: `{"error":{"message":"Bearer ${secrets.bearer}"}}`,
          clientJson: { error: { message: "nope" } },
          requestLog: {
            id: "log-1",
            at: "2024-01-01T00:00:00.000Z",
            method: "POST",
            path: "/v1/messages",
            status: 200,
            durationMs: 3,
            error: "-",
            requestHeaders: {},
            proxy: {
              label: "Kiro messages",
              method: "POST",
              target: "upstream",
              status: 200,
              durationMs: 2,
              error: "-",
              requestBody: JSON.stringify(secrets),
              responseBody: `{"content":"${secrets.signature}"}`,
            },
          },
        }),
      }),
    )

    for (const [name, value] of Object.entries(secrets)) {
      expect(content, `${name} leaked into the transcript`).not.toContain(value)
    }
    expect(content).toContain("[redacted]")
  })
})

describe("native transcript diffability", () => {
  test("is byte-identical across two runs over identical captured input", () => {
    expect(renderNativeTranscript(transcriptInput())).toBe(renderNativeTranscript(transcriptInput()))
  })

  test("quarantines run-specific values so the sections above `## volatile` stay identical", () => {
    const base = (id: string, durationMs: number, at: string, requestId: string) =>
      transcriptInput({
        observation: observation({
          headers: { "content-type": "application/json", date: at, "x-request-id": requestId },
          requestLog: {
            id,
            at,
            method: "POST",
            path: "/v1/messages",
            status: 200,
            durationMs,
            error: "-",
            requestHeaders: {},
            proxy: {
              label: "Kiro messages",
              method: "POST",
              target: "upstream",
              status: 200,
              durationMs,
              error: "-",
              requestBody: '{"conversationState":{}}',
              responseBody: KIRO_STREAM,
            },
          },
        }),
        volatile: { "gateway port": 51234 + durationMs, "provider credits": durationMs },
      })

    const first = renderNativeTranscript(base("log-1", 11, "2024-01-01T00:00:00.000Z", "req-1"))
    const second = renderNativeTranscript(base("log-2", 97, "2025-06-02T03:04:05.000Z", "req-2"))

    const stable = (content: string) => content.slice(0, content.indexOf("## volatile"))
    expect(stable(first)).toBe(stable(second))
    expect(first).not.toBe(second)

    expect(first).toContain("request log id: log-1")
    expect(first).toContain("gateway duration ms: 11")
    expect(first).toContain("response header x-request-id: req-1")
    expect(first).toContain("gateway port: 51245")
    expect(stable(first)).not.toContain("req-1")
  })
})

describe("kiro frame view", () => {
  test("emits exactly one entry per detected frame", () => {
    const frames = detectKiroFrames(KIRO_STREAM)
    expect(frames).toHaveLength(3)
    expect(frames.map((frame) => frame.eventType)).toEqual([
      "assistantResponseEvent",
      "assistantResponseEvent",
      "toolUseEvent",
    ])
    expect(frames.map((frame) => frame.payload)).toEqual([
      '{"content":"he"}',
      '{"content":"llo"}',
      '{"name":"WebSearch","input":"{}","toolUseId":"t1","stop":true}',
    ])

    const rendered = renderKiroFrameView(KIRO_STREAM)
    expect(rendered.match(/^### frame \d{3} /gm)).toHaveLength(frames.length)
    expect(rendered).toContain("frames detected: 3")
    expect(rendered).toContain("### frame 001  offset 0x0000  event-type assistantResponseEvent")
  })

  test("shows a hexdump plus the decoded payload, labelled as a UTF-8 re-encode", () => {
    const rendered = renderKiroFrameView(KIRO_STREAM)
    expect(rendered).toContain(KIRO_HEXDUMP_LABEL)
    expect(rendered).toContain("hexdump (")
    expect(rendered).toContain("payload:")
    // U+FFFD stands in for the CRC32 bytes the decode already replaced.
    expect(rendered).toContain("ef bf bd")
    expect(rendered).toMatch(/^0000 {2}[0-9a-f]{2} /m)
  })

  test("reports frame offsets in ascending order and counts bytes outside any frame", () => {
    const view = kiroFrameView(KIRO_STREAM)
    const offsets = view.frames.map((frame) => frame.offset)
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right))
    expect(offsets[0]).toBe(0)
    expect(view.trailingBytes).toBeGreaterThan(0)
    expect(renderKiroFrameView(KIRO_STREAM)).toContain(`bytes outside any detected frame: ${view.trailingBytes}`)
  })

  test("says so and keeps the raw text when no frame boundary matches", () => {
    const rendered = renderKiroFrameView("not an event stream")
    expect(detectKiroFrames("not an event stream")).toEqual([])
    expect(rendered).toContain("frames detected: 0")
    expect(rendered).toContain("not an event stream")
  })
})
