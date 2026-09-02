// Properties 7 and 8 for inbound notice rendering (task 9.4).
//
// The example-based blocks already cover fixed notice lists on fixed response shapes:
// `test/inbound/claude-notice.test.ts` (body + SSE) and `test/inbound/openai-notice.test.ts`
// (Responses and chat completions, each streaming and non-streaming). This file covers what
// neither can: that the clauses hold for *any* notice list on *any* of the shapes, across all
// **six** render paths that reach a client, with the notice delivery point generated rather than
// fixed.
//
// The six paths, all exercised by every property below:
//   1. Claude message body            `canonicalResponseToClaudeMessage()`
//   2. Claude SSE stream              `claudeCanonicalStreamResponse()`
//   3. OpenAI Responses body          `canonicalResponseToResponsesBody()`
//   4. OpenAI chat completions body   `canonicalResponseToChatCompletion()`
//   5. OpenAI Responses SSE           `openAICanonicalStreamResponse("/v1/responses")`
//   6. OpenAI chat completions SSE    `openAICanonicalStreamResponse("/v1/chat/completions")`
//
// Testing only the two pure renderers would prove the string shape and miss placement, which is
// where Requirement 9.6's "no additional delivery mechanism" clause actually lives.
//
// Notices are supplied directly as canonical events / `Canonical_Response.featureNotices`. No
// upstream emits one here — that is task 10.3/10.4 — so this file stays on the inbound side of
// the canonical boundary.
//
// ---------------------------------------------------------------------------------------------
// Two readings this file commits to, both design-sanctioned rather than discovered
// ---------------------------------------------------------------------------------------------
//
// (a) **Delivery point.** Design D2's ordering rule says a notice decided after text was already
//     emitted cannot lead that text, so it trails instead. A notice list scattered across the
//     first-text boundary therefore legitimately renders as an early segment *and* a late one.
//     Property 7's "exactly one warning segment" is read as **per delivery point**: the plan
//     below carries a generated delivery slot (`before` the first text, or `afterFirstText`), and
//     the one-segment clause is asserted for plans that deliver at a single slot. The
//     across-the-boundary case is asserted separately, as its own documented two-segment
//     behavior, where Requirement 9.4 still holds in the form that matters — each notice renders
//     in exactly one segment and never twice.
//
// (b) **A created text block.** Design D2 explicitly sanctions creating a text block "only if the
//     response has none": on a tool-call-only turn that is the only way a notice reaches a client
//     at all. A literal reading of "no block type the notice-free rendering lacks" would flag it.
//     The clause is therefore expressed as: the warned rendering introduces no *new kind of
//     thing* — no SSE event name, no `type` value, no field name, no header — that the same path
//     does not already produce for a response carrying text. Where the notice-free rendering
//     already carries text, the strong form is asserted instead: the vocabularies are *equal*.
//
// ---------------------------------------------------------------------------------------------
// "Each feature name appears once" vs "dedupe by (feature, detail)"
// ---------------------------------------------------------------------------------------------
//
// Two degrade notices sharing a feature but carrying different details survive deduping, so the
// feature name appears on two lines. Requirement 9.4 asks for "one combined warning rather than
// one warning per notice", which constrains the number of warning *segments*, not the number of
// lines: two distinct degradations of one feature are two facts the client needs. So Property 7's
// "every notice's feature name appears in it exactly once" is read as *every notice appears
// exactly once* — the parsed `(feature, detail)` list equals the first-seen dedupe of the degrade
// notices, so no notice is ever repeated. The literal per-name form is asserted too, in the arm
// that generates one detail per feature, where the two readings coincide.
//
// **Validates: Requirements 9.1, 9.2, 9.4, 9.6, 10.7**

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type {
  Canonical_ContentBlock,
  Canonical_Event,
  Canonical_FeatureNotice,
  Canonical_FeatureNoticePolicy,
  Canonical_Response,
  Canonical_StreamResponse,
} from "../../src/core/canonical"
import { PROVIDER_FEATURES } from "../../src/core/provider-capabilities"
import { CLAUDE_NOTICE_MARKER, prependClaudeWarning, renderClaudeFeatureWarning } from "../../src/inbound/claude/notice"
import { canonicalResponseToClaudeMessage, claudeCanonicalStreamResponse } from "../../src/inbound/claude/response"
import { OPENAI_NOTICE_MARKER, prependOpenAIWarning, renderOpenAIFeatureWarning } from "../../src/inbound/openai/notice"
import {
  canonicalResponseToChatCompletion,
  canonicalResponseToResponsesBody,
  openAICanonicalStreamResponse,
} from "../../src/inbound/openai/response"
import type { ClaudeMessagesRequest } from "../../src/inbound/types"
import { textNotices } from "../native/observation"

// ---------------------------------------------------------------------------------------------
// Generators — notices
// ---------------------------------------------------------------------------------------------

/**
 * Characters allowed inside generated text. Excludes `[`, `<` and `:` so generated content can
 * never be mistaken for the notice marker, for inline markup, or for a notice line — a failure
 * would otherwise be blamed on the noise rather than on the property.
 */
