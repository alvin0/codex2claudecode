// Role: read one `NativeLiveObservation` — pure projections over what the run produced.
// Nothing here performs I/O, so both the assertions and the transcript writer can call it.
import type { JsonObject, RequestLogEntry } from "../../src/core/types"

import type { NativeLiveObservation, NativeObservedNotice, NativeSseEvent } from "./types"

/**
 * Marker the Claude notice renderer prefixes to the first text block (design D2/D5).
 * The harness reads notices from telemetry when the field exists and falls back to this
 * rendered form, so a case can observe a notice before and after the telemetry lands.
 */
export const GATEWAY_NOTICE_MARKER = "[gateway]"

/** The one warning line: everything after `<marker> not honored as sent:` is the feature list. */
const NOTICE_LINE = /not honored as sent:\s*(.*)$/
const FEATURE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/

/** Client web tool names the Kiro heuristics used to synthesize (Requirement 17.7). */
export const SYNTHESIZED_CLIENT_TOOL_NAMES = ["WebSearch", "WebFetch", "list_allowed_directories"] as const

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function objectAt(value: unknown, key: string): JsonObject | undefined {
  if (!isJsonObject(value)) return undefined
  const nested = value[key]
  return isJsonObject(nested) ? nested : undefined
}

function stringAt(value: unknown, key: string): string | undefined {
  if (!isJsonObject(value)) return undefined
  const nested = value[key]
  return typeof nested === "string" ? nested : undefined
}

function arrayAt(value: unknown, key: string): unknown[] {
  if (!isJsonObject(value)) return []
  const nested = value[key]
  return Array.isArray(nested) ? nested : []
}

/** Event names plus payload `type` values, so Claude and OpenAI streams read the same way. */
export function eventTypes(observation: NativeLiveObservation): string[] {
  const types: string[] = []
  for (const event of observation.clientEvents) {
    if (event.event) types.push(event.event)
    const dataType = stringAt(event.data, "type")
    if (dataType && dataType !== event.event) types.push(dataType)
  }
  return types
}

export function hasEventType(observation: NativeLiveObservation, type: string) {
  return eventTypes(observation).includes(type)
}

/** Content block types from the JSON body, the SSE stream, and OpenAI output items. */
export function blockTypes(observation: NativeLiveObservation): string[] {
  const types: string[] = []

  for (const block of arrayAt(observation.clientJson, "content")) {
    const type = stringAt(block, "type")
    if (type) types.push(type)
  }

  for (const item of arrayAt(observation.clientJson, "output")) {
    const type = stringAt(item, "type")
    if (type) types.push(type)
    for (const block of arrayAt(item, "content")) {
      const blockType = stringAt(block, "type")
      if (blockType) types.push(blockType)
    }
  }

  for (const event of observation.clientEvents) {
    const block = objectAt(event.data, "content_block")
    const type = block ? stringAt(block, "type") : undefined
    if (type) types.push(type)
    const item = objectAt(event.data, "item")
    const itemType = item ? stringAt(item, "type") : undefined
    if (itemType) types.push(itemType)
  }

  return types
}

export function hasBlockType(observation: NativeLiveObservation, type: string) {
  return blockTypes(observation).includes(type)
}

/** Names of `tool_use` / `mcp_tool_use` blocks, whichever channel carried them. */
export function toolUseNames(observation: NativeLiveObservation): string[] {
  const names: string[] = []

  for (const block of arrayAt(observation.clientJson, "content")) {
    if (!isToolUseType(stringAt(block, "type"))) continue
    const name = stringAt(block, "name")
    if (name) names.push(name)
  }

  for (const event of observation.clientEvents) {
    const block = objectAt(event.data, "content_block")
    if (!block || !isToolUseType(stringAt(block, "type"))) continue
    const name = stringAt(block, "name")
    if (name) names.push(name)
  }

  return names
}

function isToolUseType(type: string | undefined) {
  return type === "tool_use" || type === "mcp_tool_use" || type === "server_tool_use"
}

/** Every usage object the response carried, merged shallowly in arrival order. */
export function usage(observation: NativeLiveObservation): JsonObject {
  const merged: JsonObject = {}
  const sources: Array<JsonObject | undefined> = [
    objectAt(observation.clientJson, "usage"),
    objectAt(objectAt(observation.clientJson, "response"), "usage"),
  ]

  for (const event of observation.clientEvents) {
    sources.push(objectAt(event.data, "usage"))
    sources.push(objectAt(objectAt(event.data, "message"), "usage"))
    sources.push(objectAt(objectAt(event.data, "response"), "usage"))
  }

  for (const source of sources) {
    if (!source) continue
    Object.assign(merged, source)
  }
  return merged
}

export type ServerToolCounterKey = "web_search_requests" | "web_fetch_requests" | "mcp_calls"

export function serverToolCount(observation: NativeLiveObservation, key: ServerToolCounterKey) {
  const serverToolUse = objectAt(usage(observation), "server_tool_use")
  const value = serverToolUse?.[key]
  return typeof value === "number" ? value : 0
}

