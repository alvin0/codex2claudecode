// Feature: native-api-mode, Property 20: Inbound field mapping preserves values and omits absent
// members.
//
// For any wire body in Claude or OpenAI format, each present sampling, thinking, stop-sequence, and
// parallel-tool field appears in its canonical destination with the mapped value,
// `disable_parallel_tool_use: true` yields `parallelToolCalls: false`, and for any subset of the
// sampling fields the `sampling` member is present if and only if the subset is non-empty, with no
// sub-member present holding `undefined`.
//
// **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6**
//
// ## What this file owns, and why it goes through the composed paths
//
// Task 14.3 **removed** clause 3 of Property 19 from `test/inbound/openai/normalize.property.test.ts`
// — the clause asserting that the seven wire fields the new members would come from leave canonical
// output entirely unchanged. That clause was true when written and false by design after 14.3, and the
// handover recorded in that file says its guarantee "becomes Property 20's claim … at task 14.4" with
// nothing weakened standing in for it.
//
// So this file has to carry that guarantee forward **in its positive form**: those wire fields now
// reach canonical, with their values preserved. A Property 20 that only exercised
// `claudeSamplingMembers()` and `openAISamplingMembers()` in isolation would leave a real gap exactly
// where clause 3 used to be — the mappers could be perfect while `convert.ts` dropped the spread, or
// spread it before a member that overwrote it, and nothing in the suite would notice. Every clause
// below that has a composed form therefore runs `claudeToCanonicalRequest()` and
// `normalizeCanonicalRequest()` as well as the mapper, and clause 9 states the handover directly: the
// mapper's whole result is deep-equal to the composed request's projection onto the four members, so
// composition can neither drop, reorder, nor alter what the mapper decided.
//
// The mappers are still called directly, because they are the only place a *pure* claim can be made:
// `claudeToCanonicalRequest()` throws for several tool and document shapes, so the generators feeding
// the composed path have to stay inside the bodies it accepts, while the mapper accepts anything.
// Neither view is sufficient alone.
//
// ## Two as-built decisions this file tests as built, not as one might assume
//
// Both are documented in the mappers' own doc comments, both were flagged by task 14.1, and both are
// **reasoned behaviour rather than accident** — so they are asserted here rather than "corrected".
//
// 1. **`thinking.mode` when the wire `type` is absent or unrecognized** (clause 4). Three ordered
//    outcomes: a recognized `type` maps identically; no recognized type **but a usable
//    `budget_tokens` → `mode: "enabled"`**, because a budget is only meaningful when thinking runs and
//    `thinkingBudget` is the feature Kiro declares `degrade` — the notice needs the budget present in
//    canonical to be writable at all; neither → the member is **omitted** rather than given a guessed
//    mode. `budgetTokens` is carried even alongside `mode: "disabled"`: inbound reports what arrived,
//    and reconciling a contradictory pair is upstream policy.
//
// 2. **`disable_parallel_tool_use` is asymmetric across its two locations** (clause 6). The
//    request-level `tool_choice` copy is inverted in **both** directions — `true` → `false` and an
//    explicit `false` → `true`. A per-tool copy is read **only in the narrowing direction**: any tool
//    carrying `true` yields `false`, and no tool can yield `true`, because a per-toolset permission is
//    not a request-level one. The request-level field wins whenever present. Property 20's text says
//    only "`disable_parallel_tool_use: true` yields `parallelToolCalls: false`", which both readings
//    satisfy; the asymmetry is the built one and is asserted in both directions so a later change to
//    either half is visible.
//
//    One detail worth naming because the wire type invites the opposite reading: the narrowing scan is
//    `body.tools.some((tool) => tool.disable_parallel_tool_use === true)` — **any** tool, not only an
//    `mcp_toolset`. `ClaudeMcpToolset` is the only tool type that declares the field, but
//    `ClaudeFunctionTool` extends `JsonObject`, so a function tool can carry it and does narrow. The
//    generator produces both kinds so the clause describes the code that exists.
//
// ## The third as-built decision: the OpenAI fallback route carries nothing (clause 10)
//
// Task 14.3 spread `openAISamplingMembers()` into the `/v1/chat/completions` and `/v1/responses`
// branches and **deliberately not** into the fallback branch that serves `/v1/embeddings` and any
// unrecognized path. Requirement 13.4 is satisfied without it — `src/inbound/openai/index.ts`
// short-circuits `/v1/embeddings` into `upstream.embeddingsRaw()` before `normalizeCanonicalRequest`
// is reached, so the two generation routes cover every reachable generation request — and presence
// there would be actively wrong: upstream resolvers key `sampling` / `outputLength` / `stopSequences`
// off presence, so reading `max_tokens` off an embeddings body would fire a policy decision about a
// reply length that request has no reply for. Clause 10 pins that so the asymmetry stays a decision
// rather than becoming a bug someone "fixes" in either direction without noticing the other.
//
// ## Generator strategy
//
// - **Numbers**: the full space a client can put in a `number` field, not just plausible ones. Both
//   zeroes (`-0` is a distinct value with the same `typeof`, and value preservation is asserted with
//   `Object.is` so a `+0`/`-0` confusion cannot hide behind `toEqual`), one, negative, non-integer,
//   subnormal, `MAX_SAFE_INTEGER`, `MAX_VALUE`, `1e300`, and all three non-finite values — every one
//   of them is `typeof "number"`, so every one is a field a client sent, and the contract's answer for
//   each is stated. Off-contract non-numeric values (`"0.9"`, `null`, `[]`, `{}`, `true`) are generated
//   too, at lower weight: bodies arrive off the network, so "a string where a number belongs" is a real
//   input, and the contract's answer is "absent".
// - **Stop shapes**: `[]`, `[""]`, `["  "]` (kept — the filter is `length > 0`, not `trim()`), mixed
//   `[null, "STOP"]`, `[42]`, `[{}]`, a bare `"STOP"` and `""` (a valid shape on the OpenAI wire and
//   not on Claude's — the two mappers legitimately differ here and both answers are asserted), plus
//   `null` and a non-array object.
// - **The iff clause gets exhaustive treatment rather than sampling** (clauses 7 and 8). The sampling
//   sub-member sources are a small closed set per inbound — 4 for Claude, 6 for OpenAI — so all 16 and
//   all 64 subsets are enumerated against several value profiles each, rather than trusting a sampler
//   to reach the empty subset and the sixteen-way OpenAI precedence interactions.
//
// ## Anti-vacuity
//
// Clauses 1 and 2 exist so the rest cannot pass by measuring nothing: clause 1 pins the destinations
// as real members of `Canonical_Request` and the source→destination map as onto and (bar the three
// max-tokens spellings) injective, and clause 2 samples every generator and asserts each numeric
// category, each stop shape, and each *outcome* — member present, member absent, sub-member present,
// sub-member absent — actually occurs. Every generative clause additionally counts its own present /
// absent outcomes, in the idiom of `test/upstream/output-length.property.test.ts` and
// `test/inbound/openai/normalize.property.test.ts`.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_Request } from "../../src/core/canonical"
import type { JsonObject } from "../../src/core/types"
import { claudeToCanonicalRequest } from "../../src/inbound/claude/convert"
import { claudeSamplingMembers } from "../../src/inbound/claude/sampling"
import type { ClaudeMessagesRequest } from "../../src/inbound/types"
import { normalizeCanonicalRequest } from "../../src/inbound/openai/normalize"
import { openAISamplingMembers } from "../../src/inbound/openai/sampling"

// ---------------------------------------------------------------------------------------------
// The contract under test, restated as data
// ---------------------------------------------------------------------------------------------

/**
 * The four members task 13.1 added and task 14 populates (Requirements 12.1–12.4).
 *
 * `satisfies` keeps the list honest: a rename in `src/core/canonical.ts` fails to compile here rather
 * than silently reducing every clause below to a check on a member that no longer exists.
 */
const NEW_MEMBERS = ["sampling", "thinking", "cacheHint", "parallelToolCalls"] as const satisfies readonly (keyof Canonical_Request)[]

type CanonicalSampling = NonNullable<Canonical_Request["sampling"]>
type SamplingSubMember = keyof CanonicalSampling

/** The four sub-members of `sampling` (Requirement 12.1), derived rather than restated. */
const SAMPLING_SUB_MEMBERS = ["maxOutputTokens", "temperature", "topP", "stopSequences"] as const satisfies readonly SamplingSubMember[]

/** Claude's wire spelling → canonical sub-member (Requirement 13.1). */
const CLAUDE_SAMPLING_SOURCES = {
  max_tokens: "maxOutputTokens",
  temperature: "temperature",
  top_p: "topP",
  stop_sequences: "stopSequences",
} as const satisfies Record<string, SamplingSubMember>

/** The OpenAI wire spellings → canonical sub-member (Requirement 13.4). Three map to one. */
const OPENAI_SAMPLING_SOURCES = {
  max_output_tokens: "maxOutputTokens",
  max_completion_tokens: "maxOutputTokens",
  max_tokens: "maxOutputTokens",
  temperature: "temperature",
  top_p: "topP",
  stop: "stopSequences",
} as const satisfies Record<string, SamplingSubMember>