const SAFE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.=".split("")

function safeText(minLength: number, maxLength: number) {
  return fc.array(fc.constantFrom(...SAFE_CHARS), { minLength, maxLength }).map((chars) => chars.join(""))
}

/** Spelled through the canonical alias so a change to the policy union breaks this file. */
const NOTICE_POLICIES = ["degrade", "emulate"] as const satisfies readonly Canonical_FeatureNoticePolicy[]

/**
 * A small pool of realistic details, weighted above freely generated text.
 *
 * The pool is small on purpose: with 11 features and 5 details, a list of two to four notices
 * repeats an entry often, so *exact* duplicates (dedupe collapses them) and *near*-duplicates
 * (same feature, different detail — dedupe keeps both) are both common in ordinary runs rather
 * than only in the dedicated arms. The last entry spans lines, so detail flattening is exercised
 * by the general property too: an unflattened detail would break the one-notice-one-line shape
 * the harness parser reads.
 */
const NOTICE_DETAILS = [
  "temperature=0.2 was not sent upstream",
  "top_p=0.9 was not sent upstream",
  "response_format emulated via a tool",
  "stop sequences were dropped",
  "tools/list failed\n  connection reset\n",
]

const noticeDetail = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...NOTICE_DETAILS) },
  // Non-empty and never whitespace-only, so every generated notice stays inside Requirement 8.1.
  { weight: 1, arbitrary: safeText(1, 16).map((text) => `detail ${text}`) },
)

/** Features come from the real vocabulary, never from invented names. */
const featureNotice: fc.Arbitrary<Canonical_FeatureNotice> = fc.record({
  feature: fc.constantFrom(...PROVIDER_FEATURES),
  policy: fc.constantFrom(...NOTICE_POLICIES),
  detail: noticeDetail,
})

const degradeNotice: fc.Arbitrary<Canonical_FeatureNotice> = fc.record({
  feature: fc.constantFrom(...PROVIDER_FEATURES),
  policy: fc.constant("degrade"),
  detail: noticeDetail,
})

const emulateNotice: fc.Arbitrary<Canonical_FeatureNotice> = fc.record({
  feature: fc.constantFrom(...PROVIDER_FEATURES),
  policy: fc.constant("emulate"),
  detail: noticeDetail,
})

/**
 * At least one `degrade` notice, with anything (including more degrades, emulates, and exact
 * repeats) after it. Property 7 is about a non-empty degrade list; the emulate members riding
 * along are the interference Requirement 9.2 says must not show.
 */
const degradeBearingNotices = fc
  .tuple(degradeNotice, fc.array(featureNotice, { maxLength: 3 }))
  .map(([first, rest]) => [first, ...rest])

// ---------------------------------------------------------------------------------------------
// Generators — response shapes
// ---------------------------------------------------------------------------------------------

/**
 * One generated response, in both the forms the six paths need: content blocks for the three
 * non-streaming paths and a canonical event list for the three streaming ones. Both describe the
 * same turn, so the same notice list can be rendered through either.
 */
interface Scenario {
  label: string
  /** Text the model itself produced, as the client should see it once the warning is stripped. */
  plainText: string
  content: Canonical_ContentBlock[]
  /** The notice-free canonical event list. */
  events: Canonical_Event[]
  /** Index in `events` of the event that first puts text on the wire; `-1` when none does. */
  firstTextIndex: number
  stopReason: string
}

const TOOL_CALL: Canonical_ContentBlock = { type: "tool_call", id: "fc_1", callId: "call_1", name: "Read", arguments: "{}" }
const TOOL_CALL_DONE: Canonical_Event = { type: "tool_call_done", callId: "call_1", name: "Read", arguments: "{}" }

function stop(stopReason: string): Canonical_Event {
  return { type: "message_stop", stopReason }
}

/** One text delta — the ordinary shape. */
function oneDeltaScenario(text: string): Scenario {
  return {
    label: "text",
    plainText: text,
    content: [{ type: "text", text }],
    events: [{ type: "text_delta", delta: text }, stop("end_turn")],
    firstTextIndex: 0,
    stopReason: "end_turn",
  }
}

/** Several deltas, so a notice can land *between* two of them without splitting the block. */
function multiDeltaScenario(parts: string[]): Scenario {
  const text = parts.join("")
  return {
    label: "multiDelta",
    plainText: text,
    content: [{ type: "text", text }],
    events: [...parts.map<Canonical_Event>((delta) => ({ type: "text_delta", delta })), stop("end_turn")],
    firstTextIndex: 0,
    stopReason: "end_turn",
  }
}

/** `text_done` opens the block instead of a delta — a separate branch in both stream writers. */
function textDoneScenario(text: string): Scenario {
  return {
    label: "textDone",
    plainText: text,
    content: [{ type: "text", text }],
    events: [{ type: "text_done", text }, stop("end_turn")],
    firstTextIndex: 0,
    stopReason: "end_turn",
  }
}

