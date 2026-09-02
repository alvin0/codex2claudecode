// Role: render the Kiro binary EventStream as something a human can read — one entry per
// detected frame, hexdump plus decoded payload (Requirement 25.2). Detection only; nothing
// here writes files, so `transcript.ts` owns the file layout and this module owns the view.
//
// Honesty about what the hexdump is (design decision D5): `RequestOptions.onResponseBodyChunk`
// hands the harness **UTF-8-decoded text** — `withChunkCallback` in `src/core/stream-utils.ts`
// decodes before calling back — so CRC32 and other non-UTF-8 bytes have already become U+FFFD
// before this module sees them. The hexdump is therefore a UTF-8 *re-encode* of that decoded
// text, not the original wire bytes, and it says so on every frame. Frame boundaries and
// payloads survive because EventStream header names and JSON payloads are ASCII, which is what
// Requirement 25.2 asks for. Byte-exact capture would mean widening `RequestOptions`, which
// Requirement 25.4 forbids, so this is recorded as a known limit rather than worked around.

import { isLikelyTopLevel, KIRO_EVENT_START_PATTERNS } from "../../src/upstream/kiro/event-frames"

/**
 * Payload openings that mark a frame boundary, re-exported under the harness name so the view
 * and the scanner can never drift apart.
 *
 * Seam note resolved: task 7.1 landed `src/upstream/kiro/event-frames.ts`, so this module
 * imports the list from the owning module instead of restating it. When the frame-decoder
 * rewrite deletes `event-frames.ts`, this import breaks loudly — which is the point.
 */
export const KIRO_FRAME_PAYLOAD_PATTERNS = KIRO_EVENT_START_PATTERNS

/** Stated on every hexdump so no reader mistakes it for the original wire bytes (D5). */
export const KIRO_HEXDUMP_LABEL = "UTF-8 re-encode of the decoded chunk; non-UTF-8 bytes such as CRC32 appear as EF BF BD"

/** Bytes hexdumped per frame. Keeps a 296-frame response inside one transcript section. */
export const KIRO_FRAME_HEXDUMP_BYTES = 64

const EVENT_TYPE_HEADER = ":event-type"
const ENCODER = new TextEncoder()

export interface KiroFrame {
  /** 1-based position in the stream, matching the `### frame NNN` heading. */
  index: number
  /** Byte offset of the frame region within the UTF-8 re-encode of the decoded text. */
  offset: number
  /** Prelude, headers, and payload — everything between the previous payload and this one's end. */
  raw: string
  /** Header value of `:event-type`, when the prelude carried one. */
  eventType?: string
  /** The decoded JSON payload text. */
  payload: string
}

export interface KiroFrameView {
  frames: readonly KiroFrame[]
  /** Bytes that matched no frame boundary, reported rather than silently dropped. */
  trailingBytes: number
}

/**
 * Split decoded EventStream text into frames. A frame ends at the close of its JSON payload
 * and begins where the previous one ended, so the prelude bytes carrying `:event-type` stay
 * attached to the payload they describe.
 */
export function detectKiroFrames(text: string): KiroFrame[] {
  const frames: KiroFrame[] = []
  let regionStart = 0
  let offset = 0

  while (regionStart < text.length) {
    const payloadStart = findPayloadStart(text, regionStart)
    if (payloadStart < 0) break
    const payloadEnd = findJsonEnd(text, payloadStart)
    if (payloadEnd < 0) break

    const raw = text.slice(regionStart, payloadEnd)
    const eventType = readEventType(text.slice(regionStart, payloadStart))
    frames.push({
      index: frames.length + 1,
      offset,
      raw,
      ...(eventType ? { eventType } : {}),
      payload: text.slice(payloadStart, payloadEnd),
    })

    offset += byteLength(raw)
    regionStart = payloadEnd
  }

  return frames
}