/**
 * The precedence order among the three output-length spellings, restated here as the *expectation*.
 *
 * Deliberately a second copy of the list in `src/inbound/openai/sampling.ts` rather than an import of
 * it: importing the constant would make the clause "the mapper agrees with itself", which a reordering
 * would satisfy. Written out, a reordering is a failure that names the offending pair.
 */
const OPENAI_MAX_TOKENS_PRECEDENCE = ["max_output_tokens", "max_completion_tokens", "max_tokens"] as const

type ClaudeSourceField = keyof typeof CLAUDE_SAMPLING_SOURCES
type OpenAISourceField = keyof typeof OPENAI_SAMPLING_SOURCES

const CLAUDE_SOURCE_FIELDS = Object.keys(CLAUDE_SAMPLING_SOURCES) as readonly ClaudeSourceField[]
const OPENAI_SOURCE_FIELDS = Object.keys(OPENAI_SAMPLING_SOURCES) as readonly OpenAISourceField[]

/** The three thinking modes canonical accepts (Requirement 12.2). */
const CANONICAL_THINKING_MODES = ["enabled", "disabled", "adaptive"] as const
/** The three cache scopes canonical accepts (Requirement 12.3), in prompt-prefix order. */
const CANONICAL_CACHE_SCOPES = ["tools", "system", "history"] as const

// ---------------------------------------------------------------------------------------------
// The expectation side: presence and value rules, stated independently of the mappers
// ---------------------------------------------------------------------------------------------

/**
 * Only a finite number counts as a value the client sent. JSON has no `NaN` or `Infinity` spelling, so
 * a body carrying one could not be forwarded to any upstream wire as a number; the contract's answer
 * is that the field is absent.
 */
function finiteValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** A thinking budget is usable only when it is a positive finite number. `0` and `-0` are not. */
function positiveValue(value: unknown): number | undefined {
  const numeric = finiteValue(value)
  return numeric !== undefined && numeric > 0 ? numeric : undefined
}

/** A `ttl` is carried only as a non-blank string — a client-supplied duration token, never parsed. */
function ttlValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The stop sequences worth carrying, per inbound.
 *
 * The two inbounds legitimately differ on the *shape* they accept: `stop` is a bare string or an array
 * on the OpenAI wire, while `stop_sequences` is an array on Claude's, so a bare string there is not a
 * stop sequence at all. Both then apply the same entry filter — a string of non-zero length, so `"  "`
 * survives and `""` does not — and both omit the sub-member when nothing survives, because an empty
 * stop sequence would stop generation nowhere and a present-but-useless `stopSequences` would make a
 * `degrade` or `reject` cell fire over nothing.
 */
function usableStopEntries(entries: unknown[]): string[] | undefined {
  const kept = entries.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  return kept.length > 0 ? kept : undefined
}

function expectedClaudeStopSequences(value: unknown): string[] | undefined {
  return Array.isArray(value) ? usableStopEntries(value) : undefined
}

function expectedOpenAIStopSequences(value: unknown): string[] | undefined {
  return usableStopEntries(typeof value === "string" ? [value] : Array.isArray(value) ? value : [])
}

/** The `sampling` object a Claude body must produce, or `{}` when the member must be omitted. */
function expectedClaudeSampling(fields: Partial<Record<ClaudeSourceField, unknown>>): Record<string, unknown> {
  const expected: Record<string, unknown> = {}
  const maxOutputTokens = finiteValue(fields.max_tokens)
  if (maxOutputTokens !== undefined) expected.maxOutputTokens = maxOutputTokens
  const temperature = finiteValue(fields.temperature)
  if (temperature !== undefined) expected.temperature = temperature
  const topP = finiteValue(fields.top_p)
  if (topP !== undefined) expected.topP = topP
  const stopSequences = expectedClaudeStopSequences(fields.stop_sequences)
  if (stopSequences) expected.stopSequences = stopSequences
  return expected
}

/** The `sampling` object an OpenAI body must produce, or `{}` when the member must be omitted. */
function expectedOpenAISampling(fields: Partial<Record<OpenAISourceField, unknown>>): Record<string, unknown> {
  const expected: Record<string, unknown> = {}
  for (const field of OPENAI_MAX_TOKENS_PRECEDENCE) {
    const value = finiteValue(fields[field])
    if (value !== undefined) {
      expected.maxOutputTokens = value
      break
    }
  }
  const temperature = finiteValue(fields.temperature)
  if (temperature !== undefined) expected.temperature = temperature
  const topP = finiteValue(fields.top_p)
  if (topP !== undefined) expected.topP = topP
  const stopSequences = expectedOpenAIStopSequences(fields.stop)
  if (stopSequences) expected.stopSequences = stopSequences
  return expected
}

/** The three ordered outcomes of the `thinking` decision, restated. See the header, decision 1. */
function expectedThinking(thinking: unknown): { mode: string; budgetTokens?: number } | undefined {
  if (!isRecord(thinking)) return undefined
  const budgetTokens = positiveValue(thinking.budget_tokens)
  const recognized = CANONICAL_THINKING_MODES.find((mode) => mode === thinking.type)
  const mode = recognized ?? (budgetTokens !== undefined ? "enabled" : undefined)
  if (!mode) return undefined
  return { mode, ...(budgetTokens !== undefined && { budgetTokens }) }
}

/** The asymmetric `parallelToolCalls` decision, restated. See the header, decision 2. */
function expectedParallelToolCalls(requestLevel: unknown, perTool: readonly unknown[]): boolean | undefined {
  if (typeof requestLevel === "boolean") return !requestLevel
  return perTool.some((value) => value === true) ? false : undefined
}

// ---------------------------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------------------------

/** The four members actually present on a canonical request, as own keys. */
function newMembersOf(request: Canonical_Request): Record<string, unknown> {
  const projection: Record<string, unknown> = {}
  for (const member of NEW_MEMBERS) {
    if (Object.hasOwn(request, member)) projection[member] = request[member]
  }
  return projection
}

/**
 * Numeric-aware value comparison. `Object.is` rather than `toEqual` so a `-0` arriving as `+0` — a
 * real difference in a value the client sent — cannot pass.
 */
function assertSameValue(actual: unknown, expected: unknown, context: string): void {
  if (Array.isArray(expected)) {
    expect(actual, context).toStrictEqual(expected)
    return
  }
  expect(Object.is(actual, expected), `${context}: expected ${String(expected)}, got ${String(actual)}`).toBe(true)
}

/**
 * The whole `sampling` claim in one place: present as an own key **iff** at least one sub-member is
 * expected, sub-member key set exactly the expected one, every value preserved, and no sub-member
 * holding `undefined` (Requirement 13.5).
 */
function assertSamplingMember(members: Record<string, unknown>, expected: Record<string, unknown>, context: string): void {
  const expectedKeys = Object.keys(expected).sort()

  expect(Object.hasOwn(members, "sampling"), `${context}: sampling presence must equal ${expectedKeys.length > 0}`).toBe(expectedKeys.length > 0)
  if (expectedKeys.length === 0) {
    // Omitted, not present-and-undefined and not present-and-empty.
    expect(members.sampling, `${context}: sampling must not be present at all`).toBeUndefined()
    return
  }

  const sampling = members.sampling
  expect(isRecord(sampling), `${context}: sampling must be an object`).toBe(true)
  const record = sampling as Record<string, unknown>
  expect(Object.keys(record).sort(), `${context}: sampling sub-member set`).toEqual(expectedKeys)
  expect(Object.keys(record).length, `${context}: sampling must never be an empty object`).toBeGreaterThan(0)

  for (const key of expectedKeys) {
    expect(Object.hasOwn(record, key), `${context}: sampling.${key} must be an own key`).toBe(true)
    expect(record[key], `${context}: sampling.${key} must not hold undefined`).not.toBeUndefined()
    assertSameValue(record[key], expected[key], `${context}: sampling.${key}`)
  }
}

/**
 * The structural half of Requirement 13.5, applied to whatever members are present: no own key holds
 * `undefined`, no object is empty, no list is empty, and every sub-member key and enum value is one
 * canonical declares.
 */