/** No text at all: the shape where design D2 sanctions creating a text block for the warning. */
function toolCallOnlyScenario(): Scenario {
  return {
    label: "toolCallOnly",
    plainText: "",
    content: [TOOL_CALL],
    events: [TOOL_CALL_DONE, stop("tool_use")],
    firstTextIndex: -1,
    stopReason: "tool_use",
  }
}

/** Text that arrives *after* a tool call, so the first text block is not the first block. */
function toolThenTextScenario(text: string): Scenario {
  return {
    label: "toolThenText",
    plainText: text,
    content: [TOOL_CALL, { type: "text", text }],
    events: [TOOL_CALL_DONE, { type: "text_delta", delta: text }, stop("tool_use")],
    firstTextIndex: 1,
    stopReason: "tool_use",
  }
}

const modelText = safeText(1, 14).map((text) => `say ${text}`)

const scenario: fc.Arbitrary<Scenario> = fc.oneof(
  { weight: 4, arbitrary: modelText.map(oneDeltaScenario) },
  { weight: 3, arbitrary: fc.array(modelText, { minLength: 2, maxLength: 3 }).map(multiDeltaScenario) },
  { weight: 2, arbitrary: modelText.map(textDoneScenario) },
  { weight: 2, arbitrary: fc.constant(undefined).map(toolCallOnlyScenario) },
  { weight: 2, arbitrary: modelText.map(toolThenTextScenario) },
)

/** Text-bearing scenarios only, for the properties that need the model to have spoken. */
const textBearingScenario: fc.Arbitrary<Scenario> = fc.oneof(
  { weight: 4, arbitrary: modelText.map(oneDeltaScenario) },
  { weight: 3, arbitrary: fc.array(modelText, { minLength: 2, maxLength: 3 }).map(multiDeltaScenario) },
  { weight: 2, arbitrary: modelText.map(textDoneScenario) },
  { weight: 2, arbitrary: modelText.map(toolThenTextScenario) },
)

// ---------------------------------------------------------------------------------------------
// Generators — the delivery plan
// ---------------------------------------------------------------------------------------------

/**
 * Where a group of notices is handed to the inbound renderer.
 *
 * `before` is the ordinary case — decided while the payload was built, so queued before any
 * content. `afterFirstText` is design D2's late notice: decided once text was already on the
 * wire, so it can only trail. A plan with one group delivers at one point; a plan with both
 * groups is the across-the-boundary case of reading (a).
 */
type DeliverySlot = "before" | "afterFirstText"

interface NoticeGroup {
  notices: Canonical_FeatureNotice[]
  at: DeliverySlot
}

type NoticePlan = NoticeGroup[]

function singleSlotPlan(notices: fc.Arbitrary<Canonical_FeatureNotice[]>): fc.Arbitrary<NoticePlan> {
  return fc
    .tuple(notices, fc.constantFrom<DeliverySlot>("before", "afterFirstText"))
    .map(([members, at]) => [{ notices: members, at }])
}

function planNotices(plan: NoticePlan): Canonical_FeatureNotice[] {
  return plan.flatMap((group) => group.notices)
}

/**
 * Slot index inside a scenario's event list.
 *
 * A late notice goes immediately after the event that first put text on the wire. A scenario that
 * never emits text has no "after text" — the notice lands just before `message_stop`, which is
 * still the last moment it can be decided, and it reaches the client through the created text
 * block either way.
 */
function slotIndex(scenario: Scenario, at: DeliverySlot) {
  if (at === "before") return 0
  if (scenario.firstTextIndex >= 0) return scenario.firstTextIndex + 1
  return Math.max(scenario.events.length - 1, 0)
}

function buildEvents(scenario: Scenario, plan: NoticePlan): Canonical_Event[] {
  const slots = new Map<number, Canonical_FeatureNotice[]>()
  for (const group of plan) {
    const index = slotIndex(scenario, group.at)
    slots.set(index, [...(slots.get(index) ?? []), ...group.notices])
  }

  const events: Canonical_Event[] = []
  for (let index = 0; index <= scenario.events.length; index += 1) {
    for (const notice of slots.get(index) ?? []) events.push({ type: "feature_notice", ...notice })
    if (index < scenario.events.length) events.push(scenario.events[index]!)
  }
  return events
}

function canonicalResponse(scenario: Scenario, notices: readonly Canonical_FeatureNotice[]): Canonical_Response {
  return {
    type: "canonical_response",
    id: "resp_notice",
    model: "m",
    stopReason: scenario.stopReason,
    content: scenario.content,
    usage: { inputTokens: 3, outputTokens: 4 },
    // Omitted rather than empty when there is nothing to report, so the notice-free rendering is
    // the pre-change rendering byte for byte.
    ...(notices.length ? { featureNotices: [...notices] } : {}),
  }
}

