// Feature: native-api-mode, Property 19: Disabling passthrough preserves the current canonical output.
//
// For any request body on any route, `normalizeCanonicalRequest` with the passthrough option false
// produces canonical output deep-equal to the pre-change output for that body.
//
// **Validates: Requirements 12.6, 15.5**
//
// This file carries both halves of Property 19. Clauses 1, 2, 4, 5, 6 are the **snapshot half**, owned
// by task 13.3 and written while `src/inbound/openai/normalize.ts` still computed
// `const passthrough = false` locally — a clause that varied the option then would have been asserting
// that an ignored argument is ignored. Clauses 7, 8, 9 are the **passthrough half**, added by task 18.3
// once that line became `options.passthrough ?? false`; they are the claims that the option is read,
// that reading it moves nothing but `passthrough` and (where the wire body has tools) `tools`, and that
// the defaulted option still reproduces the recorded pre-change output. See the section below the
// snapshot clauses for what each one does and does not prove.
//
// ## What "pre-change" means here, and what this file does and does not prove
//
// There is no second build of the module to compare against at test time, so "deep-equal to the
// pre-change output" is expressed in three forms, each with a different strength. Stating them apart
// is the point — the combination is weaker than a two-build comparison and should not be read as one.
//
// 1. **Recorded outputs** ({@link SNAPSHOTS}). For a fixed set of wire bodies, the exact canonical
//    object is committed in this file and compared with `toStrictEqual`, which — unlike `toEqual` —
//    also compares own keys whose value is `undefined`. The current code emits several of those
//    (`tools`, `toolChoice`, `include`, `textFormat`, `reasoningEffort` on the two known routes,
//    `instructions` on the fallback route), and they are part of the shape, so they are recorded.
//    - *Proves:* the recorded bodies keep producing exactly these objects, member for member.
//    - *Does not prove:* that the recorded values were themselves the pre-change values. Their status
//      as pre-change rests on evidence outside this file, stated in point 3.
//
// 2. **The contract grew, the output did not** ({@link PRE_CHANGE_CANONICAL_KEYS}). For any generated
//    body on any route, the canonical output's own-key set stays inside the eleven members
//    `Canonical_Request` had before task 13.1, and carries none of the four that task added. This is
//    the generative form, and it is the one that catches a member appearing on a body shape no
//    recorded fixture happens to cover.
//    - *Proves:* no new member reaches the output, for any body in the generated space.
//    - *Does not prove:* that the *values* of the surviving eleven are unchanged — a member that
//      silently changed value on a body shape outside {@link SNAPSHOTS} would pass this clause.
//      Clause 6's determinism check does not close that either; only the recorded outputs do, for the
//      bodies they cover.
//
// 3. **Why the recorded values are the pre-change values, as of this task.** Task 13.1's whole diff is
//    additive and *type-only*: it adds four optional members to the `Canonical_Request` interface in
//    `src/core/canonical.ts`, a file that declares types and nothing else, and `normalize.ts` itself
//    is byte-identical to its pre-task-13 revision. TypeScript member declarations erase at runtime,
//    so the module could not have changed what it emits. That argument, plus task 13.2's independent
//    check that the suite passes with zero test-file edits, is what makes the values recorded below
//    pre-change values rather than merely current ones.
//    - *Does not prove:* anything by itself at test time. It is an argument about a diff, recorded
//      here so a later reader knows what the snapshot is standing in for. Once this milestone is
//      committed, the fixtures are ordinary regression baselines.
//
// ## The one clause that was milestone-scoped on purpose, and has now been handed over
//
// As written by task 13.3 this file carried a third clause asserting that the seven wire fields the
// new members would eventually come from — `temperature`, `top_p`, `max_tokens`, `max_output_tokens`,
// `max_completion_tokens`, `stop`, `parallel_tool_calls` — leave the canonical output **entirely
// unchanged**. That was the sharpest available statement of "the contract grew, the output did not":
// the fields were present on the wire and still invisible downstream.
//
// Task **14.3** flipped it, as that clause's own comment predicted. `src/inbound/openai/sampling.ts`
// now exists and `normalize.ts` spreads it into the `/v1/chat/completions` and `/v1/responses`
// branches, so those seven fields legitimately produce `sampling` / `parallelToolCalls`. Per the
// handover recorded here, the clause was **removed rather than weakened**: its guarantee — that every
// present field lands in its canonical destination with the mapped value, and that the members are
// absent for a body carrying none of them — is Property 20's claim, in
// `test/inbound/sampling.property.test.ts` (task 14.4). A relaxed version of the clause living on in
// this file would assert less than either half and read as a test that was patched to pass.
//
// The remaining clauses were written to survive both task 14 and task 18, and did: the recorded
// fixtures deliberately carry **none** of the seven fields, so 14.3 could not move them, and clause 2's
// key-set check is scoped to bodies that carry none of them for the same reason. That the mapper omits
// its members entirely when no source field is present (Requirement 13.5) is what makes those two
// clauses hold as literally after 14.3 as before it — a mapper that emitted `sampling: {}` would have
// broken both, which is a useful thing for this file to still be able to detect.
//
// The original clause numbering (1, 2, 4, 5, 6) is kept rather than closed up, so that a reference to
// "clause 4" in this file, in the task list, or in a review still names the same claim it named before
// the removal. The gap at 3 is the record of the handover, not an oversight.
//
// ## Determinism, and the one thing that is normalized away before comparison
//
// `normalizeFunctionCallItem()` and `normalizeChatToolCall()` mint an identifier with
// `crypto.randomUUID()` when the wire item supplies none, so two calls on such a body cannot be
// deep-equal as-is. {@link stabilizeMintedIds} rewrites *only* strings matching
// `^(fc|call)_[0-9a-f]{32}$` — the exact shape those two call sites produce — and every generator here
// spells its wire identifiers `wire_*`, so a stabilized string is necessarily one the code minted.
// Clause 6 asserts both halves of that: the generated body contains no minted-looking identifier, and
// client-supplied identifiers survive verbatim. The recorded fixtures supply every identifier, so the
// snapshot clause compares raw output with no stabilization at all.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_Request } from "../../../src/core/canonical"
import type { JsonObject } from "../../../src/core/types"
import { normalizeCanonicalRequest } from "../../../src/inbound/openai/normalize"
import { OPENAI_PROXY_ROUTES } from "../../../src/inbound/openai/routes"

// ---------------------------------------------------------------------------------------------
// The two recorded key sets
// ---------------------------------------------------------------------------------------------

/**
 * Every member `Canonical_Request` had before task 13.1, in declaration order.
 *
 * A recorded baseline, not a derived one: `keyof Canonical_Request` is the *post*-change surface, so
 * deriving from it would make the clause "the output's keys are keys of the current interface" — which
 * a leaked `sampling` member would satisfy. The whole point is to compare against the older surface.
 *
 * The `satisfies` clause keeps the two honest in the other direction: every name below must still be a
 * real member, so a rename in core fails to compile here instead of silently widening the baseline.
 */
const PRE_CHANGE_CANONICAL_KEYS = [
  "model",
  "instructions",
  "input",
  "tools",
  "toolChoice",
  "include",
  "textFormat",
  "reasoningEffort",
  "stream",
  "passthrough",
  "metadata",
] as const satisfies readonly (keyof Canonical_Request)[]

const PRE_CHANGE_KEY_SET: ReadonlySet<string> = new Set(PRE_CHANGE_CANONICAL_KEYS)

