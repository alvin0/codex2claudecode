import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_Request } from "../../../src/core/canonical"
import type { JsonObject } from "../../../src/core/types"
import { convertCanonicalToKiroPayload } from "../../../src/upstream/kiro"
import type { KiroEffortSelection, KiroGeneratePayload } from "../../../src/upstream/kiro/types"

/**
 * Feature: native-api-mode, Property 13: The Kiro payload never carries ignored fields
 *
 * Requirement 3.1 (no `inferenceConfig`), 3.2 (instructions ride inside
 * `userInputMessage.content`), 3.5 (no `inferenceConfig` / `maxTokens` for a request carrying
 * `sampling.maxOutputTokens`), 3.6 (no `systemPrompt` at either level), 14.3 (the Kiro payload
 * built from any canonical request carries neither key).
 *
 * The three forbidden names are absent from `KiroGeneratePayload` structurally, so a test that
 * only reads the top level would restate the type. This one works on the serialized payload
 * instead: it deep-scans every key at every depth, bounds the key set of each object the
 * builder emits, and asserts that the *values* the ignored fields would have carried never
 * appear as a leaf anywhere. A mutation that smuggles `maxOutputTokens` in under any other
 * spelling, at any depth, fails clause 3 even though clause 1 would miss the rename.
 */

const SENTINEL = "ZZ_INSTRUCTION_SENTINEL_ZZ"
const FORBIDDEN_KEYS = ["inferenceConfig", "maxTokens", "systemPrompt"] as const
const ALLOWED_PAYLOAD_KEYS = new Set(["conversationState", "profileArn", "additionalModelRequestFields"])
const ALLOWED_CONVERSATION_STATE_KEYS = new Set(["conversationId", "currentMessage", "chatTriggerType", "history"])
const ALLOWED_USER_INPUT_MESSAGE_KEYS = new Set(["content", "modelId", "origin", "userInputMessageContext", "images"])

const textChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz .,_-".split("")
const encoder = new TextEncoder()

const tools: JsonObject[] = [
  { type: "function", name: "save", description: "save a record", parameters: { type: "object", properties: { value: { type: "string" } } } },
  { type: "function", name: "load", description: "load a record", parameters: { type: "object", properties: {} } },
]

function safeText(maxLength: number) {
  return fc.array(fc.constantFrom(...textChars), { minLength: 1, maxLength }).map((chars) => chars.join(""))
}

const messageArb: fc.Arbitrary<Canonical_InputMessageLike> = fc.oneof(
  safeText(60).map((text) => ({ role: "user" as const, content: [{ type: "input_text", text }] })),
  safeText(60).map((text) => ({ role: "assistant" as const, content: [{ type: "output_text", text }] })),
  fc.record({ id: fc.integer({ min: 1, max: 4 }), name: fc.constantFrom("save", "load", "absent") }).map(({ id, name }) => ({
    role: "assistant" as const,
    content: [{ type: "function_call", call_id: `call_${id}`, name, arguments: JSON.stringify({ value: "v" }) }],
  })),
  fc.record({ id: fc.integer({ min: 1, max: 4 }), output: fc.oneof(fc.constant(""), safeText(40)) }).map(({ id, output }) => ({
    role: "tool" as const,
    content: [{ type: "function_call_output", call_id: `call_${id}`, output }],
  })),
  safeText(30).map((text) => ({
    role: "assistant" as const,
    content: [{ type: "thinking", thinking: text, signature: "sig" } as JsonObject, { type: "output_text", text }],
  })),
)

type Canonical_InputMessageLike = Canonical_Request["input"][number]

const samplingArb = fc.option(
  fc.record({
    // Distinctive magnitudes so a value that leaks into the payload is unmistakable.
    maxOutputTokens: fc.option(fc.integer({ min: 90_001, max: 99_999 }), { nil: undefined }),
    temperature: fc.option(fc.integer({ min: 100_001, max: 999_999 }).map((n) => n / 1_000_000), { nil: undefined }),
    topP: fc.option(fc.integer({ min: 100_001, max: 999_999 }).map((n) => n / 1_000_000), { nil: undefined }),
    stopSequences: fc.option(fc.array(safeText(8).map((text) => `ZZSTOP_${text}`), { minLength: 1, maxLength: 3 }), { nil: undefined }),
  }),
  { nil: undefined },
)