function canonicalStream(events: Canonical_Event[]): Canonical_StreamResponse {
  return {
    type: "canonical_stream",
    status: 200,
    id: "resp_notice",
    model: "m",
    events: (async function* () {
      for (const event of events) yield event
    })(),
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering observation
// ---------------------------------------------------------------------------------------------

/**
 * What a client can see of one rendering, in a form the six paths share.
 *
 * `kinds`, `fields`, `eventNames` and `headers` are the "kinds of thing" vocabularies reading (b)
 * compares. `body` is the whole rendering, kept for the Property 8 differential.
 */
interface Rendering {
  /** Text the client actually saw, in arrival order. */
  text: string
  /** Distinct SSE frame names; empty on the non-streaming paths. */
  eventNames: string[]
  /** Distinct `type` and `object` values anywhere in the rendering — block, item and delta kinds. */
  kinds: string[]
  /** Distinct field names anywhere in the rendering. */
  fields: string[]
  /** Distinct response header names; empty where the path returns a body rather than a Response. */
  headers: string[]
  /** The whole rendering: a body object, or the SSE frame list. */
  body: unknown
}

function walk(value: unknown, visit: (key: string, member: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const member of value) walk(member, visit)
    return
  }
  if (!value || typeof value !== "object") return
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    visit(key, member)
    walk(member, visit)
  }
}

function vocabularies(body: unknown) {
  const kinds = new Set<string>()
  const fields = new Set<string>()
  walk(body, (key, member) => {
    fields.add(key)
    if ((key === "type" || key === "object") && typeof member === "string") kinds.add(member)
  })
  return { kinds: [...kinds].sort(), fields: [...fields].sort() }
}

function fromBody(body: unknown, text: string, headers: string[] = []): Rendering {
  return { text, eventNames: [], headers, body, ...vocabularies(body) }
}

interface SseFrame {
  name: string
  data: any
}

/**
 * Reads every SSE frame of a response, tolerating the `[DONE]` sentinel the chat-completions
 * shape ends with (it is not JSON, so `readSse()` in `test/helpers.ts` cannot be reused here).
 * The frame name is the `event:` line where there is one and the payload's own discriminator
 * otherwise, so the three streaming paths report a comparable event vocabulary.
 */
async function readFrames(response: Response) {
  const text = await response.text()
  const frames: SseFrame[] = []
  for (const raw of text.split("\n\n")) {
    if (!raw.trim()) continue
    const lines = raw.split(/\r?\n/)
    const name = lines.find((line) => line.startsWith("event:"))?.slice(6).trim()
    const payload = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
    if (!payload) continue
    if (payload === "[DONE]") {
      frames.push({ name: name ?? "[DONE]", data: undefined })
      continue
    }
    const data = JSON.parse(payload)
    frames.push({ name: name ?? String(data?.object ?? data?.type ?? "data"), data })
  }
  return frames
}

function fromFrames(frames: SseFrame[], text: string, headers: string[]): Rendering {
  const payloads = frames.map((frame) => frame.data)
  return {
    text,
    eventNames: [...new Set(frames.map((frame) => frame.name))].sort(),
    headers,
    body: frames,
    ...vocabularies(payloads),
  }
}

function headerNames(response: Response) {
  return [...response.headers.keys()].sort()
}

// ---------------------------------------------------------------------------------------------
// The six render paths
// ---------------------------------------------------------------------------------------------

interface RenderPath {
  name: string
  streaming: boolean
  marker: string
  renderWarning(notices: readonly Canonical_FeatureNotice[]): string
  prepend(text: string, warning: string): string
  render(scenario: Scenario, plan: NoticePlan): Promise<Rendering>
}

const CLAUDE_REQUEST: ClaudeMessagesRequest = { model: "m", messages: [{ role: "user", content: "hi" }] }
const RESPONSES_REQUEST = { model: "m", input: "hi" }
const CHAT_REQUEST = { model: "m", messages: [] }

function claudeBodyText(body: { content: any[] }) {
  return body.content.filter((block) => block.type === "text").map((block) => block.text as string).join("")
}

function claudeStreamedText(frames: SseFrame[]) {
  return frames.filter((frame) => frame.data?.delta?.type === "text_delta").map((frame) => frame.data.delta.text as string).join("")
}

function responsesBodyText(body: Record<string, any>) {
  return (body.output as any[])
    .filter((item) => item.type === "message")
    .flatMap((item) => (item.content as any[]).filter((part) => part.type === "output_text").map((part) => part.text as string))
    .join("")
}

function responsesStreamedText(frames: SseFrame[]) {
  return frames.filter((frame) => frame.name === "response.output_text.delta").map((frame) => frame.data.delta as string).join("")
}

function chatBodyText(body: Record<string, any>) {
  const content = body.choices?.[0]?.message?.content
  return typeof content === "string" ? content : ""
}

function chatStreamedText(frames: SseFrame[]) {
  return frames
    .filter((frame) => typeof frame.data?.choices?.[0]?.delta?.content === "string")
    .map((frame) => frame.data.choices[0].delta.content as string)
    .join("")
}

