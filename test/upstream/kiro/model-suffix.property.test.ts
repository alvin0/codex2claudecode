// Feature: native-api-mode — effort carried by a model-identifier suffix.
//
// **Property 17: Model effort suffix parsing round-trips** — for any base identifier and any level
// in that model's enum, parsing `${base}_${level}` yields exactly that base and that level, and
// identifiers matching the `gpt-5` prefix resolve to the same base and level as before this
// feature.
//
// **Validates: Requirements 16.10, 16.11**
//
// ## Why this is its own file rather than a block in `effort.property.test.ts`
//
// `parseModelEffortSuffix()` lives in `src/upstream/kiro/effort.ts`, so the neighbouring file is
// the obvious home. It is deliberately not used: that file is being extended concurrently for
// task 22, and a second editor in it would collide. Nothing here needs its arbitraries — the
// generators below differ anyway, because a *round-trippable* level name is narrower than the
// level names Property 14 must survive (see `arbLevelName`).
//
// ## The two clauses, and the one place they would disagree
//
// The property has two halves and they are not the same claim:
//
//  - **Clause A — the round trip.** Compose an identifier from a base and a level of that model's
//    enum, parse it, get exactly those two values back. This is the claim that suffix resolution
//    happens in the layer holding the enum (Requirement 16.10): a level a model publishes must
//    round-trip *whatever it is named*, including names `src/core/reasoning.ts` has never heard of.
//  - **Clause B — `gpt-5` is untouched.** For the identifiers core already recognizes, the base and
//    level must equal what `normalizeReasoningBody()` produced before this feature (Requirement
//    16.11). The oracle is that function itself, so "the same as before" is asserted against the
//    original rather than against a restatement of it.
//
// The two would disagree on exactly one input shape: `gpt-5_ultra`. Core rewrites `ultra` to `max`,
// so an exact round trip is false there while clause B is true. Clause B governs — it is the
// carve-out the property names — and clause A therefore excludes the identifiers core owns, which
// it detects by asking core rather than by pattern-matching on `gpt-5` here.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { normalizeReasoningBody } from "../../../src/core/reasoning"
import { parseModelEffortSuffix } from "../../../src/upstream/kiro/effort"

/** Characters a model identifier or level name is built from — no `_`, which is the delimiter. */
const IDENT_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-.".split("")

const arbIdentChar = fc.constantFrom(...IDENT_CHARS)

const arbIdent = (maxLength: number) =>
  fc.array(arbIdentChar, { minLength: 1, maxLength }).map((chars) => chars.join(""))

/** Base identifiers Kiro and the gateway actually route, plus generated ones. */
const REAL_BASE_MODELS = ["claude-sonnet-5", "claude-sonnet-4-5", "claude-haiku-4-5", "auto", "gpt-5", "gpt-5.1"] as const

/**
 * A base identifier.
 *
 * The third arm is the interesting one: a base that itself contains an underscore. The split is on
 * the **last** underscore, so `a_b_high` must yield base `a_b` — a first-underscore split would
 * pass every other case here and fail only this one.
 */
const arbBaseModel = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...REAL_BASE_MODELS) },
  { weight: 2, arbitrary: arbIdent(12) },
  { weight: 1, arbitrary: fc.tuple(arbIdent(6), arbIdent(6)).map(([left, right]) => `${left}_${right}`) },
)

/**
 * A level name.
 *
 * Mostly the real vocabulary, sometimes arbitrary — a model's enum is whatever its schema
 * published, and a level named `gentle` must round-trip as readily as `high`.
 *
 * Underscores are excluded, and that is a statement about the encoding rather than a convenience:
 * `${base}_${level}` is delimited by `_`, so a level containing one is not recoverable from the
 * composed identifier by any parser. Generating one would test an impossibility.
 */
const arbLevelName = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom("minimal", "low", "medium", "high", "xhigh", "max") },
  { weight: 1, arbitrary: arbIdent(10) },
)

/** A non-empty, duplicate-free level enum, as `parseEffortMetadata()` produces. */
const arbLevels = fc.uniqueArray(arbLevelName, { minLength: 1, maxLength: 6 })

/** The level vocabulary core's pattern accepts, which is the input space clause B governs. */
const CORE_SUFFIX_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const

/** Identifiers core's pattern recognizes. */
const CORE_BASE_MODELS = ["gpt-5", "gpt-5.1", "gpt-5.2"] as const

/**
 * What `normalizeReasoningBody()` resolves an identifier to — the pre-feature oracle.
 *
 * `reasoning` is present exactly when core recognized the identifier, which is how clause A knows
 * to stand aside without naming a model family in this file.
 */
function coreResolution(model: string): { base: string; effort: string } | undefined {
  const normalized = normalizeReasoningBody({ model }) as { model?: unknown; reasoning?: { effort?: unknown } }
  if (!normalized.reasoning) return undefined
  return { base: String(normalized.model), effort: String(normalized.reasoning.effort) }
}