const thinkingArb = fc.option(
  fc.record({
    mode: fc.constantFrom("enabled" as const, "disabled" as const, "adaptive" as const),
    budgetTokens: fc.option(fc.integer({ min: 80_001, max: 89_999 }), { nil: undefined }),
  }),
  { nil: undefined },
)

const cacheHintArb = fc.option(
  fc.array(
    fc.record({
      scope: fc.constantFrom("system" as const, "tools" as const, "history" as const),
      ttl: fc.option(safeText(4).map((text) => `ZZTTL_${text}`), { nil: undefined }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  { nil: undefined },
)

const instructionsArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(""),
  safeText(40).map((text) => `${SENTINEL} ${text}`),
  safeText(300).map((text) => `${SENTINEL} ${text}`),
)

const effortArb = fc.option(
  fc.record({
    schemaPath: fc.constantFrom("output_config" as const, "reasoning" as const),
    level: fc.constantFrom("low", "medium", "high"),
  }),
  { nil: undefined },
)

const caseArb = fc.record({
  input: fc.array(messageArb, { maxLength: 6 }),
  toolCount: fc.integer({ min: 0, max: 2 }),
  toolChoice: fc.constantFrom(undefined, "auto", "required", { type: "function", name: "save" } as JsonObject),
  sampling: samplingArb,
  thinking: thinkingArb,
  cacheHint: cacheHintArb,
  instructions: instructionsArb,
  effort: effortArb,
  authType: fc.constantFrom("kiro_desktop" as const, "aws_sso_oidc" as const),
  parallelToolCalls: fc.option(fc.boolean(), { nil: undefined }),
  forceTrim: fc.boolean(),
})

type PayloadCase = typeof caseArb extends fc.Arbitrary<infer T> ? T : never

interface Leaf {
  path: string
  value: string | number | boolean | null
}

function walk(value: unknown, path: string, keys: Array<{ path: string; key: string }>, leaves: Leaf[]) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, keys, leaves))
    return
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.push({ path, key })
      walk(child, path ? `${path}.${key}` : key, keys, leaves)
    }
    return
  }
  leaves.push({ path, value: value as Leaf["value"] })
}

function scan(payload: KiroGeneratePayload) {
  const keys: Array<{ path: string; key: string }> = []
  const leaves: Leaf[] = []
  walk(payload, "", keys, leaves)
  return { keys, leaves }
}

function buildRequest(sample: PayloadCase, extraHistory: Canonical_InputMessageLike[]): Canonical_Request {
  return {
    model: "kiro-model",
    ...(sample.instructions === undefined ? {} : { instructions: sample.instructions }),
    input: [...extraHistory, ...sample.input],
    tools: tools.slice(0, sample.toolCount),
    toolChoice: sample.toolChoice,
    stream: false,
    passthrough: false,
    metadata: {},
    ...(sample.sampling ? { sampling: sample.sampling } : {}),
    ...(sample.thinking ? { thinking: sample.thinking } : {}),
    ...(sample.cacheHint ? { cacheHint: sample.cacheHint } : {}),
    ...(sample.parallelToolCalls === undefined ? {} : { parallelToolCalls: sample.parallelToolCalls }),
  }
}

function convert(sample: PayloadCase, request: Canonical_Request, payloadSizeLimitBytes: number) {
  return convertCanonicalToKiroPayload(request, tools.slice(0, sample.toolCount), {
    modelId: "kiro-model",
    authType: sample.authType,
    profileArn: "arn:aws:codewhisperer:::profile/TEST",
    instructions: sample.instructions,
    payloadSizeLimitBytes,
    payloadOverflowMode: "trim",
    effort: sample.effort as KiroEffortSelection | undefined,
  })
}

function forbiddenValues(sample: PayloadCase) {
  const numbers: number[] = []
  const strings: string[] = []
  if (sample.sampling?.maxOutputTokens !== undefined) numbers.push(sample.sampling.maxOutputTokens)
  if (sample.sampling?.temperature !== undefined) numbers.push(sample.sampling.temperature)
  if (sample.sampling?.topP !== undefined) numbers.push(sample.sampling.topP)
  for (const stop of sample.sampling?.stopSequences ?? []) strings.push(stop)
  if (sample.thinking?.budgetTokens !== undefined) numbers.push(sample.thinking.budgetTokens)
  for (const hint of sample.cacheHint ?? []) if (hint.ttl) strings.push(hint.ttl)
  return { numbers, strings }
}