/**
 * The four members task 13.1 added. Listed separately from the baseline so a failure message can say
 * *which* new member leaked, and so the "absent" clause does not depend on the baseline being complete.
 */
const NEW_CANONICAL_MEMBERS = ["sampling", "thinking", "cacheHint", "parallelToolCalls"] as const satisfies readonly (keyof Canonical_Request)[]

/**
 * The wire fields task 14.3 will map into those members (Requirement 13.4).
 *
 * Used two ways: the generators must be able to put them on a body, and clause 2 must be able to
 * assert that a body carries none of them.
 */
const NEW_MEMBER_SOURCE_FIELDS = ["temperature", "top_p", "max_tokens", "max_output_tokens", "max_completion_tokens", "stop", "parallel_tool_calls"] as const

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

/**
 * The paths `normalizeCanonicalRequest` is actually called with, read from the route table rather
 * than restated, so a fourth OpenAI-shaped route is covered without touching this file.
 *
 * `src/inbound/openai/index.ts` passes `route.path` — the bare path — even for the `/codex`-prefixed
 * descriptors, which carry the prefix in `basePath`. So `/v1/embeddings` and every unrecognized path
 * reach the function's fallback branch, and "any route" includes that branch: it is the one that
 * produces the six-member output shape with `instructions` possibly `undefined`.
 */
const KNOWN_ROUTE_PATHS = OPENAI_PROXY_ROUTES.map((route) => route.path)

/** A path no descriptor claims, to pin the fallback branch for its own sake. */
const UNKNOWN_ROUTE_PATH = "/v1/some-unrecognized-route"

const ROUTE_PATHS: readonly string[] = [...KNOWN_ROUTE_PATHS, UNKNOWN_ROUTE_PATH]

const routePathArb = fc.constantFrom(...ROUTE_PATHS)

// ---------------------------------------------------------------------------------------------
// Minted-identifier stabilization
// ---------------------------------------------------------------------------------------------

/** Exactly what the two mint sites produce: a prefix plus a de-hyphenated UUID. */
const MINTED_ID = /^(?:fc|call)_[0-9a-f]{32}$/
/** The same shape, unanchored, for asserting a *wire* body contains no such string. */
const MINTED_ID_ANYWHERE = /(?:fc|call)_[0-9a-f]{32}/

interface StabilizeState {
  count: number
  /** First-encounter label per distinct minted value, so identity relations survive. */
  labels: Map<string, string>
}

/**
 * A structural copy with every minted identifier replaced by a label.
 *
 * Labels are assigned per *distinct* value in traversal order, not one shared token: a function-call
 * item mints a separate `id` and `call_id`, and two items that reused one identifier would be a real
 * difference from two that did not. A shared `<minted>` token would hide it; `<minted:0>` /
 * `<minted:1>` keeps it visible while still tolerating the randomness.
 *
 * Own keys holding `undefined` are preserved — `JSON.parse(JSON.stringify(x))` would drop them, and
 * they are exactly the part of the shape `toStrictEqual` exists to compare. Returns the replacement
 * count so a caller can tell a literal comparison from a stabilized one.
 */
function stabilizeMintedIds(value: unknown, state: StabilizeState = { count: 0, labels: new Map() }): { value: unknown; count: number } {
  if (typeof value === "string") {
    if (MINTED_ID.test(value)) {
      state.count += 1
      const label = state.labels.get(value) ?? `<minted:${state.labels.size}>`
      state.labels.set(value, label)
      return { value: label, count: state.count }
    }
    return { value, count: state.count }
  }
  if (Array.isArray(value)) {
    return { value: value.map((item) => stabilizeMintedIds(item, state).value), count: state.count }
  }
  if (value && typeof value === "object") {
    const copy: Record<string, unknown> = {}
    // `Object.keys` rather than entries-filtering: a key present with an `undefined` value must stay
    // present, because that is a difference `toStrictEqual` reports.
    for (const key of Object.keys(value)) copy[key] = stabilizeMintedIds((value as Record<string, unknown>)[key], state).value
    return { value: copy, count: state.count }
  }
  return { value, count: state.count }
}

function stabilized(request: Canonical_Request): unknown {
  return stabilizeMintedIds(request).value
}

// ---------------------------------------------------------------------------------------------
// Wire body generators
// ---------------------------------------------------------------------------------------------

const textArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom("", "hello", "   ", "line one\nline two", "unicode → ✓ 漢字", "0", '{"looks":"like json"}') },
  { weight: 2, arbitrary: fc.string({ maxLength: 24 }) },
)

/**
 * Models a client can send, including the `gpt-5*` family whose `_level` suffix
 * `normalizeReasoningBody()` rewrites into `reasoning.effort` — the one path where the canonical
 * `model` differs from the wire `model`, and therefore the one most worth generating.
 */
const modelArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom("gpt-5.4", "gpt-5.4_high", "gpt-5_low", "gpt-5.4_ultra", "gpt-5.4_none", "other-model", "claude-sonnet-4-5", "") },
  { weight: 1, arbitrary: fc.string({ maxLength: 16 }) },
  // Off-contract but reachable: the code defends with `typeof model === "string"`, so the default
  // branch is part of the output shape being pinned.
  { weight: 1, arbitrary: fc.constantFrom(123, null, { nested: true }, ["array"]) },
)

/** Wire identifiers are always spelled `wire_*` so they can never be mistaken for a minted one. */
const WIRE_IDS = ["wire_call_a", "wire_call_b", "wire_fc_1"] as const

const wireIdArb = fc.constantFrom(...WIRE_IDS)

const chatContentPartArb = fc.oneof(
  fc.record({ type: fc.constant("text"), text: textArb }),
  fc.record({ type: fc.constant("refusal"), refusal: textArb }),
  fc.record({
    type: fc.constant("image_url"),
    image_url: fc.oneof(
      fc.constant("https://example.test/cat.png"),
      fc.record({ url: fc.constant("data:image/png;base64,AAAA"), detail: fc.constantFrom("low", "high", "auto") }, { requiredKeys: ["url"] }),
    ),
  }),
  // An unknown part: the code forwards it untouched, which is part of the shape.
  fc.record({ type: fc.constant("input_audio"), input_audio: fc.constant({ data: "AAAA", format: "wav" }) }),
  textArb,
)

const chatContentArb = fc.oneof(
  { weight: 3, arbitrary: textArb },
  { weight: 3, arbitrary: fc.array(chatContentPartArb, { maxLength: 3 }) },
  { weight: 1, arbitrary: chatContentPartArb },
  { weight: 1, arbitrary: fc.constantFrom(null, 42, undefined) },
)

const chatToolCallArb = fc.record(
  {
    id: wireIdArb,
    type: fc.constant("function"),
    function: fc.record({ name: fc.constantFrom("get_weather", "run_command"), arguments: fc.oneof(fc.constant('{"city":"hanoi"}'), fc.constant({ city: "hanoi" }), textArb) }),
  },
  // `id` optional on purpose: its absence is what makes the code mint one.
  { requiredKeys: ["type", "function"] },
)

const chatMessageArb = fc.oneof(
  { weight: 2, arbitrary: fc.record({ role: fc.constantFrom("system", "developer"), content: chatContentArb }) },
  { weight: 3, arbitrary: fc.record({ role: fc.constant("user"), content: chatContentArb }) },
  { weight: 4, arbitrary: fc.record({ role: fc.constant("assistant"), content: chatContentArb, tool_calls: fc.array(chatToolCallArb, { minLength: 1, maxLength: 2 }) }, { requiredKeys: ["role", "content"] }) },
  { weight: 2, arbitrary: fc.record({ role: fc.constant("tool"), tool_call_id: wireIdArb, content: chatContentArb }, { requiredKeys: ["role", "content"] }) },
  // Roles the code drops, and a shape that is not a message at all.
  { weight: 1, arbitrary: fc.record({ role: fc.constantFrom("function", "unknown"), content: textArb }) },
  { weight: 1, arbitrary: fc.constantFrom(null, "bare string", 7) },
)