export function kiroFrameView(text: string): KiroFrameView {
  const frames = detectKiroFrames(text)
  const consumed = frames.reduce((total, frame) => total + frame.raw.length, 0)
  return { frames, trailingBytes: byteLength(text.slice(consumed)) }
}

/** One entry per frame: heading, labelled hexdump, decoded payload. */
export function renderKiroFrameEntry(frame: KiroFrame, options: { hexdumpBytes?: number } = {}): string {
  const limit = options.hexdumpBytes ?? KIRO_FRAME_HEXDUMP_BYTES
  const total = byteLength(frame.raw)
  const shown = Math.min(limit, total)
  const range = shown < total ? `first ${shown} of ${total} bytes` : `${total} bytes`

  return [
    `### frame ${String(frame.index).padStart(3, "0")}  offset 0x${frame.offset.toString(16).padStart(4, "0")}  event-type ${frame.eventType ?? "(none)"}`,
    `hexdump (${range}; ${KIRO_HEXDUMP_LABEL}):`,
    hexdumpText(frame.raw, { limit }),
    "payload:",
    frame.payload,
  ].join("\n")
}

/**
 * The whole `## upstream response (raw)` body for a Kiro case. Emits exactly one entry per
 * detected frame; when nothing matched a boundary it says so and falls back to the raw text
 * rather than presenting an empty view.
 */
export function renderKiroFrameView(text: string, options: { hexdumpBytes?: number } = {}): string {
  const { frames, trailingBytes } = kiroFrameView(text)

  if (!frames.length) {
    return [
      "frames detected: 0",
      `no EventStream frame boundary matched; raw decoded text follows (${byteLength(text)} bytes, ${KIRO_HEXDUMP_LABEL}).`,
      text,
    ].join("\n")
  }

  const parts = [`frames detected: ${frames.length}`, ...frames.map((frame) => renderKiroFrameEntry(frame, options))]
  if (trailingBytes) parts.push(`bytes outside any detected frame: ${trailingBytes}`)
  return parts.join("\n\n")
}

/** Classic 16-byte-per-line hexdump with an ASCII gutter. */
export function hexdumpText(text: string, options: { limit?: number } = {}): string {
  const bytes = ENCODER.encode(text)
  const shown = options.limit === undefined ? bytes : bytes.subarray(0, Math.max(0, options.limit))
  const lines: string[] = []

  for (let offset = 0; offset < shown.length; offset += 16) {
    const row = shown.subarray(offset, offset + 16)
    const hex = Array.from(row, (byte) => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ")
    const ascii = Array.from(row, (byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".")).join("")
    lines.push(`${offset.toString(16).padStart(4, "0")}  ${hex}  |${ascii}|`)
  }

  return lines.join("\n")
}

function findPayloadStart(text: string, from: number) {
  let best = -1

  for (const pattern of KIRO_FRAME_PAYLOAD_PATTERNS) {
    let searchFrom = from
    while (searchFrom < text.length) {
      const index = text.indexOf(pattern, searchFrom)
      if (index < 0) break
      if (index === from || isLikelyTopLevel(text, index)) {
        if (best < 0 || index < best) best = index
        break
      }
      searchFrom = index + 1
    }
  }

  return best
}

function findJsonEnd(text: string, from: number) {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = from; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }

  return -1
}

/**
 * Reads the `:event-type` header value out of a frame prelude. The two length bytes and the
 * value-type byte that sit between the header name and the value are all control bytes, so
 * skipping the control run lands on the first character of the name.
 */
function readEventType(prelude: string) {
  const marker = prelude.lastIndexOf(EVENT_TYPE_HEADER)
  if (marker < 0) return undefined
  const match = /^[\u0000-\u001f]*([A-Za-z][A-Za-z0-9_]*)/.exec(prelude.slice(marker + EVENT_TYPE_HEADER.length))
  return match?.[1]
}

function byteLength(text: string) {
  return ENCODER.encode(text).length
}
