// Role: harness contracts shared by the case registry, the assertion helpers, the
// gateway lifecycle, and the live test. Types only — no behavior, no case data.
//
// The live harness proves fidelity against the real providers, so every contract here
// is expressed in terms of what a client can observe: status, blocks, notices, usage
// counters, the bytes the upstream received, and the bytes the upstream sent back.
import type { JsonObject, RequestLogEntry } from "../../src/core/types"

import type { NativeLiveCaseId } from "./cases"

/** The two connected accounts in this environment (Requirement 24.12). */
export type NativeUpstreamKind = "kiro" | "codex"

/** The two inbound routes the cases exercise. */
export type NativeRoutePath = "/v1/messages" | "/v1/responses"

/** Recorded pre-implementation state of a case (Requirements 24.5, 24.6). */
export type NativeBaselineState = "red" | "green"

/** The four native-mode flags. `src/app/native-flags.ts` becomes their only reader in M7. */
export type NativeFlagName =
  | "NATIVE_STRICT"
  | "NATIVE_PASSTHROUGH"
  | "NATIVE_MCP_EMULATION"
  | "KIRO_WEB_SEARCH_HEURISTICS"

/** Flag values a case needs in effect. A flag absent from the map is unset, never inherited. */
export type NativeFlagValues = Readonly<Partial<Record<NativeFlagName, string>>>

export interface NativeSseEvent {
  event?: string
  data: unknown
}

/** One notice observed on the wire, whatever channel carried it. */
export interface NativeObservedNotice {
  feature: string
  policy?: "degrade" | "emulate"
  detail?: string
  /** `telemetry` when read from the request log, `text` when parsed from the rendered warning. */
  source: "telemetry" | "text"
}

/**
 * Everything one live case run produced. The live test fills this in; the assertions and
 * the transcript writer only read it, so neither of them talks to the network.
 */
export interface NativeLiveObservation {
  caseId: NativeLiveCaseId
  status: number
  headers: Readonly<Record<string, string>>
  /** Raw body returned to the client: JSON text, or SSE text for streaming cases. */
  clientBody: string
  /** Parsed client body when the response was JSON. */
  clientJson?: JsonObject
  /** Parsed client events when the response was SSE. */
  clientEvents: readonly NativeSseEvent[]
  /** Captured through `RequestOptions.onRequestBody` and carried in the request log. */
  upstreamRequestBody?: string
  /** Captured through `RequestOptions.onResponseBodyChunk` and carried in the request log. */
  upstreamResponseBody?: string
  /** Number of upstream calls the run made, when the run could count them. */
  upstreamRequestCount?: number
  /** The gateway request log entry for this run, the source of proxy and telemetry data. */
  requestLog?: RequestLogEntry
  /** Bytes from a direct upstream call, present only for the byte-equality case. */
  directUpstreamBody?: string
}

export type NativeAssertionResult = { ok: true } | { ok: false; detail: string }

/**
 * One structural check. `evaluate` is pure over the observation so the same assertion
 * list drives both the test result and the transcript's `## assertions` section.
 */
export interface NativeLiveAssertion {
  id: string
  description: string
  evaluate: (observation: NativeLiveObservation) => NativeAssertionResult
}

export interface NativeLiveCase {
  id: NativeLiveCaseId
  /** One line a human reads in the transcript header. */
  title: string
  upstream: NativeUpstreamKind
  route: NativeRoutePath
  /** Wire body sent to the gateway, with `{{MCP_SERVER_URL}}` left for the fixture to fill. */
  body: JsonObject
  flags: NativeFlagValues
  baseline: NativeBaselineState
  /** True when the case needs the loopback MCP fixture (Requirement 24.10). */
  requiresMcpFixture?: boolean
  /** True when the case needs a second, direct upstream call to diff bytes against. */
  requiresDirectUpstreamCall?: boolean
  assertions: readonly NativeLiveAssertion[]
}