/** All model text the client received, used only for notice detection — never asserted on. */
export function clientText(observation: NativeLiveObservation): string {
  const parts: string[] = []

  for (const block of arrayAt(observation.clientJson, "content")) {
    const text = stringAt(block, "text")
    if (text) parts.push(text)
  }

  for (const event of observation.clientEvents) {
    const deltaText = stringAt(objectAt(event.data, "delta"), "text")
    if (deltaText) parts.push(deltaText)
    const blockText = stringAt(objectAt(event.data, "content_block"), "text")
    if (blockText) parts.push(blockText)
    const outputDelta = stringAt(event.data, "delta")
    if (outputDelta) parts.push(outputDelta)
  }

  return parts.join("")
}

export function errorMessage(observation: NativeLiveObservation): string | undefined {
  const error = observation.clientJson?.error
  if (typeof error === "string") return error
  const message = stringAt(error, "message")
  if (message) return message
  const topLevel = stringAt(observation.clientJson, "message")
  if (topLevel) return topLevel
  if (observation.status >= 400) return observation.clientBody
  return undefined
}

/** The upstream payload as parsed JSON, so payload-shape assertions read keys not substrings. */
export function upstreamPayload(observation: NativeLiveObservation): JsonObject | undefined {
  if (!observation.upstreamRequestBody) return undefined
  try {
    const parsed = JSON.parse(observation.upstreamRequestBody) as unknown
    return isJsonObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** True when `key` occurs anywhere in the upstream payload, at any depth. */
export function upstreamPayloadHasKey(observation: NativeLiveObservation, key: string): boolean {
  const payload = upstreamPayload(observation)
  if (!payload) return false
  return hasKeyDeep(payload, key)
}

function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasKeyDeep(entry, key))
  if (!isJsonObject(value)) return false
  if (Object.prototype.hasOwnProperty.call(value, key)) return true
  return Object.values(value).some((entry) => hasKeyDeep(entry, key))
}

/**
 * Reasoning effort the Kiro payload carried, from either schema path
 * (`additionalModelRequestFields.output_config.effort` or `…reasoning.effort`).
 */
export function upstreamEffortLevel(observation: NativeLiveObservation): string | undefined {
  const fields = objectAt(upstreamPayload(observation), "additionalModelRequestFields")
  if (!fields) return undefined
  return stringAt(objectAt(fields, "output_config"), "effort")
    ?? stringAt(objectAt(fields, "reasoning"), "effort")
    ?? stringAt(fields, "effort")
}

/**
 * Notices observed for this run. Telemetry is authoritative once it exists; the rendered
 * warning segment is the fallback so the harness can observe a notice through either channel.
 */
export function featureNotices(observation: NativeLiveObservation): NativeObservedNotice[] {
  const fromTelemetry = telemetryNotices(observation.requestLog)
  if (fromTelemetry.length) return fromTelemetry
  return textNotices(clientText(observation) || observation.clientBody)
}

export function noticeFor(observation: NativeLiveObservation, feature: string) {
  return featureNotices(observation).find((notice) => notice.feature === feature)
}

export function noticeMentions(observation: NativeLiveObservation, needle: string) {
  const lowered = needle.toLowerCase()
  return featureNotices(observation).some(
    (notice) => notice.feature.toLowerCase().includes(lowered) || (notice.detail ?? "").toLowerCase().includes(lowered),
  )
}

function telemetryNotices(entry: RequestLogEntry | undefined): NativeObservedNotice[] {
  // `telemetry` lands on RequestProxyLog in M4; read it structurally until the type exists.
  const proxy = entry?.proxy as JsonObject | undefined
  const candidates = [proxy?.telemetry, objectAt(proxy, "debug")?.telemetry, proxy?.featureNotices]
  for (const candidate of candidates) {
    const notices = isJsonObject(candidate) ? candidate.featureNotices : candidate
    if (!Array.isArray(notices)) continue
    const parsed = notices.flatMap<NativeObservedNotice>((notice) => {
      const feature = stringAt(notice, "feature")
      if (!feature) return []
      const declared = stringAt(notice, "policy")
      const policy = declared === "degrade" || declared === "emulate" ? declared : undefined
      const detail = stringAt(notice, "detail")
      return [
        {
          feature,
          ...(policy ? { policy } : {}),
          ...(detail ? { detail } : {}),
          source: "telemetry",
        },
      ]
    })
    if (parsed.length) return parsed
  }
  return []
}

/**
 * Parses the rendered warning segment: one `<marker> not honored as sent: a, b, c` line.
 *
 * Feature names only — the renderers stopped putting `detail` in front of the model text, so a
 * notice observed through this channel carries no `detail`. `featureNotices()` prefers telemetry
 * precisely because that channel still has it; this stays the fallback that answers *which*
 * features were reported when telemetry is absent.
 */
export function textNotices(text: string): NativeObservedNotice[] {
  const markerIndex = text.indexOf(GATEWAY_NOTICE_MARKER)
  if (markerIndex < 0) return []

  const line = text.slice(markerIndex).split(/\r?\n/)[0] ?? ""
  const match = NOTICE_LINE.exec(line)
  if (!match) return []

  return match[1]!
    .split(",")
    .map((feature) => feature.trim())
    .filter((feature) => FEATURE_NAME.test(feature))
    .map((feature) => ({ feature, source: "text" as const }))
}