function assertMembersWellFormed(members: Record<string, unknown>, context: string): void {
  for (const member of NEW_MEMBERS) {
    if (!Object.hasOwn(members, member)) continue
    expect(members[member], `${context}: \`${member}\` is present as an own key holding undefined`).not.toBeUndefined()
  }

  const sampling = members.sampling
  if (sampling !== undefined) {
    const record = sampling as Record<string, unknown>
    expect(Object.keys(record).length, `${context}: sampling is an empty object`).toBeGreaterThan(0)
    for (const key of Object.keys(record)) {
      expect(SAMPLING_SUB_MEMBERS as readonly string[], `${context}: unknown sampling sub-member`).toContain(key)
      expect(record[key], `${context}: sampling.${key} holds undefined`).not.toBeUndefined()
    }
    const stopSequences = record.stopSequences
    if (stopSequences !== undefined) {
      expect(Array.isArray(stopSequences)).toBe(true)
      expect((stopSequences as unknown[]).length, `${context}: stopSequences is empty`).toBeGreaterThan(0)
      for (const entry of stopSequences as unknown[]) {
        expect(typeof entry).toBe("string")
        expect((entry as string).length, `${context}: stopSequences carries an empty entry`).toBeGreaterThan(0)
      }
    }
  }

  const thinking = members.thinking
  if (thinking !== undefined) {
    const record = thinking as Record<string, unknown>
    expect(CANONICAL_THINKING_MODES.some((mode) => mode === record.mode), `${context}: thinking.mode is ${String(record.mode)}`).toBe(true)
    for (const key of Object.keys(record)) {
      expect(["mode", "budgetTokens"], `${context}: unknown thinking sub-member`).toContain(key)
      expect(record[key], `${context}: thinking.${key} holds undefined`).not.toBeUndefined()
    }
  }

  const cacheHint = members.cacheHint
  if (cacheHint !== undefined) {
    expect(Array.isArray(cacheHint)).toBe(true)
    const entries = cacheHint as Record<string, unknown>[]
    expect(entries.length, `${context}: cacheHint is present but empty`).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(CANONICAL_CACHE_SCOPES.some((scope) => scope === entry.scope), `${context}: cacheHint scope is ${String(entry.scope)}`).toBe(true)
      for (const key of Object.keys(entry)) {
        expect(["scope", "ttl"], `${context}: unknown cacheHint key`).toContain(key)
        expect(entry[key], `${context}: cacheHint.${key} holds undefined`).not.toBeUndefined()
      }
    }
  }

  const parallelToolCalls = members.parallelToolCalls
  if (parallelToolCalls !== undefined) expect(typeof parallelToolCalls).toBe("boolean")
}

// ---------------------------------------------------------------------------------------------
// Wire bodies
// ---------------------------------------------------------------------------------------------

/**
 * A minimal, always-convertible Claude body. `claudeToCanonicalRequest()` throws for several tool and
 * document shapes, so every composed-path generator builds on this base and adds only shapes it
 * accepts; the mapper-only clauses are free of that constraint and say so where they exploit it.
 */
function claudeBody(fields: Record<string, unknown> = {}): ClaudeMessagesRequest {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hello" }],
    ...fields,
  } as ClaudeMessagesRequest
}

/** A chat-completions body, for `/v1/chat/completions`. */
function openAIChatBody(fields: Record<string, unknown> = {}): JsonObject {
  return { model: "gpt-5.4", messages: [{ role: "user", content: "hello" }], ...fields }
}

/** A responses body, for `/v1/responses`. */
function openAIResponsesBody(fields: Record<string, unknown> = {}): JsonObject {
  return { model: "gpt-5.4", input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }], ...fields }
}

const CHAT_PATH = "/v1/chat/completions"
const RESPONSES_PATH = "/v1/responses"

/** The two branches that carry the members, each with a body shaped for it. */
const OPENAI_GENERATION_ROUTES = [
  { path: CHAT_PATH, body: openAIChatBody },
  { path: RESPONSES_PATH, body: openAIResponsesBody },
] as const

/** The branches that carry none: the embeddings route and any path no descriptor claims. */
const OPENAI_NON_GENERATION_PATHS = ["/v1/embeddings", "/v1/some-unrecognized-route"] as const

function normalizeOpenAI(path: string, body: JsonObject): Canonical_Request {
  return normalizeCanonicalRequest(path, body, { passthrough: false })
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

/**
 * Every numeric shape a client can put in one of these fields. All are `typeof "number"`, so all are
 * fields the client sent; the contract's answer differs only between finite and non-finite.
 */
const NUMERIC_EDGE_CASES: readonly number[] = [
  0,
  -0,
  1,
  -1,
  0.5,
  1.5,
  -1.5,
  2,
  256,
  512,
  4096,
  200_000,
  -4096,
  256.7,
  Number.EPSILON,
  Number.MIN_VALUE,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_VALUE,
  1e300,
  2 ** 31,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
]

/** Off-contract values a network body can still carry in a numeric field. The answer is "absent". */
const NON_NUMERIC_VALUES: readonly unknown[] = ["0.9", "", null, [], [0.9], {}, true, false]

const numericFieldArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...NUMERIC_EDGE_CASES) },
  { weight: 3, arbitrary: fc.integer({ min: -8192, max: 200_000 }) },
  { weight: 2, arbitrary: fc.double() },
  { weight: 2, arbitrary: fc.constantFrom(...NON_NUMERIC_VALUES) },
)

/** Adversarial stop shapes, including the two that are valid on one wire and not the other. */
const STOP_SHAPES: readonly unknown[] = [
  ["STOP"],
  ["STOP", "HALT"],
  ["  "],
  [""],
  ["", "STOP"],
  [],
  [null, "STOP"],
  [42],
  [{}],
  [["STOP"]],
  "STOP",
  "",
  null,
  42,
  { 0: "STOP" },
]

const stopFieldArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...STOP_SHAPES) },
  { weight: 2, arbitrary: fc.array(fc.string({ maxLength: 6 }), { maxLength: 3 }) },
)

/**
 * An independently-omittable subset of Claude's four sampling sources.
 *
 * The explicit empty arm is not decoration. With six independently-present keys the empty subset has
 * probability 2⁻⁶ under `requiredKeys: []`, so at a few hundred runs a sampler can miss it entirely —
 * and the empty subset is the case Requirement 13.5 is actually about. Weighting it in makes the
 * omit-side of every generative clause below reached by construction rather than by luck. The
 * exhaustive clauses do not depend on this; they enumerate.
 */
const claudeSamplingFieldsArb: fc.Arbitrary<Partial<Record<ClaudeSourceField, unknown>>> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<Partial<Record<ClaudeSourceField, unknown>>>({}) },
  {
    weight: 9,
    arbitrary: fc.record(
      {
        max_tokens: numericFieldArb,
        temperature: numericFieldArb,
        top_p: numericFieldArb,
        stop_sequences: stopFieldArb,
      },
      { requiredKeys: [] },
    ),
  },
)

/** An independently-omittable subset of OpenAI's six sampling sources, with the same empty arm. */
const openAISamplingFieldsArb: fc.Arbitrary<Partial<Record<OpenAISourceField, unknown>>> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<Partial<Record<OpenAISourceField, unknown>>>({}) },
  {
    weight: 9,
    arbitrary: fc.record(
      {
        max_output_tokens: numericFieldArb,
        max_completion_tokens: numericFieldArb,
        max_tokens: numericFieldArb,
        temperature: numericFieldArb,
        top_p: numericFieldArb,
        stop: stopFieldArb,
      },
      { requiredKeys: [] },
    ),
  },
)

/** `thinking` shapes: recognized types, unrecognized ones, budget-only, and non-objects. */
const claudeThinkingArb: fc.Arbitrary<unknown> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record(
      {
        type: fc.constantFrom<unknown>("enabled", "disabled", "adaptive", "turbo", "", "ENABLED", null, 1, true),
        budget_tokens: fc.oneof(fc.constantFrom(...NUMERIC_EDGE_CASES), fc.integer({ min: -100, max: 32_000 }), fc.constantFrom<unknown>("2048", null)),
      },
      { requiredKeys: [] },
    ),
  },
  { weight: 1, arbitrary: fc.constantFrom<unknown>(null, undefined, "enabled", 5, [], [{ type: "enabled" }]) },
)

/** One `cache_control` marker, or nothing on that block. */
const cacheMarkerArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 3, arbitrary: fc.constant(undefined) },
  { weight: 2, arbitrary: fc.constant({}) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant("ephemeral") }) },
  {
    weight: 4,
    arbitrary: fc.record({ type: fc.constant("ephemeral"), ttl: fc.constantFrom<unknown>("5m", "1h", "", "   ", 300, null, ["5m"]) }),
  },
  // Not a marker at all: `cache_control` present but not an object.
  { weight: 1, arbitrary: fc.constantFrom<unknown>(null, "ephemeral", 1) },
)

interface CacheSpec {
  tools: readonly unknown[]
  system: readonly unknown[]
  history: readonly (readonly unknown[])[]
}

const cacheSpecArb: fc.Arbitrary<CacheSpec> = fc.record({
  tools: fc.array(cacheMarkerArb, { maxLength: 3 }),
  system: fc.array(cacheMarkerArb, { maxLength: 3 }),
  history: fc.array(fc.array(cacheMarkerArb, { maxLength: 2 }), { maxLength: 3 }),
})

/**
 * The Claude body a cache spec describes, plus the `cacheHint` list it must produce.
 *
 * Blocks are built with the markers in spec order and the expectation is built from the same spec, in
 * tools → system → history order: the order the marked segments occupy in the prompt prefix Anthropic
 * caches, which is the only stable order available because key order in a decoded JSON body is not a
 * fact about what the client wrote.
 */