/**
 * Weighted toward the two item types that carry identifiers, because those are the only bodies that
 * make the code mint one — the case the stabilization helper exists for and the case a deep-equality
 * clause is most likely to be silently vacuous about.
 */
const responsesInputItemArb = fc.oneof(
  { weight: 2, arbitrary: fc.record({ type: fc.constant("message"), role: fc.constantFrom("user", "assistant"), content: fc.array(fc.record({ type: fc.constantFrom("input_text", "output_text"), text: textArb }), { maxLength: 2 }) }) },
  { weight: 2, arbitrary: fc.record({ role: fc.constantFrom("user", "assistant"), content: fc.oneof(textArb, fc.array(chatContentPartArb, { maxLength: 2 })) }) },
  { weight: 2, arbitrary: fc.record({ role: fc.constantFrom("system", "developer"), content: fc.oneof(textArb, fc.array(fc.record({ type: fc.constant("input_text"), text: textArb }), { maxLength: 2 })) }) },
  { weight: 1, arbitrary: fc.record({ role: fc.constant("tool"), content: fc.oneof(textArb, fc.record({ type: fc.constant("function_call_output"), call_id: wireIdArb, output: textArb })) }) },
  { weight: 4, arbitrary: fc.record({ type: fc.constant("function_call"), id: wireIdArb, call_id: wireIdArb, name: fc.constantFrom("get_weather", "run_command"), arguments: fc.oneof(fc.constant('{"a":1}'), fc.constant({ a: 1 })) }, { requiredKeys: ["type", "name"] }) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant("function_call_output"), id: wireIdArb, call_id: wireIdArb, output: fc.oneof(textArb, fc.array(fc.record({ type: fc.constant("output_text"), text: textArb }), { maxLength: 2 })) }, { requiredKeys: ["type", "output"] }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("reasoning"), summary: fc.array(fc.record({ type: fc.constant("summary_text"), text: textArb }), { maxLength: 2 }), encrypted_content: fc.constant("enc") }, { requiredKeys: ["type"] }) },
  // Items the code drops: an unknown type, and non-objects.
  { weight: 1, arbitrary: fc.record({ type: fc.constant("item_reference"), id: wireIdArb }) },
  { weight: 1, arbitrary: fc.constantFrom(null, "bare", 3) },
)

const toolArb = fc.oneof(
  // Chat shape: the function lives one level down.
  fc.record({ type: fc.constant("function"), function: fc.record({ name: fc.constantFrom("get_weather", "run_command"), description: textArb, parameters: fc.constant({ type: "object", properties: { city: { type: "string" } } }), strict: fc.boolean() }, { requiredKeys: ["name"] }), strict: fc.boolean() }, { requiredKeys: ["type", "function"] }),
  // Responses shape: flat, and forwarded untouched by `normalizeTool`.
  fc.record({ type: fc.constant("function"), name: fc.constantFrom("get_weather", "run_command"), parameters: fc.constant({ type: "object", properties: {} }) }),
  fc.record({ type: fc.constantFrom("web_search", "web_search_preview") }),
  fc.record({ type: fc.constant("custom"), name: fc.constant("thing") }),
  fc.constantFrom(null, "not-a-tool"),
)

const toolChoiceArb = fc.oneof(
  fc.constantFrom("auto", "none", "required"),
  fc.record({ type: fc.constantFrom("auto", "none", "required") }),
  fc.record({ type: fc.constant("web_search_preview") }),
  fc.record({ type: fc.constant("tool"), name: fc.constantFrom("get_weather", "run_command") }),
  fc.record({ type: fc.constant("function"), function: fc.constant({ name: "get_weather" }) }),
  fc.constantFrom(null, 5),
)

const responseFormatArb = fc.oneof(
  fc.constant({ type: "json_object" }),
  fc.record({ type: fc.constant("json_schema"), json_schema: fc.constant({ name: "out", schema: { type: "object", properties: { a: { type: "string" } } }, strict: true }) }),
  fc.constant({ type: "text" }),
  fc.constantFrom(null, "json_object"),
)

const textOptionArb = fc.oneof(
  fc.record({ format: fc.oneof(fc.constant({ type: "json_object" }), fc.constant({ type: "json_schema", name: "out", schema: { type: "object" } })) }),
  fc.constant({}),
  fc.constantFrom("string", null, 1),
)

const reasoningArb = fc.oneof(
  fc.record({ effort: fc.constantFrom("none", "low", "medium", "high", "xhigh", "max", "ultra") }),
  fc.record({ effort: fc.constantFrom("low", "high"), summary: fc.constant("auto") }),
  fc.constant({}),
  fc.constantFrom(null, "high"),
)

const includeArb = fc.array(fc.oneof(fc.constantFrom("reasoning.encrypted_content", "message.output_text.logprobs"), fc.constantFrom(1, null)), { maxLength: 3 })

const streamArb = fc.constantFrom(true, false, "true", 0, 1, null)

/** The seven fields of Requirement 13.4, as an independently-omittable subset. */
const newMemberSourceFieldsArb = fc.record(
  {
    temperature: fc.oneof(fc.double({ noNaN: true, min: -2, max: 2 }), fc.constantFrom(0, -0, 1, 2, Number.NaN, Number.POSITIVE_INFINITY)),
    top_p: fc.oneof(fc.double({ noNaN: true, min: 0, max: 1 }), fc.constantFrom(0, 1)),
    max_tokens: fc.oneof(fc.integer({ min: 0, max: 200_000 }), fc.constantFrom(1, -1)),
    max_output_tokens: fc.integer({ min: 1, max: 200_000 }),
    max_completion_tokens: fc.integer({ min: 1, max: 200_000 }),
    stop: fc.oneof(textArb, fc.array(textArb, { minLength: 1, maxLength: 3 })),
    parallel_tool_calls: fc.boolean(),
  },
  { requiredKeys: [] },
)

// The non-empty-subset refinement of the generator above lived here for the removed clause 3. It is
// not restated as an unused binding: task 14.4's `test/inbound/sampling.property.test.ts` needs that
// space and builds it there, next to the claim that uses it.

/**
 * A chat-completions body, a responses body, or a body already carrying canonical-looking `input`.
 *
 * The three are generated independently of the route so that "any body on any route" is literal:
 * clients do send a chat body to `/v1/responses`, and the fallback branch receives whatever arrives.
 * None of these carries any of {@link NEW_MEMBER_SOURCE_FIELDS} — clause 2 asserts that. The removed
 * clause 3 was the one that added them deliberately; the surviving clauses read the body as generated.
 */