describe("Feature: native-api-mode, Property 17: model effort suffix parsing round-trips", () => {
  test("clause A: any level of the model's own enum round-trips with its base identifier", () => {
    fc.assert(
      fc.property(arbBaseModel, arbLevels, fc.nat({ max: 5 }), (base, levels, pick) => {
        const level = levels[pick % levels.length]!
        const composed = `${base}_${level}`
        // The identifiers core owns are clause B's; see the header.
        fc.pre(coreResolution(composed) === undefined)

        expect(parseModelEffortSuffix(composed, levels)).toEqual({
          baseModel: base,
          level,
          requestedLevel: level,
          degraded: false,
        })
      }),
      { numRuns: 300 },
    )
  })

  test("clause B: identifiers matching the gpt-5 prefix resolve exactly as they did before", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CORE_BASE_MODELS),
        fc.constantFrom(...CORE_SUFFIX_LEVELS),
        arbLevels,
        (base, suffix, levels) => {
          const composed = `${base}_${suffix}`
          const before = coreResolution(composed)
          // The oracle recognizes every pair generated here; if it ever stopped, the pre-feature
          // behavior would have changed and that is the failure this clause exists to catch.
          expect(before).toBeDefined()

          expect(parseModelEffortSuffix(composed, levels)).toEqual({
            baseModel: before!.base,
            level: before!.effort,
            requestedLevel: suffix,
            degraded: false,
          })
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * Requirement 16.11's degradation half, stated as the invariant it is: a suffix level the model
   * does not publish still yields the right base and still yields a level drawn from the model's
   * own enum, flagged for the caller's notice. Rejection is never an outcome.
   */
  test("a suffix level absent from the enum degrades to a member of that enum rather than rejecting", () => {
    fc.assert(
      fc.property(arbBaseModel, arbLevels, fc.constantFrom(...CORE_SUFFIX_LEVELS), (base, levels, suffix) => {
        const composed = `${base}_${suffix}`
        fc.pre(coreResolution(composed) === undefined)
        fc.pre(!levels.includes(suffix))

        const parsed = parseModelEffortSuffix(composed, levels)
        expect(parsed).toBeDefined()
        expect(parsed!.baseModel).toBe(base)
        expect(parsed!.requestedLevel).toBe(suffix)
        expect(parsed!.degraded).toBe(true)
        expect(levels).toContain(parsed!.level)
      }),
      { numRuns: 200 },
    )
  })
})

describe("model effort suffix units", () => {
  test("claude-sonnet-5_high resolves to base claude-sonnet-5 and effort high", () => {
    expect(parseModelEffortSuffix("claude-sonnet-5_high", ["low", "medium", "high"])).toEqual({
      baseModel: "claude-sonnet-5",
      level: "high",
      requestedLevel: "high",
      degraded: false,
    })
  })

  test("gpt-5_high is unchanged, and still normalizes through core exactly as before", () => {
    expect(parseModelEffortSuffix("gpt-5_high", ["low", "high"])).toEqual({
      baseModel: "gpt-5",
      level: "high",
      requestedLevel: "high",
      degraded: false,
    })
    // The pre-feature behavior itself, asserted directly rather than only through the oracle.
    expect(normalizeReasoningBody({ model: "gpt-5_high" })).toEqual({
      model: "gpt-5",
      reasoning: { effort: "high" },
    })
    expect(normalizeReasoningBody({ model: "gpt-5_ultra" })).toEqual({
      model: "gpt-5",
      reasoning: { effort: "max" },
    })
  })

  test("an out-of-enum level degrades upward, and `none` degrades to the weakest level", () => {
    expect(parseModelEffortSuffix("claude-sonnet-5_xhigh", ["low", "medium", "high"])).toEqual({
      baseModel: "claude-sonnet-5",
      level: "high",
      requestedLevel: "xhigh",
      degraded: true,
    })
    expect(parseModelEffortSuffix("claude-sonnet-5_none", ["low", "medium", "high"])).toMatchObject({
      baseModel: "claude-sonnet-5",
      level: "low",
      degraded: true,
    })
  })

  test("an identifier with no effort suffix, or an underscore that is part of the name, is left alone", () => {
    expect(parseModelEffortSuffix("claude-sonnet-5", ["low", "high"])).toBeUndefined()
    expect(parseModelEffortSuffix("claude-sonnet-5_preview", ["low", "high"])).toBeUndefined()
    expect(parseModelEffortSuffix("gpt-5_bogus", ["low", "high"])).toBeUndefined()
    // A leading or trailing underscore is not a base/level pair.
    expect(parseModelEffortSuffix("_high", ["low", "high"])).toBeUndefined()
    expect(parseModelEffortSuffix("claude-sonnet-5_", ["low", "high"])).toBeUndefined()
  })
})