function cacheBodyAndExpectation(spec: CacheSpec): { body: ClaudeMessagesRequest; expected: Record<string, unknown>[] } {
  const expected: Record<string, unknown>[] = []
  const collect = (markers: readonly unknown[], scope: string) => {
    for (const marker of markers) {
      if (!isRecord(marker)) continue
      const ttl = ttlValue(marker.ttl)
      expected.push({ scope, ...(ttl !== undefined && { ttl }) })
    }
  }
  collect(spec.tools, "tools")
  collect(spec.system, "system")
  for (const message of spec.history) collect(message, "history")

  const withMarker = (block: Record<string, unknown>, marker: unknown) => (marker === undefined ? block : { ...block, cache_control: marker })

  return {
    body: claudeBody({
      tools: spec.tools.map((marker, index) => withMarker({ name: `tool_${index}`, input_schema: { type: "object", properties: {} } }, marker)),
      system: spec.system.map((marker, index) => withMarker({ type: "text", text: `sys ${index}` }, marker)),
      messages:
        spec.history.length > 0
          ? spec.history.map((markers, index) => ({
              role: index % 2 === 0 ? "user" : "assistant",
              content: markers.map((marker, blockIndex) => withMarker({ type: "text", text: `msg ${index}.${blockIndex}` }, marker)),
            }))
          : [{ role: "user", content: "hello" }],
    }),
    expected,
  }
}

interface ParallelSpec {
  /** `tool_choice.disable_parallel_tool_use`, or `undefined` for "the client wrote nothing". */
  requestLevel: unknown
  /** One entry per tool, mixing `mcp_toolset` and function tools — both can carry the field. */
  perTool: readonly unknown[]
  /** Whether `tool_choice` exists at all, so the "no `tool_choice` object" case is reached. */
  hasToolChoice: boolean
}

const parallelSpecArb: fc.Arbitrary<ParallelSpec> = fc.record({
  requestLevel: fc.constantFrom<unknown>(undefined, true, false, "true", "false", null, 1, 0),
  perTool: fc.array(fc.constantFrom<unknown>(undefined, true, false, "true", null), { maxLength: 3 }),
  hasToolChoice: fc.boolean(),
})

/**
 * The Claude body a parallel spec describes.
 *
 * Tools alternate between `mcp_toolset` — the only tool type whose declared shape carries the field —
 * and a function tool that carries it anyway, which `ClaudeFunctionTool extends JsonObject` permits and
 * the mapper's `body.tools.some(...)` scan reads. Each toolset gets a matching `mcp_servers` entry so
 * the composed path resolves rather than throwing `Unknown MCP server`.
 */
function parallelBody(spec: ParallelSpec): ClaudeMessagesRequest {
  const tools = spec.perTool.map((value, index) =>
    index % 2 === 0
      ? { type: "mcp_toolset", mcp_server_name: `server_${index}`, ...(value === undefined ? {} : { disable_parallel_tool_use: value }) }
      : { name: `tool_${index}`, input_schema: { type: "object", properties: {} }, ...(value === undefined ? {} : { disable_parallel_tool_use: value }) },
  )
  const mcpServers = spec.perTool
    .map((_, index) => index)
    .filter((index) => index % 2 === 0)
    .map((index) => ({ name: `server_${index}`, url: `https://mcp.test/${index}` }))

  return claudeBody({
    ...(tools.length > 0 && { tools, mcp_servers: mcpServers }),
    ...(spec.hasToolChoice && {
      tool_choice: { type: "auto", ...(spec.requestLevel === undefined ? {} : { disable_parallel_tool_use: spec.requestLevel }) },
    }),
  })
}

/**
 * One Claude body carrying a sampling subset, a `thinking` object, a cache spec, and a parallel spec at
 * once, plus the `cacheHint` list it must produce.
 *
 * The merge is explicit rather than a spread of the two builders' bodies. Spreading
 * `cacheBodyAndExpectation().body` and then `parallelBody()` into one literal looks right and silently
 * loses the cache spec's `messages` and `tools`, because the second builder's own base body overwrites
 * both — which is exactly how the `history` scope stopped being generated the first time this file was
 * written, caught by the coverage clause below. `tools` are concatenated, `system` and `messages` come
 * from the cache spec, and `tool_choice` / `mcp_servers` from the parallel spec.
 */
function combinedClaudeBody(parts: {
  sampling: Partial<Record<ClaudeSourceField, unknown>>
  thinking: unknown
  cacheSpec: CacheSpec
  parallel: ParallelSpec
}): { body: ClaudeMessagesRequest; cacheHint: Record<string, unknown>[] } {
  const cache = cacheBodyAndExpectation(parts.cacheSpec)
  const parallelPart = parallelBody(parts.parallel) as Record<string, unknown>
  const cacheTools = (cache.body.tools ?? []) as unknown[]
  const parallelTools = (parallelPart.tools ?? []) as unknown[]

  return {
    body: claudeBody({
      ...parts.sampling,
      ...(parts.thinking === undefined ? {} : { thinking: parts.thinking }),
      system: cache.body.system,
      messages: cache.body.messages,
      ...(cacheTools.length + parallelTools.length > 0 && { tools: [...cacheTools, ...parallelTools] }),
      ...(parallelPart.mcp_servers ? { mcp_servers: parallelPart.mcp_servers } : {}),
      ...(parallelPart.tool_choice ? { tool_choice: parallelPart.tool_choice } : {}),
    }),
    cacheHint: cache.expected,
  }
}

// ---------------------------------------------------------------------------------------------
// Exhaustive subset machinery for the iff clause
// ---------------------------------------------------------------------------------------------

function subsetsOf<T>(items: readonly T[]): readonly (readonly T[])[] {
  return items.reduce<T[][]>((acc, item) => [...acc, ...acc.map((subset) => [...subset, item])], [[]])
}

/** Value sets in which **every** field is usable, so presence tracks the subset exactly. */
const CLAUDE_USABLE_PROFILES: readonly Record<ClaudeSourceField, unknown>[] = [
  { max_tokens: 512, temperature: 0.2, top_p: 0.9, stop_sequences: ["STOP"] },
  // Zeroes: "be fully deterministic" must not read as "expressed no preference".
  { max_tokens: 0, temperature: 0, top_p: 0, stop_sequences: ["", "HALT"] },
  { max_tokens: -0, temperature: -1.5, top_p: 1, stop_sequences: ["  ", "X"] },
  { max_tokens: Number.MAX_SAFE_INTEGER, temperature: 2, top_p: Number.MIN_VALUE, stop_sequences: ["\n"] },
]

/** Value sets in which **no** field is usable, so the member must be absent for every subset. */
const CLAUDE_UNUSABLE_PROFILES: readonly Record<ClaudeSourceField, unknown>[] = [
  { max_tokens: Number.NaN, temperature: Number.POSITIVE_INFINITY, top_p: Number.NEGATIVE_INFINITY, stop_sequences: [] },
  { max_tokens: "512", temperature: null, top_p: [0.9], stop_sequences: [""] },
  { max_tokens: {}, temperature: true, top_p: "0", stop_sequences: "STOP" },
]

const OPENAI_USABLE_PROFILES: readonly Record<OpenAISourceField, unknown>[] = [
  // Distinct values per spelling, so precedence is observable rather than accidental.
  { max_output_tokens: 1111, max_completion_tokens: 2222, max_tokens: 3333, temperature: 0.7, top_p: 0.5, stop: ["STOP"] },
  { max_output_tokens: 0, max_completion_tokens: -0, max_tokens: 1, temperature: 0, top_p: 0, stop: "HALT" },
  { max_output_tokens: -7, max_completion_tokens: 0.5, max_tokens: Number.MAX_SAFE_INTEGER, temperature: 2, top_p: 1, stop: ["  ", "Z"] },
]

const OPENAI_UNUSABLE_PROFILES: readonly Record<OpenAISourceField, unknown>[] = [
  {
    max_output_tokens: Number.NaN,
    max_completion_tokens: Number.POSITIVE_INFINITY,
    max_tokens: Number.NEGATIVE_INFINITY,
    temperature: Number.NaN,
    top_p: Number.POSITIVE_INFINITY,
    stop: [],
  },
  { max_output_tokens: "1111", max_completion_tokens: null, max_tokens: [], temperature: {}, top_p: true, stop: "" },
]

function pick<K extends string>(profile: Record<K, unknown>, fields: readonly K[]): Partial<Record<K, unknown>> {
  const picked: Partial<Record<K, unknown>> = {}
  for (const field of fields) picked[field] = profile[field]
  return picked
}

/** The sub-members a usable subset must produce, so the iff clause can state both directions. */
function claudeDestinationsOf(fields: readonly ClaudeSourceField[]): string[] {
  return [...new Set(fields.map((field) => CLAUDE_SAMPLING_SOURCES[field]))].sort()
}

function openAIDestinationsOf(fields: readonly OpenAISourceField[]): string[] {
  return [...new Set(fields.map((field) => OPENAI_SAMPLING_SOURCES[field]))].sort()
}

// ---------------------------------------------------------------------------------------------
// Property 20
// ---------------------------------------------------------------------------------------------