const chatBodyArb = fc.record(
  {
    model: modelArb,
    messages: fc.oneof(
      { weight: 6, arbitrary: fc.array(chatMessageArb, { minLength: 1, maxLength: 4 }) },
      { weight: 1, arbitrary: fc.constant([]) },
      { weight: 1, arbitrary: fc.constantFrom("not-array", null) },
    ),
    instructions: fc.oneof(textArb, fc.constantFrom(123, null)),
    tools: fc.oneof(fc.array(toolArb, { maxLength: 3 }), fc.constantFrom("not-array", null)),
    tool_choice: toolChoiceArb,
    response_format: responseFormatArb,
    text: textOptionArb,
    reasoning: reasoningArb,
    reasoning_effort: fc.constantFrom("low", "high", "ultra", 7),
    include: includeArb,
    stream: streamArb,
    store: fc.boolean(),
    user: textArb,
  },
  // `messages` is required here so the chat branch is usually exercised with real messages; the
  // body-without-messages shape is still covered, by the `canonical` and `empty` families below being
  // generated independently of the route.
  { requiredKeys: ["model", "messages"] },
)

const responsesBodyArb = fc.record(
  {
    model: modelArb,
    input: fc.oneof(
      { weight: 2, arbitrary: textArb },
      { weight: 6, arbitrary: fc.array(responsesInputItemArb, { minLength: 1, maxLength: 4 }) },
      { weight: 1, arbitrary: fc.constant([]) },
      { weight: 1, arbitrary: fc.constantFrom(null, 5, { not: "an array" }) },
    ),
    instructions: fc.oneof(textArb, fc.constantFrom(123, null)),
    tools: fc.oneof(fc.array(toolArb, { maxLength: 3 }), fc.constantFrom("not-array", null)),
    tool_choice: toolChoiceArb,
    text: textOptionArb,
    response_format: responseFormatArb,
    reasoning: reasoningArb,
    reasoning_effort: fc.constantFrom("low", "high", "ultra", 7),
    include: includeArb,
    stream: streamArb,
    store: fc.boolean(),
    previous_response_id: fc.constant("resp_wire_1"),
  },
  { requiredKeys: ["model", "input"] },
)

const canonicalShapedBodyArb = fc.record(
  {
    model: modelArb,
    input: fc.array(
      fc.oneof(
        fc.record({ role: fc.constantFrom("user", "assistant", "tool"), content: fc.array(fc.record({ type: fc.constantFrom("input_text", "output_text"), text: textArb }), { maxLength: 2 }) }),
        fc.record({ role: fc.constant("system"), content: fc.constant([]) }),
        fc.record({ role: fc.constant("user"), content: fc.constant("not-an-array") }),
      ),
      { maxLength: 3 },
    ),
    instructions: fc.oneof(textArb, fc.constantFrom(123, null)),
    stream: streamArb,
  },
  { requiredKeys: ["model"] },
)

/** Shape label kept alongside the body so the coverage clause can count each family. */
interface WireBody {
  shape: "chat" | "responses" | "canonical" | "empty"
  body: JsonObject
}

const wireBodyArb: fc.Arbitrary<WireBody> = fc.oneof(
  { weight: 4, arbitrary: chatBodyArb.map((body) => ({ shape: "chat" as const, body: body as JsonObject })) },
  { weight: 4, arbitrary: responsesBodyArb.map((body) => ({ shape: "responses" as const, body: body as JsonObject })) },
  { weight: 2, arbitrary: canonicalShapedBodyArb.map((body) => ({ shape: "canonical" as const, body: body as JsonObject })) },
  // The degenerate body. Every member of the output is then a default, which is the shape most
  // likely to be broken by a change and the least likely to be generated by accident.
  { weight: 1, arbitrary: fc.constant({ shape: "empty" as const, body: {} as JsonObject }) },
)

// ---------------------------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------------------------

/**
 * The output is a real canonical request, not an empty object that would satisfy every key-set clause
 * vacuously. Every clause below runs this, so "no new member is present" can never pass because
 * nothing at all was produced.
 */
function assertWellFormed(result: Canonical_Request, path: string): void {
  expect(typeof result.model).toBe("string")
  expect(Array.isArray(result.input)).toBe(true)
  expect(typeof result.stream).toBe("boolean")
  // The option under test. Since task 18.1 the module reads `options.passthrough ?? false`, so this is
  // a real observation rather than a restatement of a constant; clause 7 is what pins that.
  expect(result.passthrough).toBe(false)
  expect(result.metadata).toStrictEqual({ source: "openai", path })
  for (const key of ["stream", "passthrough", "metadata", "model", "input"]) {
    expect(Object.hasOwn(result, key)).toBe(true)
  }
}

/** The key-set half of the property, reported so a failure names the offending member. */
function assertNoNewMembers(result: Canonical_Request, context: string): void {
  for (const member of NEW_CANONICAL_MEMBERS) {
    if (Object.hasOwn(result, member)) {
      throw new Error(`canonical output carries the new member \`${member}\` (${context}); task 13.1 is a type-only addition and nothing may populate it before task 14.3`)
    }
  }
  for (const key of Object.keys(result)) {
    if (!PRE_CHANGE_KEY_SET.has(key)) {
      throw new Error(`canonical output carries \`${key}\`, which is not one of the ${PRE_CHANGE_CANONICAL_KEYS.length} members the contract had before task 13.1 (${context})`)
    }
  }
}

function normalizeFalse(path: string, body: JsonObject): Canonical_Request {
  return normalizeCanonicalRequest(path, body, { passthrough: false })
}

/**
 * The only two members the passthrough option is allowed to reach.
 *
 * Read off the module rather than guessed: `normalize.ts` uses its local `passthrough` binding in
 * exactly three places per generation branch — the `passthrough` member itself, and the second
 * argument of `normalizeTools()`, which forwards the wire array verbatim when the flag is set. The
 * fallback branch uses it once, for the member alone, and has no `tools` member to move.
 *
 * A third use appearing in `normalize.ts` makes clause 8 fail rather than silently widen, which is the
 * point of listing them here instead of excluding "whatever differs".
 */
const OPTION_SENSITIVE_MEMBERS = ["passthrough", "tools"] as const satisfies readonly (keyof Canonical_Request)[]

const OPTION_SENSITIVE_KEY_SET: ReadonlySet<string> = new Set(OPTION_SENSITIVE_MEMBERS)

/**
 * The canonical request projected onto every member *except* the given ones, stabilized.
 *
 * Own keys holding `undefined` are kept, for the same reason {@link stabilizeMintedIds} keeps them: a
 * member turning from `undefined` into absent is a difference `toStrictEqual` reports, and one the
 * option must not cause.
 */
function stabilizedExcept(request: Canonical_Request, excluded: ReadonlySet<string>): unknown {
  const rest: Record<string, unknown> = {}
  for (const key of Object.keys(request)) {
    if (!excluded.has(key)) rest[key] = (request as unknown as Record<string, unknown>)[key]
  }
  return stabilizeMintedIds(rest).value
}

// ---------------------------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------------------------