describe("Kiro payload shape properties", () => {
  test("Property 13: The Kiro payload never carries ignored fields", () => {
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      fc.assert(fc.property(caseArb, (sample) => {
        // The trim path rebuilds the payload from scratch and re-embeds the instructions, so it
        // gets the same scrutiny as the direct path. The limit is derived from the untrimmed size
        // so trimming always fires and always converges.
        const filler = "f".repeat(800)
        const extraHistory: Canonical_InputMessageLike[] = sample.forceTrim
          ? Array.from({ length: 8 }, (_unused, index) => index % 2 === 0
            ? { role: "user" as const, content: [{ type: "input_text", text: `u${index}-${filler}` }] }
            : { role: "assistant" as const, content: [{ type: "output_text", text: `a${index}-${filler}` }] })
          : []
        const request = buildRequest(sample, extraHistory)
        const untrimmed = convert(sample, request, 10_000_000)
        const limit = sample.forceTrim ? Math.floor(encoder.encode(JSON.stringify(untrimmed)).length * 0.75) : 10_000_000
        const payload = sample.forceTrim ? convert(sample, request, limit) : untrimmed
        const { keys, leaves } = scan(payload)

        // Clause 1 — no forbidden key at any depth, not merely at the top level.
        for (const forbidden of FORBIDDEN_KEYS) {
          const hits = keys.filter((entry) => entry.key === forbidden).map((entry) => `${entry.path}.${entry.key}`)
          expect(hits).toEqual([])
        }

        // Clause 2 — every object the builder emits stays inside its declared key set, so an
        // ignored field cannot arrive under a fresh sibling name either.
        expect([...Object.keys(payload)].filter((key) => !ALLOWED_PAYLOAD_KEYS.has(key))).toEqual([])
        expect(Object.keys(payload.conversationState).filter((key) => !ALLOWED_CONVERSATION_STATE_KEYS.has(key))).toEqual([])
        const userInputMessages = [
          payload.conversationState.currentMessage.userInputMessage,
          ...(payload.conversationState.history ?? []).flatMap((entry) => "userInputMessage" in entry ? [entry.userInputMessage] : []),
        ]
        for (const message of userInputMessages) {
          expect(Object.keys(message).filter((key) => !ALLOWED_USER_INPUT_MESSAGE_KEYS.has(key))).toEqual([])
        }

        // Clause 3 — the values the ignored fields would have carried never reach the wire under
        // any spelling. This is what a rename of `maxTokens` cannot escape.
        const { numbers, strings } = forbiddenValues(sample)
        for (const value of numbers) {
          expect(leaves.filter((leaf) => leaf.value === value).map((leaf) => leaf.path)).toEqual([])
        }
        const serialized = JSON.stringify(payload)
        for (const value of strings) expect(serialized).not.toContain(value)

        // Clause 4 — non-empty instruction text is present, and every occurrence of it sits
        // inside a `userInputMessage.content`; nowhere else in the payload.
        if (sample.instructions) {
          const carriers = userInputMessages.filter((message) => message.content.includes(SENTINEL))
          expect(carriers.length).toBeGreaterThan(0)
          const sentinelLeaves = leaves.filter((leaf) => typeof leaf.value === "string" && leaf.value.includes(SENTINEL))
          expect(sentinelLeaves.length).toBeGreaterThan(0)
          for (const leaf of sentinelLeaves) expect(leaf.path).toMatch(/userInputMessage\.content$/)
        } else {
          expect(serialized).not.toContain(SENTINEL)
        }

        // Clause 5 — the current message still carries content, so the absence of the ignored
        // fields is not achieved by emitting an empty payload.
        expect(payload.conversationState.currentMessage.userInputMessage.content.length).toBeGreaterThan(0)
        if (sample.forceTrim) expect(encoder.encode(serialized).length).toBeLessThanOrEqual(limit)
      }), { numRuns: 200 })
    } finally {
      console.warn = originalWarn
    }
  })
})