describe("Inbound field mapping preserves values and omits absent members", () => {
  /**
   * Anti-vacuity, contract side. Every clause below is a claim about canonical *destinations*, and all
   * of them would pass just as well against a contract where those destinations do not exist or where
   * two sources collapsed onto one sub-member by mistake. So the destinations are checked against the
   * canonical type (by `satisfies`, at compile time) and the two source maps are checked for being
   * onto the sub-member set and — bar the three deliberately-merged max-tokens spellings — injective.
   *
   * **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 13.1, 13.4**
   */
  test("Feature: native-api-mode, Property 20: the canonical destinations exist and the wire sources map onto them without accidental collisions", () => {
    expect(NEW_MEMBERS).toEqual(["sampling", "thinking", "cacheHint", "parallelToolCalls"])
    expect(SAMPLING_SUB_MEMBERS).toEqual(["maxOutputTokens", "temperature", "topP", "stopSequences"])

    // Claude: four sources, four distinct destinations — a bijection.
    expect(CLAUDE_SOURCE_FIELDS).toHaveLength(4)
    expect([...new Set(Object.values(CLAUDE_SAMPLING_SOURCES))].sort()).toEqual([...SAMPLING_SUB_MEMBERS].sort())
    expect(new Set(Object.values(CLAUDE_SAMPLING_SOURCES)).size).toBe(CLAUDE_SOURCE_FIELDS.length)

    // OpenAI: six sources, four destinations, and the only merge is the three max-tokens spellings.
    expect(OPENAI_SOURCE_FIELDS).toHaveLength(6)
    expect([...new Set(Object.values(OPENAI_SAMPLING_SOURCES))].sort()).toEqual([...SAMPLING_SUB_MEMBERS].sort())
    const merged = OPENAI_SOURCE_FIELDS.filter((field) => OPENAI_SAMPLING_SOURCES[field] === "maxOutputTokens")
    expect([...merged].sort()).toEqual([...OPENAI_MAX_TOKENS_PRECEDENCE].sort())
    expect(OPENAI_MAX_TOKENS_PRECEDENCE).toEqual(["max_output_tokens", "max_completion_tokens", "max_tokens"])

    // The two enums the members narrow to (Requirements 12.2, 12.3).
    expect(CANONICAL_THINKING_MODES).toEqual(["enabled", "disabled", "adaptive"])
    expect([...CANONICAL_CACHE_SCOPES].sort()).toEqual(["history", "system", "tools"])

    // And the subset enumeration really is exhaustive over both closed sets.
    expect(subsetsOf(CLAUDE_SOURCE_FIELDS)).toHaveLength(16)
    expect(subsetsOf(OPENAI_SOURCE_FIELDS)).toHaveLength(64)
  })

  /**
   * Anti-vacuity, generator side. Each generator reaches every category it claims to, and — the part
   * that matters more — every *outcome* occurs: member present and member absent, each sub-member
   * present and absent, each thinking outcome, each cache scope, and both `parallelToolCalls` values.
   * A generator that only produced plausible values would leave the interesting half of `typeof
   * "number"` untested and would let a mapper that ignored non-finite numbers pass unmeasured.
   */
  test("Feature: native-api-mode, Property 20: the generated wire space reaches every numeric shape, every stop shape, and every mapping outcome", () => {
    const numbers = fc.sample(numericFieldArb, { numRuns: 1500, seed: 20 })
    const numericCategories: Record<string, (value: unknown) => boolean> = {
      zero: (value) => Object.is(value, 0),
      negativeZero: (value) => Object.is(value, -0),
      one: (value) => value === 1,
      negative: (value) => typeof value === "number" && value < 0,
      nonInteger: (value) => typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value),
      veryLarge: (value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) > 1e15,
      notFinite: (value) => typeof value === "number" && !Number.isFinite(value),
      nan: (value) => typeof value === "number" && Number.isNaN(value),
      nonNumeric: (value) => typeof value !== "number",
    }
    for (const [name, predicate] of Object.entries(numericCategories)) {
      expect(numbers.some(predicate), `the numeric generator never produced a ${name} value`).toBe(true)
    }

    const stops = fc.sample(stopFieldArb, { numRuns: 1500, seed: 20 })
    const stopCategories: Record<string, (value: unknown) => boolean> = {
      usableArray: (value) => expectedClaudeStopSequences(value) !== undefined,
      emptyArray: (value) => Array.isArray(value) && value.length === 0,
      onlyEmptyStrings: (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => entry === ""),
      mixedEntries: (value) => Array.isArray(value) && value.some((entry) => typeof entry !== "string"),
      bareString: (value) => typeof value === "string" && value.length > 0,
      notAnArray: (value) => !Array.isArray(value) && typeof value !== "string",
      // The one shape the two inbounds answer differently.
      claudeRejectsOpenAIAccepts: (value) => expectedClaudeStopSequences(value) === undefined && expectedOpenAIStopSequences(value) !== undefined,
    }
    for (const [name, predicate] of Object.entries(stopCategories)) {
      expect(stops.some(predicate), `the stop generator never produced a ${name} shape`).toBe(true)
    }

    // Outcome coverage on the Claude mapper, over the composed generators.
    const claudeSamples = fc.sample(fc.tuple(claudeSamplingFieldsArb, claudeThinkingArb, cacheSpecArb, parallelSpecArb), { numRuns: 1200, seed: 20 })
    const seen = {
      samplingPresent: 0,
      samplingAbsent: 0,
      thinkingPresent: 0,
      thinkingAbsent: 0,
      thinkingInferredEnabled: 0,
      thinkingBudgetWithDisabled: 0,
      cacheHintPresent: 0,
      cacheHintAbsent: 0,
      parallelTrue: 0,
      parallelFalse: 0,
      parallelAbsent: 0,
    }
    const subMembersSeen = new Set<string>()
    const scopesSeen = new Set<unknown>()

    for (const [sampling, thinking, cacheSpec, parallel] of claudeSamples) {
      const { body } = combinedClaudeBody({ sampling, thinking, cacheSpec, parallel })
      const members = claudeSamplingMembers(body) as Record<string, unknown>

      if (Object.hasOwn(members, "sampling")) {
        seen.samplingPresent += 1
        for (const key of Object.keys(members.sampling as Record<string, unknown>)) subMembersSeen.add(key)
      } else seen.samplingAbsent += 1

      const thinkingMember = members.thinking as { mode?: string; budgetTokens?: number } | undefined
      if (thinkingMember) {
        seen.thinkingPresent += 1
        if (thinkingMember.mode === "enabled" && !CANONICAL_THINKING_MODES.some((mode) => mode === (thinking as Record<string, unknown> | undefined)?.type)) {
          seen.thinkingInferredEnabled += 1
        }
        if (thinkingMember.mode === "disabled" && thinkingMember.budgetTokens !== undefined) seen.thinkingBudgetWithDisabled += 1
      } else seen.thinkingAbsent += 1

      if (Object.hasOwn(members, "cacheHint")) {
        seen.cacheHintPresent += 1
        for (const entry of members.cacheHint as Record<string, unknown>[]) scopesSeen.add(entry.scope)
      } else seen.cacheHintAbsent += 1

      if (members.parallelToolCalls === true) seen.parallelTrue += 1
      else if (members.parallelToolCalls === false) seen.parallelFalse += 1
      else seen.parallelAbsent += 1
    }

    for (const [name, count] of Object.entries(seen)) {
      expect(count, `the generated space never produced the \`${name}\` outcome`).toBeGreaterThan(0)
    }
    expect([...subMembersSeen].sort()).toEqual([...SAMPLING_SUB_MEMBERS].sort())
    expect([...scopesSeen].sort()).toEqual(["history", "system", "tools"])
  })

  /**
   * Clause 3. Every present Claude sampling field reaches its canonical destination with the mapped
   * value, and every absent or unusable one leaves its sub-member off — asserted on the mapper **and**
   * on the composed `claudeToCanonicalRequest()` output, which must agree exactly.
   *
   * **Validates: Requirements 12.1, 13.1, 13.5**
   */
  test("Feature: native-api-mode, Property 20: every present Claude sampling field reaches its canonical destination with the mapped value", () => {
    let present = 0
    let absent = 0

    fc.assert(
      fc.property(claudeSamplingFieldsArb, (fields) => {
        const body = claudeBody(fields)
        const expected = expectedClaudeSampling(fields)

        const members = claudeSamplingMembers(body) as Record<string, unknown>
        assertSamplingMember(members, expected, `claude mapper, fields=${JSON.stringify(Object.keys(fields))}`)
        assertMembersWellFormed(members, "claude mapper")

        // The composed path: the same answer, reached through the function the gateway calls.
        const composed = newMembersOf(claudeToCanonicalRequest(body))
        assertSamplingMember(composed, expected, `claude composed, fields=${JSON.stringify(Object.keys(fields))}`)
        assertMembersWellFormed(composed, "claude composed")

        if (Object.keys(expected).length > 0) present += 1
        else absent += 1
      }),
      { numRuns: 400 },
    )

    expect(present, "no generated body produced a sampling member").toBeGreaterThan(0)
    expect(absent, "no generated body left the sampling member off").toBeGreaterThan(0)
  })

  /**
   * Clause 4. `thinking.type` → `mode` and `thinking.budget_tokens` → `budgetTokens`, with the three
   * ordered outcomes of the as-built decision: recognized type maps identically; no recognized type but
   * a usable budget infers `enabled`; neither omits the member rather than guessing. `budgetTokens` is
   * carried even alongside `mode: "disabled"`.
   *
   * **Validates: Requirements 12.2, 12.7, 13.2, 13.5**
   */
  test("Feature: native-api-mode, Property 20: Claude thinking maps type to mode and budget_tokens to budgetTokens, and is omitted rather than guessed", () => {
    let mapped = 0
    let inferred = 0
    let omitted = 0

    fc.assert(
      fc.property(claudeThinkingArb, (thinking) => {
        const body = claudeBody(thinking === undefined ? {} : { thinking })
        const expected = expectedThinking(thinking)

        for (const [label, members] of [
          ["claude mapper", claudeSamplingMembers(body) as Record<string, unknown>],
          ["claude composed", newMembersOf(claudeToCanonicalRequest(body))],
        ] as const) {
          expect(Object.hasOwn(members, "thinking"), `${label}: thinking presence for ${JSON.stringify(thinking)}`).toBe(expected !== undefined)
          if (expected === undefined) {
            expect(members.thinking, `${label}: thinking must be omitted, not present-and-undefined`).toBeUndefined()
            continue
          }
          const record = members.thinking as Record<string, unknown>
          expect(Object.keys(record).sort(), `${label}: thinking sub-member set`).toEqual(Object.keys(expected).sort())
          expect(record.mode).toBe(expected.mode)
          if (expected.budgetTokens !== undefined) assertSameValue(record.budgetTokens, expected.budgetTokens, `${label}: thinking.budgetTokens`)
          assertMembersWellFormed(members, label)
        }

        if (expected === undefined) omitted += 1
        else if (CANONICAL_THINKING_MODES.some((mode) => mode === (thinking as Record<string, unknown>).type)) mapped += 1
        else inferred += 1
      }),
      { numRuns: 400 },
    )

    expect(mapped, "no generated body mapped a recognized thinking type").toBeGreaterThan(0)
    expect(inferred, "no generated body inferred `enabled` from a budget alone").toBeGreaterThan(0)
    expect(omitted, "no generated body left the thinking member off").toBeGreaterThan(0)
  })

  /**
   * Clause 5. Every `cache_control` marker reaches `cacheHint` with the scope of **where** it was found
   * — the client writes no scope string — a `ttl` is carried only as a non-blank string, and the member
   * is omitted rather than empty when nothing was marked.
   *
   * **Validates: Requirements 12.3, 13.5**
   */
  test("Feature: native-api-mode, Property 20: Claude cache_control markers reach cacheHint with the scope of their location", () => {
    let present = 0
    let absent = 0
    let withTtl = 0

    fc.assert(
      fc.property(cacheSpecArb, (spec) => {
        const { body, expected } = cacheBodyAndExpectation(spec)

        for (const [label, members] of [
          ["claude mapper", claudeSamplingMembers(body) as Record<string, unknown>],
          ["claude composed", newMembersOf(claudeToCanonicalRequest(body))],
        ] as const) {
          expect(Object.hasOwn(members, "cacheHint"), `${label}: cacheHint presence`).toBe(expected.length > 0)
          if (expected.length === 0) {
            expect(members.cacheHint, `${label}: cacheHint must be omitted, never an empty array`).toBeUndefined()
            continue
          }
          expect(members.cacheHint, `${label}: cacheHint entries and order`).toStrictEqual(expected)
          assertMembersWellFormed(members, label)
        }

        if (expected.length > 0) present += 1
        else absent += 1
        if (expected.some((entry) => entry.ttl !== undefined)) withTtl += 1
      }),
      { numRuns: 400 },
    )

    expect(present, "no generated body marked anything").toBeGreaterThan(0)
    expect(absent, "no generated body marked nothing").toBeGreaterThan(0)
    expect(withTtl, "no generated marker carried a usable ttl").toBeGreaterThan(0)
  })

  /**
   * Clause 6. `disable_parallel_tool_use: true` yields `parallelToolCalls: false`, with the as-built
   * asymmetry asserted in both of its directions: the request-level field inverts both ways, a per-tool
   * copy only narrows, and the request-level field wins whenever present.
   *
   * **Validates: Requirements 12.4, 13.3, 13.5**
   */
  test("Feature: native-api-mode, Property 20: disable_parallel_tool_use is inverted at request level and only narrows from a tool", () => {
    let inverted = 0
    let widened = 0
    let narrowedByTool = 0
    let toolPermissionIgnored = 0
    let omitted = 0

    fc.assert(
      fc.property(parallelSpecArb, (spec) => {
        const body = parallelBody(spec)
        const requestLevel = spec.hasToolChoice ? spec.requestLevel : undefined
        const expected = expectedParallelToolCalls(requestLevel, spec.perTool)

        for (const [label, members] of [
          ["claude mapper", claudeSamplingMembers(body) as Record<string, unknown>],
          ["claude composed", newMembersOf(claudeToCanonicalRequest(body))],
        ] as const) {
          expect(Object.hasOwn(members, "parallelToolCalls"), `${label}: presence for ${JSON.stringify(spec)}`).toBe(expected !== undefined)
          if (expected === undefined) {
            expect(members.parallelToolCalls, `${label}: must be omitted, not present-and-undefined`).toBeUndefined()
            continue
          }
          expect(members.parallelToolCalls, `${label}: value for ${JSON.stringify(spec)}`).toBe(expected)
          assertMembersWellFormed(members, label)
        }

        // The property text's named case, stated directly rather than only via the expectation.
        if (requestLevel === true) {
          expect(claudeSamplingMembers(body).parallelToolCalls).toBe(false)
          inverted += 1
        }
        if (requestLevel === false) {
          expect(claudeSamplingMembers(body).parallelToolCalls).toBe(true)
          widened += 1
        }
        if (typeof requestLevel !== "boolean" && spec.perTool.some((value) => value === true)) {
          // A tool can narrow to `false`…
          expect(claudeSamplingMembers(body).parallelToolCalls).toBe(false)
          narrowedByTool += 1
        }
        if (typeof requestLevel !== "boolean" && spec.perTool.length > 0 && !spec.perTool.some((value) => value === true)) {
          // …and can never widen to `true`, not even with an explicit per-tool `false`.
          expect("parallelToolCalls" in claudeSamplingMembers(body)).toBe(false)
          toolPermissionIgnored += 1
        }
        if (expected === undefined) omitted += 1
      }),
      { numRuns: 500 },
    )

    expect(inverted, "no generated body inverted an explicit true").toBeGreaterThan(0)
    expect(widened, "no generated body inverted an explicit false").toBeGreaterThan(0)
    expect(narrowedByTool, "no generated body narrowed from a tool").toBeGreaterThan(0)
    expect(toolPermissionIgnored, "no generated body exercised a tool that must not widen").toBeGreaterThan(0)
    expect(omitted, "no generated body left the member off").toBeGreaterThan(0)
  })

  /**
   * Clause 7. The OpenAI half of the value-preservation claim, on both routes that carry the members:
   * the three output-length spellings resolve in precedence order over the *usable* ones,
   * `temperature` / `top_p` / `stop` map straight across, and `parallel_tool_calls` is carried
   * **uninverted** — this wire spells the preference positively, unlike Claude's.
   *
   * **Validates: Requirements 12.1, 12.4, 13.4, 13.5**
   */
  test("Feature: native-api-mode, Property 20: every present OpenAI sampling field reaches its canonical destination, with the max-tokens spellings resolved in precedence order", () => {
    let present = 0
    let absent = 0
    let precedenceExercised = 0
    let parallelSeen = 0

    fc.assert(
      fc.property(openAISamplingFieldsArb, fc.constantFrom<unknown>(undefined, true, false, "true", null, 1), (fields, parallelToolCalls) => {
        const wireFields = { ...fields, ...(parallelToolCalls === undefined ? {} : { parallel_tool_calls: parallelToolCalls }) }
        const expected = expectedOpenAISampling(fields)
        // No inversion on this wire, and only an actual boolean counts as a preference.
        const expectedParallel = typeof parallelToolCalls === "boolean" ? parallelToolCalls : undefined

        const mapperMembers = openAISamplingMembers(wireFields) as Record<string, unknown>
        assertSamplingMember(mapperMembers, expected, `openai mapper, fields=${JSON.stringify(Object.keys(fields))}`)
        assertMembersWellFormed(mapperMembers, "openai mapper")
        expect(Object.hasOwn(mapperMembers, "parallelToolCalls")).toBe(expectedParallel !== undefined)
        if (expectedParallel !== undefined) expect(mapperMembers.parallelToolCalls).toBe(expectedParallel)

        // `thinking` and `cacheHint` have no source on this wire, so the mapper must never invent them.
        expect(Object.hasOwn(mapperMembers, "thinking")).toBe(false)
        expect(Object.hasOwn(mapperMembers, "cacheHint")).toBe(false)

        for (const route of OPENAI_GENERATION_ROUTES) {
          const composed = newMembersOf(normalizeOpenAI(route.path, route.body(wireFields)))
          assertSamplingMember(composed, expected, `openai composed ${route.path}, fields=${JSON.stringify(Object.keys(fields))}`)
          assertMembersWellFormed(composed, `openai composed ${route.path}`)
          expect(Object.hasOwn(composed, "parallelToolCalls"), `openai composed ${route.path}: parallelToolCalls presence`).toBe(expectedParallel !== undefined)
          if (expectedParallel !== undefined) expect(composed.parallelToolCalls).toBe(expectedParallel)
        }

        if (Object.keys(expected).length > 0) present += 1
        else absent += 1
        if (OPENAI_MAX_TOKENS_PRECEDENCE.filter((field) => finiteValue(fields[field]) !== undefined).length > 1) precedenceExercised += 1
        if (expectedParallel !== undefined) parallelSeen += 1
      }),
      { numRuns: 400 },
    )

    expect(present, "no generated body produced a sampling member").toBeGreaterThan(0)
    expect(absent, "no generated body left the sampling member off").toBeGreaterThan(0)
    expect(precedenceExercised, "no generated body carried two usable output-length spellings").toBeGreaterThan(0)
    expect(parallelSeen, "no generated body expressed a parallel-tool preference").toBeGreaterThan(0)
  })

  /**
   * Clause 8, **the iff clause, Claude half — exhaustive rather than sampled.** All 16 subsets of the
   * four sources, each against four all-usable value profiles and three all-unusable ones:
   *
   * - usable profile → `sampling` present exactly when the subset is non-empty, with exactly the
   *   destinations of that subset and no others;
   * - unusable profile → `sampling` absent for **every** subset, including the full one;
   * - in both directions: never an own key holding `undefined`, never an empty object.
   *
   * Enumerated because the sources are a small closed set and the empty subset — the case Requirement
   * 13.5 is about — is the one a sampler is least likely to hit often.
   *
   * **Validates: Requirements 12.1, 13.1, 13.5**
   */
  test("Feature: native-api-mode, Property 20: for every subset of the Claude sampling fields, the sampling member is present exactly when the subset is non-empty", () => {
    const subsets = subsetsOf(CLAUDE_SOURCE_FIELDS)
    expect(subsets).toHaveLength(16)
    let checked = 0

    for (const subset of subsets) {
      for (const profile of CLAUDE_USABLE_PROFILES) {
        const fields = pick(profile, subset)
        const body = claudeBody(fields)
        const context = `usable subset=[${subset.join(",")}]`
        const expectedKeys = claudeDestinationsOf(subset)

        for (const [label, members] of [
          ["mapper", claudeSamplingMembers(body) as Record<string, unknown>],
          ["composed", newMembersOf(claudeToCanonicalRequest(body))],
        ] as const) {
          // The iff, stated as the subset's own emptiness rather than derived from the values.
          expect(Object.hasOwn(members, "sampling"), `${label} ${context}: presence must equal ${subset.length > 0}`).toBe(subset.length > 0)
          if (subset.length > 0) {
            expect(Object.keys(members.sampling as Record<string, unknown>).sort(), `${label} ${context}: sub-member set`).toEqual(expectedKeys)
          }
          assertSamplingMember(members, expectedClaudeSampling(fields), `${label} ${context}`)
          assertMembersWellFormed(members, `${label} ${context}`)
        }
        checked += 1
      }

      for (const profile of CLAUDE_UNUSABLE_PROFILES) {
        const fields = pick(profile, subset)
        const body = claudeBody(fields)
        const context = `unusable subset=[${subset.join(",")}]`

        for (const [label, members] of [
          ["mapper", claudeSamplingMembers(body) as Record<string, unknown>],
          ["composed", newMembersOf(claudeToCanonicalRequest(body))],
        ] as const) {
          expect(Object.hasOwn(members, "sampling"), `${label} ${context}: nothing usable, so the member must be absent`).toBe(false)
          assertSamplingMember(members, {}, `${label} ${context}`)
          assertMembersWellFormed(members, `${label} ${context}`)
        }
        checked += 1
      }
    }

    expect(checked).toBe(subsets.length * (CLAUDE_USABLE_PROFILES.length + CLAUDE_UNUSABLE_PROFILES.length))
  })

  /**
   * Clause 9, **the iff clause, OpenAI half — exhaustive.** All 64 subsets of the six sources against
   * three all-usable and two all-unusable profiles, on both routes that carry the members.
   *
   * The usable profiles give the three output-length spellings **distinct** values, so the expected
   * `maxOutputTokens` for each of the 56 subsets containing at least one of them is a statement about
   * precedence, not just about presence.
   *
   * **Validates: Requirements 12.1, 13.4, 13.5**
   */
  test("Feature: native-api-mode, Property 20: for every subset of the OpenAI sampling fields, the sampling member is present exactly when the subset is non-empty", () => {
    const subsets = subsetsOf(OPENAI_SOURCE_FIELDS)
    expect(subsets).toHaveLength(64)
    let precedenceSubsets = 0

    for (const subset of subsets) {
      for (const profile of OPENAI_USABLE_PROFILES) {
        const fields = pick(profile, subset)
        const context = `usable subset=[${subset.join(",")}]`
        const expected = expectedOpenAISampling(fields)
        expect(Object.keys(expected).sort(), `${context}: expected destinations`).toEqual(openAIDestinationsOf(subset))

        const views: (readonly [string, Record<string, unknown>])[] = [["mapper", openAISamplingMembers(fields) as Record<string, unknown>]]
        for (const route of OPENAI_GENERATION_ROUTES) views.push([route.path, newMembersOf(normalizeOpenAI(route.path, route.body(fields)))])

        for (const [label, members] of views) {
          expect(Object.hasOwn(members, "sampling"), `${label} ${context}: presence must equal ${subset.length > 0}`).toBe(subset.length > 0)
          assertSamplingMember(members, expected, `${label} ${context}`)
          assertMembersWellFormed(members, `${label} ${context}`)
        }

        const spellings = OPENAI_MAX_TOKENS_PRECEDENCE.filter((field) => subset.includes(field))
        if (spellings.length > 1) {
          // Precedence, not merely presence: the winner is the first spelling in the stated order.
          const winner = spellings[0]!
          assertSameValue((expected as Record<string, unknown>).maxOutputTokens, profile[winner], `${context}: precedence winner ${winner}`)
          precedenceSubsets += 1
        }
      }

      for (const profile of OPENAI_UNUSABLE_PROFILES) {
        const fields = pick(profile, subset)
        const context = `unusable subset=[${subset.join(",")}]`

        const views: (readonly [string, Record<string, unknown>])[] = [["mapper", openAISamplingMembers(fields) as Record<string, unknown>]]
        for (const route of OPENAI_GENERATION_ROUTES) views.push([route.path, newMembersOf(normalizeOpenAI(route.path, route.body(fields)))])

        for (const [label, members] of views) {
          expect(Object.hasOwn(members, "sampling"), `${label} ${context}: nothing usable, so the member must be absent`).toBe(false)
          assertSamplingMember(members, {}, `${label} ${context}`)
          assertMembersWellFormed(members, `${label} ${context}`)
        }
      }
    }

    // 4 of the 8 subsets of the three spellings carry more than one, × 3 usable profiles.
    expect(precedenceSubsets).toBe(4 * 2 ** 3 * OPENAI_USABLE_PROFILES.length)
  })

  /**
   * Clause 10, **the home of Property 19's removed clause 3.** That clause asserted the seven wire
   * fields left canonical output entirely unchanged; here is its positive successor — for any non-empty
   * subset of them, on a wire body of either format, those fields **now reach canonical**, and the whole
   * of what the mapper decided arrives there unaltered.
   *
   * Two directions, both needed:
   *
   * - the composed request's projection onto the four members is **deep-equal to the mapper's entire
   *   result**, so `convert.ts` / `normalize.ts` can neither drop the spread, nor let a later member
   *   overwrite it, nor add a member the mapper did not produce;
   * - the members are genuinely **present** — the clause would be satisfiable by "nothing reaches
   *   canonical and the mapper produces nothing", which is exactly the pre-14.3 state it replaced.
   *
   * The last check is the deliberate exception: the OpenAI fallback branch that serves `/v1/embeddings`
   * and unrecognized paths carries **none** of the members even for a body full of source fields. See
   * the header — that is 14.3's reasoned decision, and pinning it keeps the asymmetry a decision.
   *
   * **Validates: Requirements 12.6, 13.1, 13.2, 13.3, 13.4, 13.5**
   */
  test("Feature: native-api-mode, Property 20: the wire fields Property 19's clause 3 held invisible now reach canonical, whole and unaltered", () => {
    const usableClaudeFieldsArb = claudeSamplingFieldsArb
      .map((fields) => pick(CLAUDE_USABLE_PROFILES[0]!, Object.keys(fields) as ClaudeSourceField[]))
      .filter((fields) => Object.keys(fields).length > 0)
    const usableOpenAIFieldsArb = openAISamplingFieldsArb
      .map((fields) => pick(OPENAI_USABLE_PROFILES[0]!, Object.keys(fields) as OpenAISourceField[]))
      .filter((fields) => Object.keys(fields).length > 0)

    let claudeRich = 0
    let openAIRich = 0

    fc.assert(
      fc.property(usableClaudeFieldsArb, claudeThinkingArb, cacheSpecArb, parallelSpecArb, (fields, thinking, cacheSpec, parallel) => {
        const { body } = combinedClaudeBody({ sampling: fields, thinking, cacheSpec, parallel })

        const mapperMembers = claudeSamplingMembers(body) as Record<string, unknown>
        const composedMembers = newMembersOf(claudeToCanonicalRequest(body))

        // Whole and unaltered: the composed projection *is* the mapper's result.
        expect(composedMembers, "the Claude composed path must carry exactly what the mapper produced").toStrictEqual(mapperMembers)
        // …and it is not the empty object, which is what makes this the positive form of clause 3.
        expect(Object.hasOwn(composedMembers, "sampling"), "a non-empty usable subset must reach canonical").toBe(true)
        for (const field of Object.keys(fields) as ClaudeSourceField[]) {
          const destination = CLAUDE_SAMPLING_SOURCES[field]
          const sampling = composedMembers.sampling as Record<string, unknown>
          expect(Object.hasOwn(sampling, destination), `wire \`${field}\` must reach canonical \`sampling.${destination}\``).toBe(true)
          assertSameValue(sampling[destination], expectedClaudeSampling(fields)[destination], `claude composed sampling.${destination}`)
        }
        assertMembersWellFormed(composedMembers, "claude composed")
        if (Object.keys(composedMembers).length >= 3) claudeRich += 1
      }),
      { numRuns: 300 },
    )

    fc.assert(
      fc.property(usableOpenAIFieldsArb, fc.boolean(), (fields, parallelToolCalls) => {
        const wireFields = { ...fields, parallel_tool_calls: parallelToolCalls }
        const mapperMembers = openAISamplingMembers(wireFields) as Record<string, unknown>

        for (const route of OPENAI_GENERATION_ROUTES) {
          const composedMembers = newMembersOf(normalizeOpenAI(route.path, route.body(wireFields)))
          expect(composedMembers, `${route.path} must carry exactly what the mapper produced`).toStrictEqual(mapperMembers)
          expect(Object.hasOwn(composedMembers, "sampling"), `${route.path}: a non-empty usable subset must reach canonical`).toBe(true)
          expect(composedMembers.parallelToolCalls, `${route.path}: parallel_tool_calls is carried uninverted`).toBe(parallelToolCalls)
          for (const field of Object.keys(fields) as OpenAISourceField[]) {
            const destination = OPENAI_SAMPLING_SOURCES[field]
            const sampling = composedMembers.sampling as Record<string, unknown>
            expect(Object.hasOwn(sampling, destination), `wire \`${field}\` must reach canonical \`sampling.${destination}\``).toBe(true)
          }
          assertMembersWellFormed(composedMembers, `openai composed ${route.path}`)
        }

        // The deliberate exception: the non-generation branches carry none of the members, even for a
        // body carrying every source field.
        for (const path of OPENAI_NON_GENERATION_PATHS) {
          const composedMembers = newMembersOf(normalizeOpenAI(path, openAIResponsesBody(wireFields)))
          expect(composedMembers, `${path} must carry none of the four members`).toStrictEqual({})
        }

        if (Object.keys(mapperMembers).length >= 2) openAIRich += 1
      }),
      { numRuns: 300 },
    )

    expect(claudeRich, "no generated Claude body carried three or more of the members at once").toBeGreaterThan(0)
    expect(openAIRich, "no generated OpenAI body carried both members at once").toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------------------------
// Requirement 13.6: one wire-to-canonical unit assertion per named field
// ---------------------------------------------------------------------------------------------

/**
 * Requirement 13.6 asks for **one unit assertion per field** named in criteria 13.1–13.4. Every one
 * below goes through the composed path — `claudeToCanonicalRequest()` or `normalizeCanonicalRequest()`
 * — rather than the mapper, so each is a statement about what the gateway produces for a request a
 * client could actually send. The mapper-level unit assertions for the Claude fields already exist in
 * `test/inbound/claude-sampling.test.ts` (task 14.1); these are the composed counterparts, and the
 * OpenAI ones have no earlier home.
 *
 * Every field is exercised **alone**, so a failure names one mapping rather than a combination.
 */
describe("Requirement 13.6: one wire-to-canonical mapping per named field", () => {
  function claudeCanonical(fields: Record<string, unknown>): Canonical_Request {
    return claudeToCanonicalRequest(claudeBody(fields))
  }

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): Claude `max_tokens` → `sampling.maxOutputTokens`", () => {
    expect(claudeCanonical({ max_tokens: 512 }).sampling).toStrictEqual({ maxOutputTokens: 512 })
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): Claude `temperature` → `sampling.temperature`", () => {
    expect(claudeCanonical({ temperature: 0.2 }).sampling).toStrictEqual({ temperature: 0.2 })
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): Claude `top_p` → `sampling.topP`", () => {
    expect(claudeCanonical({ top_p: 0.9 }).sampling).toStrictEqual({ topP: 0.9 })
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): Claude `stop_sequences` → `sampling.stopSequences`", () => {
    expect(claudeCanonical({ stop_sequences: ["STOP", "HALT"] }).sampling).toStrictEqual({ stopSequences: ["STOP", "HALT"] })
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): Claude `thinking.type` → `thinking.mode`", () => {
    expect(claudeCanonical({ thinking: { type: "adaptive" } }).thinking).toStrictEqual({ mode: "adaptive" })
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): Claude `thinking.budget_tokens` → `thinking.budgetTokens`", () => {
    expect(claudeCanonical({ thinking: { type: "enabled", budget_tokens: 4096 } }).thinking).toStrictEqual({ mode: "enabled", budgetTokens: 4096 })
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): Claude `disable_parallel_tool_use: true` → `parallelToolCalls: false`", () => {
    expect(claudeCanonical({ tool_choice: { type: "auto", disable_parallel_tool_use: true } }).parallelToolCalls).toBe(false)
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): Claude `cache_control` → `cacheHint`", () => {
    expect(claudeCanonical({ system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }] }).cacheHint).toStrictEqual([
      { scope: "system", ttl: "1h" },
    ])
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): OpenAI `max_output_tokens` → `sampling.maxOutputTokens`", () => {
    expect(normalizeOpenAI(RESPONSES_PATH, openAIResponsesBody({ max_output_tokens: 1024 })).sampling).toStrictEqual({ maxOutputTokens: 1024 })
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): OpenAI `max_completion_tokens` → `sampling.maxOutputTokens`", () => {
    expect(normalizeOpenAI(CHAT_PATH, openAIChatBody({ max_completion_tokens: 2048 })).sampling).toStrictEqual({ maxOutputTokens: 2048 })
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): OpenAI `max_tokens` → `sampling.maxOutputTokens`", () => {
    expect(normalizeOpenAI(CHAT_PATH, openAIChatBody({ max_tokens: 256 })).sampling).toStrictEqual({ maxOutputTokens: 256 })
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): OpenAI `temperature` → `sampling.temperature`", () => {
    expect(normalizeOpenAI(CHAT_PATH, openAIChatBody({ temperature: 0.3 })).sampling).toStrictEqual({ temperature: 0.3 })
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): OpenAI `top_p` → `sampling.topP`", () => {
    expect(normalizeOpenAI(RESPONSES_PATH, openAIResponsesBody({ top_p: 0.8 })).sampling).toStrictEqual({ topP: 0.8 })
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): OpenAI `stop` → `sampling.stopSequences`", () => {
    expect(normalizeOpenAI(CHAT_PATH, openAIChatBody({ stop: "END" })).sampling).toStrictEqual({ stopSequences: ["END"] })
    expect(normalizeOpenAI(RESPONSES_PATH, openAIResponsesBody({ stop: ["END", "FIN"] })).sampling).toStrictEqual({ stopSequences: ["END", "FIN"] })
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): OpenAI `parallel_tool_calls` → `parallelToolCalls`, uninverted", () => {
    expect(normalizeOpenAI(CHAT_PATH, openAIChatBody({ parallel_tool_calls: false })).parallelToolCalls).toBe(false)
    expect(normalizeOpenAI(CHAT_PATH, openAIChatBody({ parallel_tool_calls: true })).parallelToolCalls).toBe(true)
  })

  test("Feature: native-api-mode, Property 20 (Requirement 13.6): a request carrying no sampling field omits the member on both inbounds", () => {
    expect("sampling" in claudeCanonical({})).toBe(false)
    expect("sampling" in normalizeOpenAI(CHAT_PATH, openAIChatBody())).toBe(false)
    expect("sampling" in normalizeOpenAI(RESPONSES_PATH, openAIResponsesBody())).toBe(false)
  })
})
