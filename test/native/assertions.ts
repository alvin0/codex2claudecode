// Role: assertion constructors for the case registry. Every one is structural — status
// code, block presence, notice presence, usage counters, upstream payload shape, byte
// equality. Nothing here reads model prose (Requirement 24.8).
import { passthroughByteDiff } from "./byte-diff"
import {
  blockTypes,
  errorMessage,
  eventTypes,
  featureNotices,
  noticeFor,
  noticeMentions,
  serverToolCount,
  SYNTHESIZED_CLIENT_TOOL_NAMES,
  toolUseNames,
  upstreamEffortLevel,
  upstreamPayloadHasKey,
  type ServerToolCounterKey,
} from "./observation"
import type { NativeLiveAssertion, NativeLiveObservation } from "./types"

const pass = { ok: true } as const

function fail(detail: string) {
  return { ok: false as const, detail }
}

export function assertion(
  id: string,
  description: string,
  evaluate: NativeLiveAssertion["evaluate"],
): NativeLiveAssertion {
  return { id, description, evaluate }
}

export function expectStatus(status: number) {
  return assertion(`status-${status}`, `responds with status ${status}`, (observation) =>
    observation.status === status ? pass : fail(`status was ${observation.status}`),
  )
}

/** A feature named in the error message, for cases whose declared outcome is a rejection. */
export function expectErrorMentions(...needles: string[]) {
  return assertion(
    `error-mentions-${needles.join("-")}`,
    `error message names ${needles.join(" and ")}`,
    (observation) => {
      const message = (errorMessage(observation) ?? "").toLowerCase()
      if (!message) return fail("no error message was returned")
      const missing = needles.filter((needle) => !message.includes(needle.toLowerCase()))
      return missing.length ? fail(`error message omits ${missing.join(", ")}`) : pass
    },
  )
}

export function expectNotice(feature: string) {
  return assertion(`notice-${feature}`, `emits a feature notice for ${feature}`, (observation) =>
    noticeFor(observation, feature) ? pass : fail(`no notice for ${feature}; observed [${observedFeatures(observation)}]`),
  )
}

export function expectNoNotice(feature: string) {
  return assertion(`no-notice-${feature}`, `emits zero feature notices for ${feature}`, (observation) =>
    noticeFor(observation, feature) ? fail(`unexpected notice for ${feature}`) : pass,
  )
}

export function expectNoticeMentions(needle: string) {
  return assertion(`notice-mentions-${needle}`, `a feature notice mentions ${needle}`, (observation) =>
    noticeMentions(observation, needle) ? pass : fail(`no notice mentions ${needle}; observed [${observedFeatures(observation)}]`),
  )
}

/**
 * The no-silent-drop check for one feature: the run either carries a notice naming it or
 * returns a rejection naming it. A 200 with neither is the defect this whole feature fixes
 * (Requirement 10.1). Keywords cover the wire spelling a rejection message would use.
 */
export function expectDeclaredOutcome(feature: string, keywords: string[] = []) {
  const needles = [feature, ...keywords]
  return assertion(
    `declared-outcome-${feature}`,
    `${feature} resolves to a declared policy — a notice or a rejection naming it`,
    (observation) => {
      if (observation.status >= 400) {
        const message = (errorMessage(observation) ?? "").toLowerCase()
        return needles.some((needle) => message.includes(needle.toLowerCase()))
          ? pass
          : fail(`rejected without naming ${feature}: ${truncate(message)}`)
      }
      if (noticeFor(observation, feature)) return pass
      if (needles.some((needle) => noticeMentions(observation, needle))) return pass
      return fail(`status ${observation.status} with no notice for ${feature}; observed [${observedFeatures(observation)}]`)
    },
  )
}

export function expectBlockType(type: string) {
  return assertion(`block-${type}`, `returns a ${type} block`, (observation) =>
    blockTypes(observation).includes(type) ? pass : fail(`no ${type} block; observed [${blockTypes(observation).join(", ")}]`),
  )
}

export function expectNoBlockType(type: string) {
  return assertion(`no-block-${type}`, `returns zero ${type} blocks`, (observation) =>
    blockTypes(observation).includes(type) ? fail(`unexpected ${type} block`) : pass,
  )
}

export function expectEventType(type: string) {
  return assertion(`event-${type}`, `stream carries a ${type} event`, (observation) =>
    eventTypes(observation).includes(type) ? pass : fail(`no ${type} event; observed [${unique(eventTypes(observation)).join(", ")}]`),
  )
}

export function expectServerToolCount(key: ServerToolCounterKey, minimum: number) {
  return assertion(`usage-${key}-min-${minimum}`, `usage.server_tool_use.${key} is at least ${minimum}`, (observation) => {
    const count = serverToolCount(observation, key)
    return count >= minimum ? pass : fail(`${key} was ${count}`)
  })
}