describe("Canonical output invariance with passthrough disabled", () => {
  /**
   * Anti-vacuity, over the generator rather than over the code. Every clause below is a claim about
   * "any body on any route", and a generator that produced only `{}` on one route would satisfy all of
   * them while measuring nothing. So the space is sampled once with a fixed seed and its coverage is
   * asserted: each body family, each route, both stream states, and — most importantly — bodies whose
   * canonical output is *rich* (non-empty input, tools, a text format, a reasoning effort, a minted
   * identifier), because those are the outputs a leaked member would hide in.
   *
   * **Validates: Requirements 12.6, 15.5**
   */
  test("Feature: native-api-mode, Property 19: the generated space covers every route, body family, and canonical member", () => {
    const samples = fc.sample(fc.tuple(routePathArb, wireBodyArb, newMemberSourceFieldsArb), { numRuns: 1200, seed: 19 })

    const shapes = new Set<string>()
    const routes = new Set<string>()
    const sourceFieldsSeen = new Set<string>()
    let streamTrue = 0
    let streamFalse = 0
    let nonEmptyInput = 0
    let withTools = 0
    let withToolChoice = 0
    let withTextFormat = 0
    let withReasoningEffort = 0
    let withInstructionsBeyondDefault = 0
    let withFunctionCall = 0
    let mintedIds = 0
    let literalComparisons = 0

    for (const [path, wire, sourceFields] of samples) {
      shapes.add(wire.shape)
      routes.add(path)
      for (const field of Object.keys(sourceFields)) sourceFieldsSeen.add(field)

      const result = normalizeFalse(path, { ...wire.body, ...sourceFields })
      assertWellFormed(result, path)

      if (result.stream) streamTrue += 1
      else streamFalse += 1
      if (result.input.length > 0) nonEmptyInput += 1
      if (result.tools !== undefined) withTools += 1
      if (result.toolChoice !== undefined) withToolChoice += 1
      if (result.textFormat !== undefined) withTextFormat += 1
      if (result.reasoningEffort !== undefined) withReasoningEffort += 1
      if (result.instructions !== undefined && result.instructions !== "You are a helpful assistant.") withInstructionsBeyondDefault += 1
      if (JSON.stringify(result.input).includes('"function_call"')) withFunctionCall += 1

      const { count } = stabilizeMintedIds(result)
      if (count > 0) mintedIds += 1
      else literalComparisons += 1
    }

    // Every family and every route actually occurred.
    expect([...shapes].sort()).toStrictEqual(["canonical", "chat", "empty", "responses"])
    expect([...routes].sort()).toStrictEqual([...ROUTE_PATHS].sort())
    expect([...sourceFieldsSeen].sort()).toStrictEqual([...NEW_MEMBER_SOURCE_FIELDS].sort())

    // …and the outputs are not uniformly degenerate. The seed is fixed, so these counts are exact
    // rather than probabilistic; the floors sit well below the observed values so that a rebalanced
    // generator still passes while a *collapsed* one — one family, one route, empty outputs — cannot.
    // Recorded observation at seed 19 over 1200 samples: streamTrue 438, streamFalse 762,
    // nonEmptyInput 266, tools 167, toolChoice 291, textFormat 167, reasoningEffort 304,
    // instructions-beyond-default 449, function-call items 65, minted ids 17.
    expect(streamTrue).toBeGreaterThan(200)
    expect(streamFalse).toBeGreaterThan(400)
    expect(nonEmptyInput).toBeGreaterThan(150)
    expect(withTools).toBeGreaterThan(100)
    expect(withToolChoice).toBeGreaterThan(150)
    expect(withTextFormat).toBeGreaterThan(100)
    expect(withReasoningEffort).toBeGreaterThan(150)
    expect(withInstructionsBeyondDefault).toBeGreaterThan(250)
    expect(withFunctionCall).toBeGreaterThan(40)

    // Both comparison regimes are exercised: a few outputs need stabilization, and most do not — so
    // the deep-equality clauses are not resting entirely on the rewriting helper.
    expect(mintedIds).toBeGreaterThan(10)
    expect(literalComparisons).toBeGreaterThan(800)
  })

  /**
   * The generative half of "the contract grew, the output did not": for any body on any route, the
   * output's own-key set stays inside the pre-change eleven and carries none of the four new members.
   *
   * The counters repeat the anti-vacuity check *inside* the property, so a future change to the
   * generators cannot quietly make this clause pass over trivial inputs alone.
   *
   * **Validates: Requirements 12.6, 15.5**
   */
  test("Feature: native-api-mode, Property 19: canonical output carries none of the four members task 13.1 added", () => {
    let rich = 0
    let total = 0

    fc.assert(
      fc.property(routePathArb, wireBodyArb, (path, wire) => {
        // The body families deliberately carry none of the fields task 14.3's mapper reads, which is
        // why this clause still holds after that subtask landed: the mapper omits its members entirely
        // when no source field is present, so a body carrying none of them produces none of them.
        // Bodies that *do* carry them are Property 20's subject (task 14.4).
        for (const field of NEW_MEMBER_SOURCE_FIELDS) {
          expect(Object.hasOwn(wire.body, field)).toBe(false)
        }

        const result = normalizeFalse(path, wire.body)

        assertWellFormed(result, path)
        assertNoNewMembers(result, `${wire.shape} body on ${path}`)

        total += 1
        if (result.input.length > 0 || result.tools !== undefined || result.textFormat !== undefined) rich += 1
      }),
      { numRuns: 400 },
    )

    expect(total).toBe(400)
    expect(rich).toBeGreaterThan(100)
  })

  // The clause that stood here — "the wire fields the new members will come from leave canonical output
  // unchanged" — was removed by task 14.3, the subtask its own comment named as the one that would flip
  // it. `src/inbound/openai/sampling.ts` now maps those seven fields into `sampling` /
  // `parallelToolCalls` on the two generation routes, so the claim is false by design rather than by
  // regression.
  //
  // Its guarantee moved rather than lapsed: Property 20 in `test/inbound/sampling.property.test.ts`
  // (task 14.4) owns "every present field appears in its canonical destination with the mapped value,
  // and the members are absent for a body carrying none of them". Nothing weakened stands in its place
  // here, per the handover recorded in this file's header.

  /**
   * The recorded half: exact objects for fixed bodies, compared with `toStrictEqual` so own keys
   * holding `undefined` count. No stabilization — every fixture supplies its identifiers, so the
   * comparison is literal.
   *
   * The fixtures carry none of {@link NEW_MEMBER_SOURCE_FIELDS}, which is what lets them survive task
   * 14.3 unchanged and go on serving as ordinary regression baselines.
   *
   * **Validates: Requirements 12.6, 15.5**
   */
  test("Feature: native-api-mode, Property 19: every recorded pre-change canonical output is reproduced exactly", () => {
    expect(SNAPSHOTS.length).toBeGreaterThan(6)

    const coveredRoutes = new Set(SNAPSHOTS.map((snapshot) => snapshot.path))
    for (const path of ROUTE_PATHS) expect(coveredRoutes.has(path)).toBe(true)

    for (const snapshot of SNAPSHOTS) {
      // No fixture may carry a field task 14.3 reads, or the baseline would move under that task.
      for (const field of NEW_MEMBER_SOURCE_FIELDS) expect(Object.hasOwn(snapshot.body, field)).toBe(false)

      const result = normalizeFalse(snapshot.path, snapshot.body)

      // No identifier was minted, so the comparison below is literal rather than stabilized.
      expect(stabilizeMintedIds(result).count).toBe(0)
      expect(result).toStrictEqual(snapshot.expected as unknown as Canonical_Request)
      // The recorded key list is the pre-change one, in the order the code emits it — a member added
      // or dropped changes this even where `toStrictEqual` would tolerate it.
      expect(Object.keys(result)).toStrictEqual(Object.keys(snapshot.expected))
      assertNoNewMembers(result, `snapshot ${snapshot.name}`)
    }

    // The fixtures are not all degenerate: at least one records a non-empty input, a tool list, a text
    // format, a reasoning effort, and a tool choice.
    const outputs = SNAPSHOTS.map((snapshot) => normalizeFalse(snapshot.path, snapshot.body))
    expect(outputs.some((output) => output.input.length > 1)).toBe(true)
    expect(outputs.some((output) => (output.tools?.length ?? 0) > 1)).toBe(true)
    expect(outputs.some((output) => output.textFormat !== undefined)).toBe(true)
    expect(outputs.some((output) => output.reasoningEffort !== undefined)).toBe(true)
    expect(outputs.some((output) => output.toolChoice !== undefined)).toBe(true)
    expect(outputs.some((output) => output.stream)).toBe(true)
  })

  /**
   * An explicit `false` and an omitted option are the same request. True today because the option is
   * ignored, and still true after task 18.1 reads `options.passthrough ?? false` — which is why this
   * clause is safe to write in the snapshot half. It does *not* claim anything about `true`; that is
   * task 18.3's clause.
   *
   * **Validates: Requirement 15.5**
   */
  test("Feature: native-api-mode, Property 19: an explicit false option and an omitted option agree", () => {
    fc.assert(
      fc.property(routePathArb, wireBodyArb, newMemberSourceFieldsArb, (path, wire, sourceFields) => {
        const body = { ...wire.body, ...sourceFields }

        const explicit = normalizeCanonicalRequest(path, body, { passthrough: false })
        const omittedOptions = normalizeCanonicalRequest(path, body, {})
        const noArgument = normalizeCanonicalRequest(path, body)

        assertWellFormed(explicit, path)
        expect(stabilized(omittedOptions)).toStrictEqual(stabilized(explicit))
        expect(stabilized(noArgument)).toStrictEqual(stabilized(explicit))
        for (const result of [explicit, omittedOptions, noArgument]) expect(result.passthrough).toBe(false)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * Two facts the deep-equality clauses depend on, asserted rather than assumed.
   *
   * *Determinism:* normalizing the same body twice yields the same output up to minted identifiers.
   * Without this, any deep-equality clause here — the recorded fixtures, clause 5's three-way
   * agreement, and the removed clause 3 while it existed — could pass or fail on noise.
   *
   * *Non-mutation:* the wire body is unchanged afterwards. `normalizeReasoningBody()` rebuilds the
   * body by spreading, and the canonical output shares references into it (`textFormat`, unknown
   * content parts, forwarded tools), so "preserves the current output" also means the caller's body is
   * still the body — and a later mutation of a shared sub-object would be observable in both.
   *
   * The stabilization guard rides along here: a generated body never contains a minted-looking
   * identifier, and client-supplied `wire_*` identifiers appear verbatim in the output.
   *
   * **Validates: Requirements 12.6, 15.5**
   */
  test("Feature: native-api-mode, Property 19: normalization is deterministic up to minted ids and leaves the body untouched", () => {
    fc.assert(
      fc.property(routePathArb, wireBodyArb, newMemberSourceFieldsArb, (path, wire, sourceFields) => {
        const body = { ...wire.body, ...sourceFields }
        const serializedBefore = JSON.stringify(body)

        // Nothing the generators produce can be mistaken for an identifier the code minted, so
        // stabilization can only ever rewrite minted values.
        expect(serializedBefore).not.toMatch(MINTED_ID_ANYWHERE)

        const first = normalizeFalse(path, body)
        const second = normalizeFalse(path, body)

        expect(stabilized(second)).toStrictEqual(stabilized(first))
        expect(JSON.stringify(body)).toBe(serializedBefore)

        // Client-supplied identifiers survive stabilization verbatim, so the helper cannot be hiding a
        // real difference: whatever it rewrote, it did not rewrite anything the client sent.
        const rawOutput = JSON.stringify(first)
        const stabilizedOutput = JSON.stringify(stabilized(first))
        for (const wireId of WIRE_IDS) {
          if (rawOutput.includes(wireId)) expect(stabilizedOutput).toContain(wireId)
        }
      }),
      { numRuns: 300 },
    )
  })

  // -------------------------------------------------------------------------------------------
  // The passthrough half (task 18.3)
  // -------------------------------------------------------------------------------------------

  /**
   * The option is read rather than ignored.
   *
   * This is the clause the file could not carry before task 18.1: `normalize.ts` computed
   * `const passthrough = false` locally, so `true` and `false` produced identical output and every
   * clause above — including clause 5's three-way agreement — held for the uninteresting reason that
   * the argument went nowhere. Now that the line reads `options.passthrough ?? false`, asserting that
   * the two options are distinguishable is what makes the rest of this half meaningful.
   *
   * **Validates: Requirements 15.5, 12.6**
   */
  test("Feature: native-api-mode, Property 19: the passthrough option reaches the canonical output", () => {
    fc.assert(
      fc.property(routePathArb, wireBodyArb, newMemberSourceFieldsArb, (path, wire, sourceFields) => {
        const body = { ...wire.body, ...sourceFields }

        expect(normalizeCanonicalRequest(path, body, { passthrough: false }).passthrough).toBe(false)
        expect(normalizeCanonicalRequest(path, body, { passthrough: true }).passthrough).toBe(true)
        // The default is `false`, on every route and body shape — not just where clause 5 samples it.
        expect(normalizeCanonicalRequest(path, body, {}).passthrough).toBe(false)
        expect(normalizeCanonicalRequest(path, body).passthrough).toBe(false)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * Difference confinement: the option changes the canonical request in exactly two places, and one of
   * them only on bodies that reach it.
   *
   * This is the invariance that makes the option safe to bind at the composition root, and it is
   * asserted in the honest form rather than the flattering one. "The option changes nothing but
   * `passthrough`" is **false** as a universal claim: `normalizeTools()` takes the same flag and
   * forwards the wire array verbatim when it is set, so a body carrying an array `tools` legitimately
   * gets a different `tools` member. Stating the claim as "nothing but `passthrough`" would have meant
   * either scoping the property to bodies without tools — hiding the one member that does move — or
   * writing an assertion that fails. So the claim is: **`passthrough` and `tools` are the only members
   * that can differ; `tools` differs only when the body carries an array `tools`, and then the
   * passthrough form is that array verbatim.**
   *
   * Everything else is pinned positively: the key set and its order are identical, and the projection
   * of the output onto every other member is deep-equal up to minted identifiers. The `tools` carve-out
   * is bounded from both sides — the routes with no `tools` member at all (the fallback branch) and the
   * bodies whose `tools` is absent or not an array must differ in `passthrough` **alone**, which is the
   * strict form of the claim on the inputs where it is true.
   *
   * **Validates: Requirements 15.5, 12.6**
   */
  test("Feature: native-api-mode, Property 19: the option moves only `passthrough`, and `tools` only where the wire body carries tools", () => {
    let withArrayTools = 0
    let toolsActuallyDiffered = 0
    let strictlyPassthroughOnly = 0
    let total = 0

    fc.assert(
      fc.property(routePathArb, wireBodyArb, newMemberSourceFieldsArb, (path, wire, sourceFields) => {
        // Annotated rather than inferred: the spread of the two records widens to the sampling-field
        // shape alone, and this clause reads `body.tools` off it.
        const body: JsonObject = { ...wire.body, ...sourceFields }

        const disabled = normalizeCanonicalRequest(path, body, { passthrough: false })
        const enabled = normalizeCanonicalRequest(path, body, { passthrough: true })

        // The disabled form is still the canonical request every clause above describes.
        assertWellFormed(disabled, path)
        expect(enabled.passthrough).toBe(true)

        // Same members, in the same order: the option cannot add, drop, or reorder one.
        expect(Object.keys(enabled)).toStrictEqual(Object.keys(disabled))

        // Every member other than the two the flag is allowed to touch is byte-for-byte the same.
        expect(stabilizedExcept(enabled, OPTION_SENSITIVE_KEY_SET)).toStrictEqual(stabilizedExcept(disabled, OPTION_SENSITIVE_KEY_SET))

        const bodyToolsAreArray = Array.isArray(body.tools)
        if (bodyToolsAreArray) {
          withArrayTools += 1
          // The passthrough form of `tools` is the wire array itself, unmapped. Only the two known
          // routes have a `tools` member at all; the fallback branch never reaches `normalizeTools`.
          if (Object.hasOwn(enabled, "tools")) {
            expect(enabled.tools).toStrictEqual(body.tools as unknown as JsonObject[])
            if (JSON.stringify(enabled.tools) !== JSON.stringify(disabled.tools)) toolsActuallyDiffered += 1
          } else {
            expect(Object.hasOwn(disabled, "tools")).toBe(false)
          }
        } else {
          // No array `tools`, so `normalizeTools` returns `undefined` either way and the strict claim
          // holds: substitute `passthrough` and the two requests are the same request.
          expect(enabled.tools).toBeUndefined()
          expect(disabled.tools).toBeUndefined()
          expect(stabilized({ ...enabled, passthrough: false })).toStrictEqual(stabilized(disabled))
          strictlyPassthroughOnly += 1
        }

        total += 1
      }),
      { numRuns: 400 },
    )

    // Neither side of the carve-out is vacuous: bodies with array tools occur, the two forms of
    // `tools` really do diverge on some of them, and the strict "passthrough alone" case dominates.
    expect(total).toBe(400)
    expect(withArrayTools).toBeGreaterThan(40)
    expect(toolsActuallyDiffered).toBeGreaterThan(10)
    expect(strictlyPassthroughOnly).toBeGreaterThan(150)
  })

  /**
   * The recorded pre-change outputs, re-checked against a real option.
   *
   * Clause 4 compares `normalizeFalse(...)` with the fixtures, and before task 18.1 that was the only
   * reachable behavior. Now the default is a genuine `?? false`, so the fixtures also pin the
   * *defaulting*: an omitted option and an absent argument must reproduce the recorded pre-change
   * object exactly, which is what would break if the default were ever flipped to `true` — the
   * plausible way for a later wiring change to move canonical output without touching this file's
   * generators.
   *
   * The enabled form is checked on the same fixtures through the shared confinement helper, so the
   * recorded bodies also witness the carve-out on known values rather than only on generated ones.
   *
   * **Validates: Requirements 15.5, 12.6**
   */
  test("Feature: native-api-mode, Property 19: the defaulted option reproduces every recorded pre-change output", () => {
    let fixturesWithTools = 0

    for (const snapshot of SNAPSHOTS) {
      const omittedOptions = normalizeCanonicalRequest(snapshot.path, snapshot.body, {})
      const noArgument = normalizeCanonicalRequest(snapshot.path, snapshot.body)

      for (const result of [omittedOptions, noArgument]) {
        expect(result.passthrough).toBe(false)
        expect(result).toStrictEqual(snapshot.expected as unknown as Canonical_Request)
        expect(Object.keys(result)).toStrictEqual(Object.keys(snapshot.expected))
        assertNoNewMembers(result, `snapshot ${snapshot.name} with the option defaulted`)
      }

      const enabled = normalizeCanonicalRequest(snapshot.path, snapshot.body, { passthrough: true })
      expect(enabled.passthrough).toBe(true)
      expect(Object.keys(enabled)).toStrictEqual(Object.keys(snapshot.expected))
      expect(stabilizedExcept(enabled, OPTION_SENSITIVE_KEY_SET)).toStrictEqual(stabilizedExcept(omittedOptions, OPTION_SENSITIVE_KEY_SET))

      if (Array.isArray(snapshot.body.tools)) {
        fixturesWithTools += 1
        expect(enabled.tools).toStrictEqual(snapshot.body.tools as unknown as JsonObject[])
      } else {
        expect(enabled.tools).toBeUndefined()
      }
    }

    // At least one fixture carries a wire `tools` array whose mapped form differs from the raw one, so
    // the loop above is not asserting the carve-out over tool-less bodies alone.
    expect(fixturesWithTools).toBeGreaterThan(1)
    const mapped = SNAPSHOTS.filter((snapshot) => Array.isArray(snapshot.body.tools)).map((snapshot) => ({
      raw: JSON.stringify(snapshot.body.tools),
      normalized: JSON.stringify(normalizeFalse(snapshot.path, snapshot.body).tools),
    }))
    expect(mapped.some((pair) => pair.raw !== pair.normalized)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// Recorded outputs
// ---------------------------------------------------------------------------------------------

interface CanonicalSnapshot {
  name: string
  path: string
  body: JsonObject
  /**
   * The exact canonical object, own `undefined` values included.
   *
   * Typed loosely on purpose: this is recorded data, and typing it as `Canonical_Request` would let a
   * *removed* member still typecheck while quietly dropping the recorded value.
   */
  expected: Record<string, unknown>
}

/**
 * Bodies whose canonical output is recorded verbatim.
 *
 * Chosen for branch coverage rather than realism: both known routes, the `/v1/embeddings` and unknown
 * paths that reach the fallback branch, the empty body on each known route, the `gpt-5*` suffix
 * rewrite, chat and responses tool shapes, and the `tool` role on both. Every identifier is supplied
 * so nothing is minted, and no fixture carries a field of {@link NEW_MEMBER_SOURCE_FIELDS}.
 */
const SNAPSHOTS: readonly CanonicalSnapshot[] = [
  {
    name: "responses: string input with a gpt-5 effort suffix",
    path: "/v1/responses",
    body: {
      model: "gpt-5.4_high",
      input: "hello",
    },
    expected: {
      model: "gpt-5.4",
      instructions: "You are a helpful assistant.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "hello",
            },
          ],
        },
      ],
      tools: undefined,
      toolChoice: undefined,
      include: undefined,
      textFormat: undefined,
      reasoningEffort: "high",
      stream: false,
      passthrough: false,
      metadata: {
        source: "openai",
        path: "/v1/responses",
      },
    },
  },
  {
    name: "responses: item history, responses-shaped tools, text.format, include",
    path: "/v1/responses",
    body: {
      model: "gpt-5.4",
      input: [
        {
          role: "system",
          content: "be terse",
        },
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "and precise",
            },
          ],
        },
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "weather in hanoi?",
            },
          ],
        },
        {
          type: "function_call",
          id: "wire_fc_1",
          call_id: "wire_call_a",
          name: "get_weather",
          arguments: "{\"city\":\"hanoi\"}",
        },
        {
          type: "function_call_output",
          id: "wire_fc_1",
          call_id: "wire_call_a",
          output: [
            {
              type: "output_text",
              text: "31C",
            },
          ],
        },
        {
          type: "reasoning",
          summary: [
            {
              type: "summary_text",
              text: "checked",
            },
          ],
          encrypted_content: "enc",
        },
        {
          type: "item_reference",
          id: "wire_call_b",
        },
      ],
      tools: [
        {
          type: "function",
          name: "get_weather",
          parameters: {
            type: "object",
            properties: {
              city: {
                type: "string",
              },
            },
          },
        },
        {
          type: "web_search_preview",
        },
        {
          type: "custom",
          name: "thing",
        },
      ],
      tool_choice: {
        type: "tool",
        name: "get_weather",
      },
      text: {
        format: {
          type: "json_schema",
          name: "out",
          schema: {
            type: "object",
          },
        },
      },
      include: [
        "reasoning.encrypted_content",
        5,
      ],
      stream: true,
      store: true,
      reasoning: {
        effort: "ultra",
      },
    },
    expected: {
      model: "gpt-5.4",
      instructions: "be terse\n\nand precise",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "weather in hanoi?",
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "function_call",
              id: "wire_fc_1",
              call_id: "wire_call_a",
              name: "get_weather",
              arguments: "{\"city\":\"hanoi\"}",
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "function_call_output",
              id: "wire_fc_1",
              call_id: "wire_call_a",
              output: "31C",
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              summary: [
                {
                  type: "summary_text",
                  text: "checked",
                },
              ],
              encrypted_content: "enc",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "get_weather",
          parameters: {
            type: "object",
            properties: {
              city: {
                type: "string",
              },
            },
          },
        },
        {
          type: "web_search",
        },
        {
          type: "custom",
          name: "thing",
        },
      ],
      toolChoice: {
        type: "function",
        name: "get_weather",
      },
      include: [
        "reasoning.encrypted_content",
      ],
      textFormat: {
        type: "json_schema",
        name: "out",
        schema: {
          type: "object",
        },
      },
      reasoningEffort: "max",
      stream: true,
      passthrough: false,
      metadata: {
        source: "openai",
        path: "/v1/responses",
      },
    },
  },
  {
    name: "responses: tool role and assistant content parts, no instructions anywhere",
    path: "/v1/responses",
    body: {
      model: "other-model",
      input: [
        {
          role: "user",
          content: "hi",
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "hello",
            },
            {
              type: "refusal",
              refusal: "no",
            },
          ],
        },
        {
          role: "tool",
          content: {
            type: "function_call_output",
            call_id: "wire_call_b",
            output: "done",
          },
        },
      ],
      reasoning_effort: "high",
      tools: "not-array",
      tool_choice: "auto",
    },
    expected: {
      model: "other-model",
      instructions: "You are a helpful assistant.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "hi",
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "hello",
            },
            {
              type: "output_text",
              text: "no",
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "function_call_output",
              call_id: "wire_call_b",
              output: "done",
            },
          ],
        },
      ],
      tools: undefined,
      toolChoice: "auto",
      include: undefined,
      textFormat: undefined,
      reasoningEffort: undefined,
      stream: false,
      passthrough: false,
      metadata: {
        source: "openai",
        path: "/v1/responses",
      },
    },
  },
  {
    name: "chat: system and developer messages, chat tool shapes, response_format json_schema",
    path: "/v1/chat/completions",
    body: {
      model: "other-model",
      messages: [
        {
          role: "system",
          content: "be terse",
        },
        {
          role: "developer",
          content: [
            {
              type: "text",
              text: "and precise",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "weather?",
            },
            {
              type: "image_url",
              image_url: {
                url: "data:image/png;base64,AAAA",
                detail: "low",
              },
            },
          ],
        },
        {
          role: "assistant",
          content: "checking",
          tool_calls: [
            {
              id: "wire_call_a",
              type: "function",
              function: {
                name: "get_weather",
                arguments: "{\"city\":\"hanoi\"}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "wire_call_a",
          content: "31C",
        },
        {
          role: "function",
          content: "dropped",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "look up weather",
            parameters: {
              type: "object",
              properties: {
                city: {
                  type: "string",
                },
              },
            },
          },
          strict: true,
        },
        {
          type: "web_search",
        },
      ],
      tool_choice: {
        type: "function",
        function: {
          name: "get_weather",
        },
      },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "out",
          schema: {
            type: "object",
          },
          strict: true,
        },
      },
      reasoning_effort: "high",
      stream: false,
    },
    expected: {
      model: "other-model",
      instructions: "be terse\n\nand precise",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "weather?",
            },
            {
              type: "input_image",
              image_url: "data:image/png;base64,AAAA",
              detail: "low",
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "checking",
            },
            {
              type: "function_call",
              id: "wire_call_a",
              call_id: "wire_call_a",
              name: "get_weather",
              arguments: "{\"city\":\"hanoi\"}",
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "function_call_output",
              call_id: "wire_call_a",
              output: "31C",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "look up weather",
          parameters: {
            type: "object",
            properties: {
              city: {
                type: "string",
              },
            },
          },
          strict: true,
        },
        {
          type: "web_search",
        },
      ],
      toolChoice: {
        type: "function",
        function: {
          name: "get_weather",
        },
      },
      include: undefined,
      textFormat: {
        type: "json_schema",
        name: "out",
        schema: {
          type: "object",
        },
        strict: true,
      },
      reasoningEffort: undefined,
      stream: false,
      passthrough: false,
      metadata: {
        source: "openai",
        path: "/v1/chat/completions",
      },
    },
  },
  {
    name: "chat: gpt-5 suffix, json_object response_format, stream omitted",
    path: "/v1/chat/completions",
    body: {
      model: "gpt-5_low",
      messages: [
        {
          role: "user",
          content: "hi",
        },
      ],
      response_format: {
        type: "json_object",
      },
    },
    expected: {
      model: "gpt-5",
      instructions: "You are a helpful assistant.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "hi",
            },
          ],
        },
      ],
      tools: undefined,
      toolChoice: undefined,
      include: undefined,
      textFormat: {
        type: "json_object",
      },
      reasoningEffort: "low",
      stream: false,
      passthrough: false,
      metadata: {
        source: "openai",
        path: "/v1/chat/completions",
      },
    },
  },
  {
    name: "embeddings: fallback branch filters non-canonical input",
    path: "/v1/embeddings",
    body: {
      model: "text-embedding-3-small",
      input: [
        "a",
        "b",
      ],
    },
    expected: {
      model: "text-embedding-3-small",
      instructions: undefined,
      input: [],
      stream: false,
      passthrough: false,
      metadata: {
        source: "openai",
        path: "/v1/embeddings",
      },
    },
  },
  {
    name: "unknown route: fallback branch keeps canonical-shaped input and coerces stream",
    path: "/v1/some-unrecognized-route",
    body: {
      model: 123,
      instructions: "sys",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "x",
            },
          ],
        },
        {
          role: "system",
          content: [],
        },
        {
          role: "user",
          content: "not-an-array",
        },
      ],
      stream: 1,
    },
    expected: {
      model: "",
      instructions: "sys",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "x",
            },
          ],
        },
      ],
      stream: true,
      passthrough: false,
      metadata: {
        source: "openai",
        path: "/v1/some-unrecognized-route",
      },
    },
  },
  {
    name: "responses: empty body",
    path: "/v1/responses",
    body: {},
    expected: {
      model: "",
      instructions: "You are a helpful assistant.",
      input: [],
      tools: undefined,
      toolChoice: undefined,
      include: undefined,
      textFormat: undefined,
      reasoningEffort: undefined,
      stream: false,
      passthrough: false,
      metadata: {
        source: "openai",
        path: "/v1/responses",
      },
    },
  },
  {
    name: "chat: empty body",
    path: "/v1/chat/completions",
    body: {},
    expected: {
      model: "",
      instructions: "You are a helpful assistant.",
      input: [],
      tools: undefined,
      toolChoice: undefined,
      include: undefined,
      textFormat: undefined,
      reasoningEffort: undefined,
      stream: false,
      passthrough: false,
      metadata: {
        source: "openai",
        path: "/v1/chat/completions",
      },
    },
  },
  {
    name: "unknown route: empty body",
    path: "/v1/some-unrecognized-route",
    body: {},
    expected: {
      model: "",
      instructions: undefined,
      input: [],
      stream: false,
      passthrough: false,
      metadata: {
        source: "openai",
        path: "/v1/some-unrecognized-route",
      },
    },
  },
]