const CLAUDE_PATHS: RenderPath[] = [
  {
    name: "claude message body",
    streaming: false,
    marker: CLAUDE_NOTICE_MARKER,
    renderWarning: renderClaudeFeatureWarning,
    prepend: prependClaudeWarning,
    async render(scenario, plan) {
      const body = await canonicalResponseToClaudeMessage(canonicalResponse(scenario, planNotices(plan)), CLAUDE_REQUEST)
      return fromBody(body, claudeBodyText(body))
    },
  },
  {
    name: "claude SSE stream",
    streaming: true,
    marker: CLAUDE_NOTICE_MARKER,
    renderWarning: renderClaudeFeatureWarning,
    prepend: prependClaudeWarning,
    async render(scenario, plan) {
      // `heartbeatMs: 0` disables the ping timer, whose firing is wall-clock dependent and would
      // make two renderings of one input differ for a reason unrelated to notices.
      const response = claudeCanonicalStreamResponse(canonicalStream(buildEvents(scenario, plan)), CLAUDE_REQUEST, { heartbeatMs: 0 })
      const headers = headerNames(response)
      const frames = await readFrames(response)
      return fromFrames(frames, claudeStreamedText(frames), headers)
    },
  },
]

const OPENAI_PATHS: RenderPath[] = [
  {
    name: "openai responses body",
    streaming: false,
    marker: OPENAI_NOTICE_MARKER,
    renderWarning: renderOpenAIFeatureWarning,
    prepend: prependOpenAIWarning,
    async render(scenario, plan) {
      const body = canonicalResponseToResponsesBody(canonicalResponse(scenario, planNotices(plan)), RESPONSES_REQUEST) as Record<string, any>
      return fromBody(body, responsesBodyText(body))
    },
  },
  {
    name: "openai chat completions body",
    streaming: false,
    marker: OPENAI_NOTICE_MARKER,
    renderWarning: renderOpenAIFeatureWarning,
    prepend: prependOpenAIWarning,
    async render(scenario, plan) {
      const body = canonicalResponseToChatCompletion(canonicalResponse(scenario, planNotices(plan))) as Record<string, any>
      return fromBody(body, chatBodyText(body))
    },
  },
  {
    name: "openai responses SSE stream",
    streaming: true,
    marker: OPENAI_NOTICE_MARKER,
    renderWarning: renderOpenAIFeatureWarning,
    prepend: prependOpenAIWarning,
    async render(scenario, plan) {
      const response = openAICanonicalStreamResponse(canonicalStream(buildEvents(scenario, plan)), "/v1/responses", RESPONSES_REQUEST)
      const headers = headerNames(response)
      const frames = await readFrames(response)
      return fromFrames(frames, responsesStreamedText(frames), headers)
    },
  },
  {
    name: "openai chat completions SSE stream",
    streaming: true,
    marker: OPENAI_NOTICE_MARKER,
    renderWarning: renderOpenAIFeatureWarning,
    prepend: prependOpenAIWarning,
    async render(scenario, plan) {
      const response = openAICanonicalStreamResponse(canonicalStream(buildEvents(scenario, plan)), "/v1/chat/completions", CHAT_REQUEST)
      const headers = headerNames(response)
      const frames = await readFrames(response)
      return fromFrames(frames, chatStreamedText(frames), headers)
    },
  },
]

const ALL_PATHS = [...CLAUDE_PATHS, ...OPENAI_PATHS]

// ---------------------------------------------------------------------------------------------
// Expected rendering
// ---------------------------------------------------------------------------------------------

/**
 * The separator the renderer itself puts between the warning and the model text, read off the
 * renderer rather than restated here — Requirement 9.5 keeps the notice wording, punctuation
 * included, inside `notice.ts`.
 */
function separatorOf(path: RenderPath) {
  const joined = path.prepend("T", "W")
  return joined.slice("W".length, joined.length - "T".length)
}

/**
 * Whether the warning can lead the model text.
 *
 * Always, on the non-streaming paths: there is one delivery point by construction. On a stream it
 * takes every notice being decided before the model spoke — or the model never speaking, where
 * leading and trailing are the same placement.
 */
function warningLeads(path: RenderPath, scenario: Scenario, plan: NoticePlan) {
  if (!path.streaming) return true
  if (!scenario.plainText) return true
  return plan.every((group) => group.at === "before")
}

function flattenDetail(detail: string) {
  return detail.replace(/\s+/g, " ").trim()
}