/** No tool call the model did not emit (Requirements 17.3, 17.7). */
export function expectNoSynthesizedClientToolCalls() {
  return assertion(
    "no-synthesized-client-tool-calls",
    `returns zero synthesized ${SYNTHESIZED_CLIENT_TOOL_NAMES.join(" / ")} tool calls`,
    (observation) => {
      const synthesized = toolUseNames(observation).filter((name) =>
        SYNTHESIZED_CLIENT_TOOL_NAMES.some((candidate) => candidate.toLowerCase() === name.toLowerCase()),
      )
      return synthesized.length ? fail(`synthesized tool calls: ${unique(synthesized).join(", ")}`) : pass
    },
  )
}

/** Every server-tool result pairs with the server_tool_use block that produced it. */
export function expectServerToolResultsArePaired() {
  return assertion(
    "server-tool-results-paired",
    "every web_search_tool_result / web_fetch_tool_result block pairs with a server_tool_use block",
    (observation) => {
      const types = blockTypes(observation)
      const results = types.filter((type) => type === "web_search_tool_result" || type === "web_fetch_tool_result").length
      if (!results) return pass
      const uses = types.filter((type) => type === "server_tool_use").length
      return uses >= results ? pass : fail(`${results} server tool results but only ${uses} server_tool_use blocks`)
    },
  )
}

export function expectUpstreamPayloadOmits(...keys: string[]) {
  return assertion(
    `upstream-omits-${keys.join("-")}`,
    `upstream payload omits ${keys.join(" and ")}`,
    (observation) => {
      if (!observation.upstreamRequestBody) return fail("no upstream request body was captured")
      const present = keys.filter((key) => upstreamPayloadHasKey(observation, key))
      return present.length ? fail(`upstream payload carries ${present.join(", ")}`) : pass
    },
  )
}

export function expectUpstreamEffortPresent() {
  return assertion("upstream-effort-present", "upstream payload carries a reasoning effort level", (observation) => {
    if (!observation.upstreamRequestBody) return fail("no upstream request body was captured")
    const effort = upstreamEffortLevel(observation)
    return effort ? pass : fail("upstream payload carries no effort level")
  })
}

export function expectUpstreamEffortIn(levels: readonly string[]) {
  return assertion(
    `upstream-effort-in-${levels.join("-")}`,
    `upstream effort level is one of ${levels.join(", ")}`,
    (observation) => {
      const effort = upstreamEffortLevel(observation)
      if (!effort) return fail("upstream payload carries no effort level")
      return levels.includes(effort) ? pass : fail(`upstream effort was ${effort}`)
    },
  )
}

export function expectUpstreamRequestCount(expected: number) {
  return assertion(`upstream-request-count-${expected}`, `issues exactly ${expected} upstream request(s)`, (observation) => {
    if (observation.upstreamRequestCount === undefined) return fail("upstream request count was not recorded")
    return observation.upstreamRequestCount === expected
      ? pass
      : fail(`issued ${observation.upstreamRequestCount} upstream requests`)
  })
}

/**
 * The exact half of the passthrough claim (Requirement 29.3): the bytes handed to the client
 * are the bytes the gateway itself captured coming back from upstream. One body, two
 * observation points, so this comparison is raw and needs no normalization — any rendering,
 * re-chunking, or re-framing on the way out fails it.
 */
export function expectClientBytesEqualCapturedUpstreamBytes() {
  return assertion(
    "client-bytes-equal-captured-upstream-bytes",
    "client bytes equal the upstream bytes the gateway captured for this request",
    (observation) => {
      const captured = observation.requestLog?.proxy?.responseBody ?? observation.upstreamResponseBody
      if (captured === undefined) return fail("no upstream response bytes were captured for this request")
      if (captured === observation.clientBody) return pass
      return fail(
        `client bytes differ from the captured upstream bytes (client ${observation.clientBody.length} bytes, captured ${captured.length} bytes)`,
      )
    },
  )
}

/**
 * The comparative half (Requirement 29.3): the client bytes against a second, independent
 * direct upstream call, with only the per-call volatile values normalized. Run_Record 19
 * measured that a raw string comparison here is unsatisfiable — two live generations never
 * share their ids, `created_at`, `prompt_cache_key`, `safety_identifier`, `obfuscation`, or
 * `encrypted_content` — so this compares the full normalized text plus the event-name/type
 * sequence instead. Run_Record 20 then measured that normalizing ids *by key name* misses the
 * same id spelled `item_id`, so ids are normalized by shape and labelled by first occurrence,
 * which keeps a re-minted id detectable. See `byte-diff.ts` for the enumerated field list, the
 * id shape, and what the comparison does and does not prove.
 */
export function expectBytesMatchDirectCallModuloVolatileFields() {
  return assertion(
    "bytes-match-direct-call-modulo-volatile-fields",
    "client bytes match a direct upstream call frame for frame, with only per-call volatile fields normalized",
    (observation) => {
      if (observation.directUpstreamBody === undefined) return fail("no direct upstream call was recorded")
      const diff = passthroughByteDiff(observation.clientBody, observation.directUpstreamBody)
      return diff.ok ? pass : fail(diff.detail)
    },
  )
}

function observedFeatures(observation: NativeLiveObservation) {
  return featureNotices(observation)
    .map((notice) => notice.feature)
    .join(", ")
}

function unique(values: string[]) {
  return [...new Set(values)]
}

function truncate(text: string, limit = 200) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