/** First-seen dedupe by `(feature, flattened detail)`, matching what the renderers do. */
function expectedNoticeLines(notices: readonly Canonical_FeatureNotice[]) {
  const lines: Array<{ feature: string; detail: string }> = []
  const seen = new Set<string>()
  for (const notice of notices) {
    if (notice.policy !== "degrade") continue
    const detail = flattenDetail(notice.detail)
    const key = `${notice.feature}\u0000${detail}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push({ feature: notice.feature, detail })
  }
  return lines
}

function markerCount(text: string, marker: string) {
  return text.split(marker).length - 1
}

// ---------------------------------------------------------------------------------------------
// Volatile value normalization for the Property 8 differential
// ---------------------------------------------------------------------------------------------

/**
 * The two kinds of value that differ between two renderings of one input by construction: minted
 * item ids (`msg_`/`rs_`/`fc_` plus a fresh UUID) and second-resolution clocks. Both are
 * normalized; everything else — item order, item types, text, arguments, stop reason, every token
 * member, every header — is compared unmodified, because weakening the differential to a shape
 * check would let an emulate notice silently move a token or split a block.
 *
 * This is the normalization set `test/inbound/openai-notice.test.ts` established for the same
 * comparison, kept identical so the two files cannot drift into disagreeing about what is
 * volatile.
 */
const CLOCK_KEYS = new Set(["created", "created_at", "completed_at"])
const ID_KEYS = new Set(["id", "item_id", "call_id"])
const MINTED_ID = /^(msg|rs|fc|call|chatcmpl)_/

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== "object") return value
  const normalized: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (CLOCK_KEYS.has(key)) {
      normalized[key] = 0
      continue
    }
    if (ID_KEYS.has(key) && typeof member === "string" && MINTED_ID.test(member)) {
      normalized[key] = member.replace(/^([a-z]+)_.*/, "$1_x")
      continue
    }
    normalized[key] = stable(member)
  }
  return normalized
}

function serialize(rendering: Rendering) {
  return JSON.stringify(stable(rendering.body))
}

// ---------------------------------------------------------------------------------------------
// Vocabulary reference — reading (b)
// ---------------------------------------------------------------------------------------------

/**
 * The vocabulary a path produces for a plain text-carrying turn with no notice at all.
 *
 * This is the yardstick for "introduces no new kind of thing": a warning may make a path emit the
 * text machinery it already has (design D2's created text block), but never machinery the path
 * would not produce for a response that simply spoke.
 */
const REFERENCE_SCENARIO = oneDeltaScenario("reference text")
const referenceCache = new Map<string, Rendering>()

async function textReference(path: RenderPath) {
  const cached = referenceCache.get(path.name)
  if (cached) return cached
  const rendering = await path.render(REFERENCE_SCENARIO, [])
  referenceCache.set(path.name, rendering)
  return rendering
}

function union(left: readonly string[], right: readonly string[]) {
  return [...new Set([...left, ...right])].sort()
}

// ---------------------------------------------------------------------------------------------
// Property 7
// ---------------------------------------------------------------------------------------------

async function assertProperty7(path: RenderPath, scenario: Scenario, plan: NoticePlan) {
  const notices = planNotices(plan)
  const warning = path.renderWarning(notices)
  const warned = await path.render(scenario, plan)
  const bare = await path.render(scenario, [])
  const reference = await textReference(path)

  // Clause 1 — exactly one warning segment for this delivery point (Requirement 9.4).
  expect(markerCount(warned.text, path.marker)).toBe(1)

  // Clause 2 — placement. Leading the model's first text where the notices were decided before
  // it, trailing it as one segment where design D2's ordering rule forbids leading. Stated as the
  // exact expected bytes, so the model's own text also stays contiguous and unmodified.
  const separator = separatorOf(path)
  const expected = warningLeads(path, scenario, plan)
    ? path.prepend(scenario.plainText, warning)
    : `${scenario.plainText}${separator}${warning}`
  expect(warned.text).toBe(expected)
  // The notice-free rendering shows what the model text is on its own, so stripping the segment
  // returns exactly it — the warning added text and changed nothing else.
  expect(bare.text).toBe(scenario.plainText)

  // Clause 3 — every notice appears exactly once, in first-seen order, deduped by
  // `(feature, detail)`. See the header note on how this reads Requirement 9.4.
  expect(textNotices(warned.text).map((notice) => ({ feature: notice.feature, detail: notice.detail }))).toEqual(
    expectedNoticeLines(notices),
  )

  // Clause 4 — no new kind of thing (Requirement 9.6). Reading (b): compared against what the
  // path already produces for a text-carrying turn, so design D2's created text block is not a
  // violation, while a new SSE event name, `type` value, field, or header still is.
  const allowedKinds = union(bare.kinds, reference.kinds)
  const allowedFields = union(bare.fields, reference.fields)
  const allowedEvents = union(bare.eventNames, reference.eventNames)
  const allowedHeaders = union(bare.headers, reference.headers)
  expect(warned.kinds.filter((kind) => !allowedKinds.includes(kind))).toEqual([])
  expect(warned.fields.filter((field) => !allowedFields.includes(field))).toEqual([])
  expect(warned.eventNames.filter((name) => !allowedEvents.includes(name))).toEqual([])
  expect(warned.headers.filter((name) => !allowedHeaders.includes(name))).toEqual([])
  // Headers never move at all, on any shape: the notice travels in the body, so the strong form
  // holds even for the created-text-block case.
  expect(warned.headers).toEqual(bare.headers)

  // …and the strong form of clause 4 wherever it genuinely holds: when the model already spoke,
  // the warning rides existing content, so the vocabularies are *equal*, not merely contained.
  if (scenario.plainText) {
    expect(warned.kinds).toEqual(bare.kinds)
    expect(warned.fields).toEqual(bare.fields)
    expect(warned.eventNames).toEqual(bare.eventNames)
  }
}

async function assertProperty7Everywhere(scenario: Scenario, plan: NoticePlan) {
  for (const path of ALL_PATHS) await assertProperty7(path, scenario, plan)
}

// ---------------------------------------------------------------------------------------------
// Property 8
// ---------------------------------------------------------------------------------------------

async function assertProperty8(path: RenderPath, scenario: Scenario, plan: NoticePlan) {
  const warned = await path.render(scenario, plan)
  const removed = await path.render(scenario, [])

  // The renderer must produce nothing for an emulate-only list, so the whole rendering — text,
  // every field, every header, every frame — equals the rendering with those notices removed.
  expect(path.renderWarning(planNotices(plan))).toBe("")
  expect(warned.text).toBe(removed.text)
  expect(warned.text).toBe(scenario.plainText)
  expect(warned.eventNames).toEqual(removed.eventNames)
  expect(warned.kinds).toEqual(removed.kinds)
  expect(warned.fields).toEqual(removed.fields)
  expect(warned.headers).toEqual(removed.headers)
  expect(serialize(warned)).toBe(serialize(removed))
}

async function assertProperty8Everywhere(scenario: Scenario, plan: NoticePlan) {
  for (const path of ALL_PATHS) await assertProperty8(path, scenario, plan)
}

// ---------------------------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------------------------

const SEED_SCENARIO = multiDeltaScenario(["say one ", "say two"])

/** Two exact duplicates, a near-duplicate sharing the feature, and an emulate riding along. */
const SEED_PLAN: NoticePlan = [
  {
    at: "before",
    notices: [
      { feature: "sampling", policy: "degrade", detail: NOTICE_DETAILS[0]! },
      { feature: "sampling", policy: "degrade", detail: NOTICE_DETAILS[0]! },
      { feature: "sampling", policy: "degrade", detail: NOTICE_DETAILS[1]! },
      { feature: "structuredOutput", policy: "emulate", detail: NOTICE_DETAILS[2]! },
      { feature: "mcpToolset", policy: "degrade", detail: NOTICE_DETAILS[4]! },
    ],
  },
]

const SEED_EMULATE_PLAN: NoticePlan = [
  {
    at: "before",
    notices: [
      { feature: "structuredOutput", policy: "emulate", detail: NOTICE_DETAILS[2]! },
      { feature: "webSearch", policy: "emulate", detail: "served through MCP" },
    ],
  },
]

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

describe("Inbound notice rendering properties", () => {
  test("Feature: native-api-mode, Property 7: Degrade warnings are one combined prefix delivered through the existing channel", async () => {
    await fc.assert(fc.asyncProperty(scenario, singleSlotPlan(degradeBearingNotices), assertProperty7Everywhere), {
      numRuns: 100,
      examples: [[SEED_SCENARIO, SEED_PLAN]],
    })
  })

  test("Feature: native-api-mode, Property 7: Degrade warnings are one combined prefix delivered through the existing channel — one detail per feature makes every feature name appear exactly once", async () => {
    // The literal reading of the clause, in the input space where it and the dedupe rule agree:
    // distinct features, one detail each, so no notice can share a line and no name can repeat.
    const oneDetailPerFeature = fc
      .uniqueArray(fc.constantFrom(...PROVIDER_FEATURES), { minLength: 1, maxLength: 4 })
      .chain((features) =>
        fc
          .array(noticeDetail, { minLength: features.length, maxLength: features.length })
          .map((details) =>
            features.map<Canonical_FeatureNotice>((feature, index) => ({ feature, policy: "degrade", detail: details[index]! })),
          ),
      )

    await fc.assert(
      fc.asyncProperty(scenario, singleSlotPlan(oneDetailPerFeature), async (generated, plan) => {
        await assertProperty7Everywhere(generated, plan)
        for (const path of ALL_PATHS) {
          const warned = await path.render(generated, plan)
          for (const notice of planNotices(plan)) {
            expect(warned.text.split(`- ${notice.feature}:`)).toHaveLength(2)
          }
        }
      }),
      {
        numRuns: 100,
        examples: [
          [
            SEED_SCENARIO,
            [
              {
                at: "before" as DeliverySlot,
                notices: [
                  { feature: "sampling", policy: "degrade", detail: NOTICE_DETAILS[0]! },
                  { feature: "mcpToolset", policy: "degrade", detail: NOTICE_DETAILS[4]! },
                ],
              },
            ],
          ],
        ],
      },
    )
  })

  test("Feature: native-api-mode, Property 7: Degrade warnings are one combined prefix delivered through the existing channel — notices split across the text boundary render one segment each and never repeat", async () => {
    // Reading (a): two delivery points, so two segments — design D2's ordering rule forces it,
    // because a notice decided after text was emitted cannot lead that text. This is not a second
    // delivery mechanism and not a repeat: each notice renders in exactly one segment, and with
    // disjoint feature sets across the two groups every feature name still appears exactly once
    // in the whole rendering.
    const splitPlan = fc
      .uniqueArray(fc.constantFrom(...PROVIDER_FEATURES), { minLength: 2, maxLength: 4 })
      .chain((features) =>
        fc
          .tuple(
            fc.array(noticeDetail, { minLength: features.length, maxLength: features.length }),
            fc.integer({ min: 1, max: features.length - 1 }),
          )
          .map(([details, cut]) => {
            const notices = features.map<Canonical_FeatureNotice>((feature, index) => ({
              feature,
              policy: "degrade",
              detail: details[index]!,
            }))
            return [
              { at: "before" as DeliverySlot, notices: notices.slice(0, cut) },
              { at: "afterFirstText" as DeliverySlot, notices: notices.slice(cut) },
            ]
          }),
      )

    await fc.assert(
      fc.asyncProperty(textBearingScenario, splitPlan, async (generated, plan) => {
        const early = plan[0]!.notices
        const late = plan[1]!.notices

        for (const path of ALL_PATHS) {
          const warned = await path.render(generated, plan)
          const separator = separatorOf(path)

          if (path.streaming) {
            // Two segments, one on each side of the model text.
            expect(markerCount(warned.text, path.marker)).toBe(2)
            expect(warned.text).toBe(
              `${path.renderWarning(early)}${separator}${generated.plainText}${separator}${path.renderWarning(late)}`,
            )
          } else {
            // A body has one delivery point, so the split collapses back to one segment.
            expect(markerCount(warned.text, path.marker)).toBe(1)
            expect(warned.text).toBe(path.prepend(generated.plainText, path.renderWarning([...early, ...late])))
          }

          // Requirement 9.4 in the form that survives two segments: no notice is delivered twice.
          for (const notice of [...early, ...late]) {
            expect(warned.text.split(`- ${notice.feature}:`)).toHaveLength(2)
          }
        }
      }),
      {
        numRuns: 100,
        examples: [
          [
            SEED_SCENARIO,
            [
              { at: "before" as DeliverySlot, notices: [{ feature: "sampling", policy: "degrade", detail: NOTICE_DETAILS[0]! }] },
              { at: "afterFirstText" as DeliverySlot, notices: [{ feature: "mcpToolset", policy: "degrade", detail: NOTICE_DETAILS[4]! }] },
            ],
          ],
        ],
      },
    )
  })

  test("Feature: native-api-mode, Property 8: Emulate notices are invisible to the client", async () => {
    // Any emulate-only list, at either delivery point, on any shape, through all six paths.
    await fc.assert(
      fc.asyncProperty(scenario, singleSlotPlan(fc.array(emulateNotice, { minLength: 1, maxLength: 4 })), assertProperty8Everywhere),
      { numRuns: 100, examples: [[SEED_SCENARIO, SEED_EMULATE_PLAN]] },
    )
  })

  test("Feature: native-api-mode, Property 8: Emulate notices are invisible to the client — the structured-output emulate notice leaves the rendering identical", async () => {
    // Requirement 10.7 names structured output specifically: the emulation output must stay
    // identical to the pre-change output. On the inbound side the pre-change output is the
    // rendering with the notice removed, so the clause is that differential with the
    // `structuredOutput` notice always present.
    const withStructuredOutput = fc
      .tuple(noticeDetail, fc.array(emulateNotice, { maxLength: 3 }))
      .map<Canonical_FeatureNotice[]>(([detail, rest]) => [{ feature: "structuredOutput", policy: "emulate", detail }, ...rest])

    await fc.assert(fc.asyncProperty(scenario, singleSlotPlan(withStructuredOutput), assertProperty8Everywhere), {
      numRuns: 100,
      examples: [[SEED_SCENARIO, SEED_EMULATE_PLAN]],
    })
  })

  test("Feature: native-api-mode, Property 8: Emulate notices are invisible to the client — an emulate notice riding with a degrade notice adds no line of its own", async () => {
    // The mixed case: the degrade notices still render, and the rendering is byte-identical to the
    // one where only the emulate notices were removed — so an emulate notice cannot leak a line,
    // change the header count, or move a field.
    await fc.assert(
      fc.asyncProperty(
        scenario,
        fc.constantFrom<DeliverySlot>("before", "afterFirstText"),
        fc.array(degradeNotice, { minLength: 1, maxLength: 3 }),
        fc.array(emulateNotice, { minLength: 1, maxLength: 3 }),
        async (generated, at, degrades, emulates) => {
          // Interleaved so the emulate notices are not merely trailing the degrade ones.
          const mixed = degrades.flatMap((notice, index) => (emulates[index] ? [notice, emulates[index]!] : [notice]))
          const withEmulate: NoticePlan = [{ at, notices: [...mixed, ...emulates.slice(degrades.length)] }]
          const withoutEmulate: NoticePlan = [{ at, notices: degrades }]

          for (const path of ALL_PATHS) {
            const warned = await path.render(generated, withEmulate)
            const degradeOnly = await path.render(generated, withoutEmulate)
            expect(warned.text).toBe(degradeOnly.text)
            expect(serialize(warned)).toBe(serialize(degradeOnly))
          }
        },
      ),
      {
        numRuns: 100,
        examples: [
          [
            SEED_SCENARIO,
            "before" as DeliverySlot,
            [{ feature: "sampling", policy: "degrade", detail: NOTICE_DETAILS[0]! }],
            [{ feature: "structuredOutput", policy: "emulate", detail: NOTICE_DETAILS[2]! }],
          ],
        ],
      },
    )
  })
})
