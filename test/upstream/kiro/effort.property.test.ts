// Feature: native-api-mode — Kiro effort selection.
//
// Two properties live here, and they answer two different questions about `selectEffortLevel()`
// in `src/upstream/kiro/effort.ts`:
//
//  - **Property 15 (precedence half)** — *which* rung wins. Effort precedence is a total order:
//    absent when `thinking.mode` is `disabled`; otherwise the explicit client value; otherwise the
//    budget-derived level; otherwise the model default; otherwise absent.
//  - **Property 14** — *what may be sent*. Whatever rung wins, the level that reaches the wire is
//    a member of the model's enum, or nothing is sent at all.
//
// **Validates: Requirements 3.4, 16.1, 16.2, 16.3, 16.4**
//
// ## How the precedence half is asserted without reimplementing the function
//
// A property test whose oracle mirrors the implementation line for line proves only that the code
// equals itself. So precedence is asserted **relationally** instead — as facts about how the
// decision moves when an input moves:
//
//  - a higher rung's presence makes lower rungs irrelevant, checked by *deleting* the lower input
//    and asserting the decision does not change;
//  - a rung is consulted only when every rung above it declined;
//  - the whole ladder short-circuits on `disabled`.
//
// Those hold for any correct implementation of the order and fail for any implementation that
// reads the members in a different sequence, which is the claim worth pinning down.
//
// ## Why the budget rung is expressed through `budgetToLevel()` rather than through a literal
//
// The precedence tests phrase the rung as *"whatever `budgetToLevel()` answers"*, so they held
// vacuously while it was a declining stub and became live assertions the moment task 23.1 gave it
// a body — with no edit here. **Property 16** below now states what that body answers, and the
// **Property 15 notice half** states the notice symmetry, both with literal units.
//
// ## Extension points for the later tasks that share this file
//
//  - **21.2** adds `describe("Property 11: ...")` over `validateKiroEffort()`, reusing
//    `arbEffortMetadata` and `arbLevelName` below.
//  - **22.2** extends Property 14 with the substitution path and adds the strict half of
//    Property 5; the Property 14 block is already written over *every* decision kind, so the
//    substitution case slots in as an additional assertion rather than a rewrite.
//  - **23.2 / 23.3** added Property 16 (monotone budget mapping) and Property 15's notice half at
//    the foot of the file. The two stub guards that stood there — `budgetToLevel()` declines, and
//    `parseModelEffortSuffix()` throws — are gone: both subjects now exist (tasks 23.1 and 24.1),
//    so the guards were assertions that the code was still missing, not assertions about it.
//
// Nothing here touches `src/upstream/kiro/index.ts`: the handling branch is task 22's, and this
// file deliberately tests the pure decision so the two commits stay separable.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { REASONING_EFFORT_BUDGETS } from "../../../src/upstream/kiro/constants"
import type { EffortDecision, EffortIntent, EffortValidation } from "../../../src/upstream/kiro/effort"
import { budgetToLevel, effortIntentFromRequest, selectEffortLevel, validateKiroEffort } from "../../../src/upstream/kiro/effort"
import type { KiroModelEffortMetadata } from "../../../src/upstream/kiro/model-metadata"
import type { KiroEffortProbe } from "./effort-probe"
import { kiroEffortProbe } from "./effort-probe"

const SCHEMA_PATHS = ["output_config", "reasoning"] as const

/** The level vocabulary Kiro models actually publish, plus a couple of plausible neighbours. */
const REAL_LEVEL_NAMES = ["minimal", "low", "medium", "high", "xhigh", "max"] as const

/**
 * Level names: mostly the real vocabulary, sometimes arbitrary prose.
 *
 * The arbitrary arm matters for Property 14 — an enum is whatever the upstream schema said, and a
 * model that publishes `"Ludicrous "` must still be handled by containment rather than by a
 * hardcoded ladder.
 */
const arbLevelName = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...REAL_LEVEL_NAMES) },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 12 }) },
)

/** A non-empty, duplicate-free level enum. */
const arbLevels = fc.uniqueArray(arbLevelName, { minLength: 1, maxLength: 6 })

/**
 * A level enum for the provider-level tasks 22.2 adds, drawn from the real vocabulary only.
 *
 * The arbitrary-prose arm of {@link arbLevelName} is exactly right for the pure containment
 * property, and wrong here: these runs publish the enum through a fake catalog response and then
 * read the substituted level back out of the built payload, so a level name is a JSON object key's
 * neighbour and a generated `"__proto__"` or `""` would be testing the harness rather than the
 * branch. Containment over odd names is already covered above, at the layer that owns it.
 */
const arbSchemaLevels: fc.Arbitrary<string[]> = fc
  .uniqueArray(fc.constantFrom(...REAL_LEVEL_NAMES), { minLength: 1, maxLength: 6 })
  .map((levels) => [...levels])

/**
 * A well-formed effort descriptor: a non-empty enum, and a default that is either absent or a
 * member of that enum — the two shapes `parseEffortMetadata()` can actually produce.
 */
const arbEffortMetadata: fc.Arbitrary<KiroModelEffortMetadata> = fc.record({
  schemaPath: fc.constantFrom(...SCHEMA_PATHS),
  levels: arbLevels,
}).chain(({ schemaPath, levels }) =>
  fc.option(fc.constantFrom(...levels), { nil: undefined }).map((defaultLevel) => ({
    schemaPath,
    levels,
    ...(defaultLevel !== undefined ? { defaultLevel } : {}),
  })),
)

/** A descriptor, or a model that declares no effort enum at all. */
const arbMaybeEffortMetadata = fc.option(arbEffortMetadata, { nil: undefined })

const arbThinkingMode = fc.constantFrom("enabled" as const, "disabled" as const, "adaptive" as const)

/** Budgets spanning below, between and above every `REASONING_EFFORT_BUDGETS` entry. */
const arbBudgetTokens = fc.oneof(
  fc.integer({ min: 1, max: 40_000 }),
  fc.constantFrom(1, 4000, 6000, 8000, 16_000, 32_000, 1_000_000),
)

const arbThinking = fc.option(
  fc.record(
    { mode: arbThinkingMode, budgetTokens: arbBudgetTokens },
    { requiredKeys: ["mode"] },
  ),
  { nil: undefined },
)

/**
 * An intent whose explicit member is drawn from the model's own enum when there is one.
 *
 * Sampling the requested level from `levels` is the "smart generator" the precedence property
 * needs: an out-of-enum value never reaches the `selected` branch, so a uniformly random string
 * would spend almost every run on the containment case and almost none on the ordering case that
 * Property 15 is about. The out-of-enum and unsupported cases are generated deliberately in the
 * Property 14 block instead.
 */
function arbIntentFor(metadata: KiroModelEffortMetadata | undefined): fc.Arbitrary<EffortIntent> {
  const arbRequested = metadata
    ? fc.oneof(
        { weight: 4, arbitrary: fc.constantFrom(...metadata.levels) },
        { weight: 1, arbitrary: fc.constant("") },
      )
    : fc.string({ maxLength: 8 })
  return fc.record(
    { requested: fc.option(arbRequested, { nil: undefined }), thinking: arbThinking },
    { requiredKeys: [] },
  )
}

/** A descriptor paired with an intent expressed in that descriptor's own vocabulary. */
const arbCase = arbMaybeEffortMetadata.chain((metadata) =>
  arbIntentFor(metadata).map((intent) => ({ metadata, intent })),
)

/** The level a decision puts on the wire, or `undefined` when the decision sends nothing. */
function sentLevel(decision: EffortDecision): string | undefined {
  return decision.kind === "selected" ? decision.effort.level : undefined
}

/** `intent` with its token budget removed; the thinking member itself survives. */
function withoutBudget(intent: EffortIntent): EffortIntent {
  if (!intent.thinking) return intent
  const { budgetTokens, ...thinking } = intent.thinking
  void budgetTokens
  return { ...intent, thinking }
}

/** `metadata` with its default level removed; the enum untouched. */
function withoutDefault(metadata: KiroModelEffortMetadata | undefined): KiroModelEffortMetadata | undefined {
  if (!metadata) return metadata
  const { defaultLevel, ...rest } = metadata
  void defaultLevel
  return rest
}

const metadataOf = (levels: string[], defaultLevel?: string): KiroModelEffortMetadata => ({
  schemaPath: "output_config",
  levels,
  ...(defaultLevel !== undefined ? { defaultLevel } : {}),
})

describe("Feature: native-api-mode, Property 15 (precedence half): Effort precedence is a total order with notices only on substitution", () => {
  test("Feature: native-api-mode, Property 15 (precedence half): thinking.mode 'disabled' short-circuits every rung", () => {
    fc.assert(fc.property(arbCase, ({ metadata, intent }) => {
      const disabled: EffortIntent = { ...intent, thinking: { ...intent.thinking, mode: "disabled" } }
      const decision = selectEffortLevel(metadata, disabled)
      expect(decision).toEqual({ kind: "absent", reason: "thinking_disabled" })
      expect(sentLevel(decision)).toBeUndefined()
    }), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 15 (precedence half): a stated in-enum value wins, and lower rungs cannot change it", () => {
    fc.assert(fc.property(arbEffortMetadata, arbThinking, fc.integer({ min: 0, max: 5 }), (metadata, thinking, index) => {
      const requested = metadata.levels[index % metadata.levels.length]!
      const stated: EffortIntent = { requested, ...(thinking ? { thinking: { ...thinking, mode: thinking.mode === "disabled" ? "enabled" : thinking.mode } } : {}) }

      const decision = selectEffortLevel(metadata, stated)
      expect(decision).toEqual({ kind: "selected", source: "explicit", effort: { schemaPath: metadata.schemaPath, level: requested } })

      // Requirement 16.3 as an independence claim: removing the budget, or the model default, or
      // both, leaves an explicit decision untouched. A reader that consulted them first would
      // change its answer here.
      expect(selectEffortLevel(metadata, withoutBudget(stated))).toEqual(decision)
      expect(selectEffortLevel(withoutDefault(metadata), stated)).toEqual(decision)
      expect(selectEffortLevel(withoutDefault(metadata), withoutBudget(stated))).toEqual(decision)
    }), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 15 (precedence half): with no stated value the budget rung is consulted before the model default", () => {
    fc.assert(fc.property(arbEffortMetadata, arbThinking, (metadata, thinking) => {
      const enabled = thinking && thinking.mode !== "disabled" ? { thinking } : {}
      const intent: EffortIntent = { ...enabled }
      const decision = selectEffortLevel(metadata, intent)
      const fromBudget = budgetToLevel(intent.thinking?.budgetTokens, metadata.levels)

      if (fromBudget !== undefined) {
        // Live from task 23.1 onward; vacuous while the rung declines.
        expect(decision).toEqual({ kind: "selected", source: "budget", effort: { schemaPath: metadata.schemaPath, level: fromBudget } })
        return
      }

      // The rung declined, so the ladder must have fallen through to the model default —
      // Requirements 16.1 and 16.2, as the two halves of one branch.
      if (metadata.defaultLevel !== undefined) {
        expect(decision).toEqual({ kind: "selected", source: "model_default", effort: { schemaPath: metadata.schemaPath, level: metadata.defaultLevel } })
      } else {
        expect(decision).toEqual({ kind: "absent", reason: "no_model_default" })
      }
    }), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 15 (precedence half): the model default is the last rung, and removing it yields absence", () => {
    fc.assert(fc.property(arbEffortMetadata, (metadata) => {
      const bare = withoutDefault(metadata)!
      expect(selectEffortLevel(bare, {})).toEqual({ kind: "absent", reason: "no_model_default" })
      expect(selectEffortLevel(bare, { thinking: { mode: "enabled" } })).toEqual({ kind: "absent", reason: "no_model_default" })
    }), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 15 (precedence half): a model with no effort enum sends nothing and classifies a stated value", () => {
    fc.assert(fc.property(arbThinking, fc.string({ maxLength: 8 }), (thinking, requested) => {
      const enabled = thinking && thinking.mode !== "disabled" ? { thinking } : {}
      expect(selectEffortLevel(undefined, { ...enabled })).toEqual({ kind: "absent", reason: "no_model_default" })

      const decision = selectEffortLevel(undefined, { ...enabled, requested })
      expect(decision).toEqual(requested.length ? { kind: "unsupported", requested } : { kind: "absent", reason: "no_model_default" })
      expect(sentLevel(decision)).toBeUndefined()
    }), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 15 (precedence half): the decision is a pure function of its two arguments", () => {
    fc.assert(fc.property(arbCase, ({ metadata, intent }) => {
      expect(selectEffortLevel(metadata, intent)).toEqual(selectEffortLevel(metadata, intent))
    }), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 15 (precedence half): the units — default applied, default absent, client value preferred, disabled silent", () => {
    // Requirement 16.1
    expect(selectEffortLevel(metadataOf(["low", "medium", "high"], "medium"), {}))
      .toEqual({ kind: "selected", source: "model_default", effort: { schemaPath: "output_config", level: "medium" } })
    // Requirement 16.2
    expect(selectEffortLevel(metadataOf(["low", "medium", "high"]), {}))
      .toEqual({ kind: "absent", reason: "no_model_default" })
    // Requirement 16.3
    expect(selectEffortLevel(metadataOf(["low", "medium", "high"], "medium"), { requested: "high" }))
      .toEqual({ kind: "selected", source: "explicit", effort: { schemaPath: "output_config", level: "high" } })
    // Requirement 16.9
    expect(selectEffortLevel(metadataOf(["low", "medium", "high"], "medium"), { requested: "high", thinking: { mode: "disabled", budgetTokens: 16_000 } }))
      .toEqual({ kind: "absent", reason: "thinking_disabled" })
  })

  test("Feature: native-api-mode, Property 15 (precedence half): a canonical request narrows to the intent it carries", () => {
    expect(effortIntentFromRequest({ reasoningEffort: "high" })).toEqual({ requested: "high" })
    expect(effortIntentFromRequest({ thinking: { mode: "enabled", budgetTokens: 8000 } })).toEqual({ thinking: { mode: "enabled", budgetTokens: 8000 } })
    expect(effortIntentFromRequest({})).toEqual({})
  })
})

describe("Feature: native-api-mode, Property 14: Effort sent upstream is always in the model enum or absent", () => {
  test("Feature: native-api-mode, Property 14: every selected level is a member of the model's own enum", () => {
    fc.assert(fc.property(arbMaybeEffortMetadata, fc.option(arbLevelName, { nil: undefined }), arbThinking, (metadata, requested, thinking) => {
      const intent: EffortIntent = {
        ...(requested !== undefined ? { requested } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
      }
      const decision = selectEffortLevel(metadata, intent)
      const level = sentLevel(decision)

      // Requirement 3.4: a value on the wire is drawn from the per-model enum, because Kiro
      // validates that enum server-side. Anything else is absent — never a guess.
      if (level === undefined) {
        expect(["absent", "out_of_enum", "unsupported"]).toContain(decision.kind)
        return
      }
      expect(metadata).toBeDefined()
      expect(metadata!.levels).toContain(level)
      expect(decision.kind === "selected" && decision.effort.schemaPath).toBe(metadata!.schemaPath)
    }), { numRuns: 300 })
  })

  test("Feature: native-api-mode, Property 14: a level outside the enum is classified, never sent", () => {
    fc.assert(fc.property(arbEffortMetadata, fc.string({ minLength: 1, maxLength: 12 }), (metadata, requested) => {
      fc.pre(!metadata.levels.includes(requested))
      const decision = selectEffortLevel(metadata, { requested })
      expect(decision).toEqual({ kind: "out_of_enum", requested, levels: metadata.levels, schemaPath: metadata.schemaPath })
      expect(sentLevel(decision)).toBeUndefined()
    }), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 14: a malformed descriptor default is not sent either", () => {
    fc.assert(fc.property(arbLevels, fc.string({ minLength: 1, maxLength: 12 }), (levels, defaultLevel) => {
      fc.pre(!levels.includes(defaultLevel))
      const decision = selectEffortLevel({ schemaPath: "reasoning", levels, defaultLevel }, {})
      expect(decision).toEqual({ kind: "absent", reason: "no_model_default" })
    }), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 14: the out-of-enum decision carries what a classifier needs", () => {
    const decision = selectEffortLevel(metadataOf(["low", "medium", "high", "max"], "medium"), { requested: "ultra" })
    expect(decision).toEqual({ kind: "out_of_enum", requested: "ultra", levels: ["low", "medium", "high", "max"], schemaPath: "output_config" })
  })

  // Task 22.2 — the substitution half. Everything above is about the pure decision; the two tests
  // below are about the wire, because task 22.1 opened a path the pure module cannot see: an
  // out-of-enum request now *sends* something. Property 14's claim only holds end to end if what
  // that path sends is still a member of the model's own enum, so the assertion is made against
  // the payload the provider handed its client rather than against a decision object.
  test("Feature: native-api-mode, Property 14: a substituted level reaches the payload inside the model's enum, never outside it", async () => {
    await fc.assert(fc.asyncProperty(arbSchemaLevels, arbLevelName, fc.constantFrom(...SCHEMA_PATHS), async (levels, requested, schemaPath) => {
      fc.pre(!levels.includes(requested))
      const probe = kiroEffortProbe({ levels, schemaPath })

      const result = await probe.proxy(requested)

      // Requirement 16.4 — the request is answered rather than refused.
      expect(result.type).toBe("canonical_response")
      // Requirement 3.4 — whatever went on the wire is drawn from the per-model enum, which is
      // the enum Kiro validates server-side. This is the assertion that would fail if degrading
      // forwarded the client's own value, or invented a level.
      const sent = probe.sentEffort()
      expect(sent).toBeDefined()
      expect(levels).toContain(sent!)
    }), { numRuns: 40 })
  })

  test("Feature: native-api-mode, Property 14: the notice names the requested value and the substituted level", async () => {
    await fc.assert(fc.asyncProperty(arbSchemaLevels, arbLevelName, async (levels, requested) => {
      fc.pre(!levels.includes(requested))
      const probe = kiroEffortProbe({ levels })

      const result = await probe.proxy(requested)
      const notices = result.type === "canonical_response" ? result.featureNotices ?? [] : []
      const sent = probe.sentEffort()

      // Requirement 16.4's second half: a substitution is reported, and the report carries both
      // values — the one the client asked for and the one it got. Either alone leaves the client
      // unable to tell what happened.
      const notice = notices.find((entry) => entry.feature === "thinkingBudget")
      expect(notice).toBeDefined()
      expect(notice!.detail).toContain(requested)
      expect(notice!.detail).toContain(sent!)
    }), { numRuns: 40 })
  })
})

// Task 22.2 — Property 5's strict half, for the one input task 22 added to its domain.
//
// `test/core/strict.property.test.ts` owns the general escalation claim over `resolveFeature()`
// and a Kiro unit pair on `toolChoiceForced` / `strictToolSchema`. This block is narrower and
// belongs here instead: it is about the effort branch specifically, and it asserts the escalation
// through `Kiro_Upstream_Provider.proxy()` rather than through the resolver, which is what makes
// it a claim about task 22.1's choke point rather than about core.
describe("Feature: native-api-mode, Property 5 (strict half): Strict mode escalates degrade and nothing else", () => {
  test("Feature: native-api-mode, Property 5 (strict half): an out-of-enum effort returns 400 with the flag set, and 200 without it", async () => {
    await fc.assert(fc.asyncProperty(arbSchemaLevels, arbLevelName, async (levels, requested) => {
      fc.pre(!levels.includes(requested))

      const lenient = kiroEffortProbe({ levels })
      const lenientResult = await lenient.proxy(requested)
      const strict = kiroEffortProbe({ levels, strict: true })
      const strictResult = await strict.proxy(requested)

      // Requirement 16.5 — the same input, and the only difference is the escalation.
      expect(lenientResult.type).toBe("canonical_response")
      expect(strictResult).toMatchObject({ type: "canonical_error", status: 400 })
      // The escalation happens before any upstream work, so a refused request costs nothing —
      // and the lenient run is what proves the 400 is the flag's doing rather than a broken input.
      expect(strict.upstreamCalls()).toBe(0)
      expect(lenient.upstreamCalls()).toBe(1)
    }), { numRuns: 40 })
  })

  test("Feature: native-api-mode, Property 5 (strict half): strict escalates nothing that was not already degrading", async () => {
    await fc.assert(fc.asyncProperty(arbSchemaLevels, fc.integer({ min: 0, max: 5 }), async (levels, index) => {
      const requested = levels[index % levels.length]!
      const strict = kiroEffortProbe({ levels, strict: true })

      const result = await strict.proxy(requested)

      // Requirement 11.3's shape, on this branch: an in-enum value was never a degradation, so
      // strict mode leaves it alone — same 200, same level, and no notice to escalate.
      expect(result.type).toBe("canonical_response")
      expect(strict.sentEffort()).toBe(requested)
      expect(result.type === "canonical_response" ? result.featureNotices ?? [] : []).toEqual([])
    }), { numRuns: 40 })
  })
})

// Task 21.2 — the classification half. `validateKiroEffort()` answers a narrower question than
// `selectEffortLevel()`: not "what should be sent" but "is what the client asked for acceptable,
// and if not, which kind of not". The property below is about the *partition*: every input lands
// in exactly one class, and the class is readable as a literal.
describe("Feature: native-api-mode, Property 11: Effort validation classifies every input exactly once", () => {
  /** The class an input belongs to, derived from the inputs rather than from the result. */
  function expectedCode(metadata: KiroModelEffortMetadata | undefined | null, requested: string): string {
    if (metadata === null) return "metadata_unavailable"
    if (!metadata) return "effort_unsupported"
    return metadata.levels.includes(requested) ? "ok" : "effort_not_in_enum"
  }

  /** The single label a result carries, so "exactly once" is checkable as an equality. */
  function actualCode(result: EffortValidation): string {
    return result.ok ? "ok" : result.code
  }

  test("Feature: native-api-mode, Property 11: every descriptor and level lands in exactly one class", () => {
    fc.assert(fc.property(
      fc.oneof(arbEffortMetadata, fc.constant(undefined), fc.constant(null)),
      arbLevelName,
      (metadata, requested) => {
        const result = validateKiroEffort(metadata, requested)
        expect(actualCode(result)).toBe(expectedCode(metadata, requested))

        // Exactly once, structurally: `ok` is a boolean discriminant, so a result cannot be both
        // valid and carry a rejection code, and a rejection always carries one.
        if (result.ok) {
          expect(Object.keys(result)).toEqual(["ok"])
          return
        }
        expect(typeof result.code).toBe("string")

        // Requirement 6.3 / 6.6 — the code is compared as a literal. No message field exists to
        // match on, which is the point: a caller physically cannot branch on prose.
        expect(result).not.toHaveProperty("message")
        expect(result).not.toHaveProperty("error")
      },
    ), { numRuns: 300 })
  })

  test("Feature: native-api-mode, Property 11: an in-enum level is valid whatever the enum looks like", () => {
    fc.assert(fc.property(arbEffortMetadata, fc.integer({ min: 0, max: 5 }), (metadata, index) => {
      const requested = metadata.levels[index % metadata.levels.length]!
      // Requirement 6.2 — membership is the whole test for validity; nothing else may reject.
      expect(validateKiroEffort(metadata, requested)).toEqual({ ok: true })
    }), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 11: an out-of-enum level rejects with a substitute drawn from the model's own enum", () => {
    fc.assert(fc.property(arbEffortMetadata, arbLevelName, (metadata, requested) => {
      fc.pre(!metadata.levels.includes(requested))
      const result = validateKiroEffort(metadata, requested)
      expect(result.ok).toBe(false)
      if (result.ok || result.code !== "effort_not_in_enum") throw new Error(`expected effort_not_in_enum, got ${actualCode(result)}`)

      expect(result.requested).toBe(requested)
      expect(result.levels).toEqual(metadata.levels)
      // Requirement 16.4's precondition: `nearest` is never invented. Task 22.1 sends it, so if
      // this could fall outside the enum, degrading would put an invalid value on the wire.
      expect(metadata.levels).toContain(result.nearest)
    }), { numRuns: 300 })
  })

  test("Feature: native-api-mode, Property 11: a model with no effort enum rejects distinctly, with nothing to substitute", () => {
    fc.assert(fc.property(arbLevelName, (requested) => {
      // Requirement 6.3 — distinct from `effort_not_in_enum`, because there is no enum to be
      // outside of and so no substitution for a caller to make.
      expect(validateKiroEffort(undefined, requested)).toEqual({ ok: false, code: "effort_unsupported", requested })
    }), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 11: unloaded metadata is infrastructure — the existing 503, never an effort rejection", () => {
    fc.assert(fc.property(arbLevelName, (requested) => {
      // Requirement 6.4. The status travels with the result so the caller keeps the response it
      // already sends today rather than re-deriving one from the code.
      expect(validateKiroEffort(null, requested)).toEqual({ ok: false, code: "metadata_unavailable", status: 503 })
    }), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 11: a stated-nothing request needs no metadata and is valid", () => {
    fc.assert(fc.property(fc.oneof(arbEffortMetadata, fc.constant(undefined), fc.constant(null)), fc.constantFrom(undefined, ""), (metadata, requested) => {
      // The `if (!requested) return {}` fast path in `resolveRequestedEffort()`, preserved: an
      // absent effort must not become a 503 just because metadata happens not to be loaded.
      expect(validateKiroEffort(metadata, requested)).toEqual({ ok: true })
    }), { numRuns: 100 })
  })

  test("Feature: native-api-mode, Property 11: classification is a pure function of its two arguments", () => {
    fc.assert(fc.property(fc.oneof(arbEffortMetadata, fc.constant(undefined), fc.constant(null)), arbLevelName, (metadata, requested) => {
      expect(validateKiroEffort(metadata, requested)).toEqual(validateKiroEffort(metadata, requested))
    }), { numRuns: 100 })
  })

  test("Feature: native-api-mode, Property 11: the three units — in enum, out of enum, no enum", () => {
    // Requirement 6.6, one assertion per class, each read as a literal code.
    expect(validateKiroEffort(metadataOf(["low", "medium", "high", "max"], "medium"), "high")).toEqual({ ok: true })
    expect(validateKiroEffort(metadataOf(["low", "medium", "high", "max"], "medium"), "ultra")).toEqual({
      ok: false,
      code: "effort_not_in_enum",
      requested: "ultra",
      levels: ["low", "medium", "high", "max"],
      // "ultra" carries no rank on the known ladder, so it rounds up to the model's strongest
      // level — the substitution task 22.3's unit expects.
      nearest: "max",
    })
    expect(validateKiroEffort(undefined, "high")).toEqual({ ok: false, code: "effort_unsupported", requested: "high" })
  })

  test("Feature: native-api-mode, Property 11: the nearest level rounds toward more reasoning, not less", () => {
    // A ranked request picks the closest rank; a tie breaks upward.
    expect(validateKiroEffort(metadataOf(["low", "high"]), "medium")).toMatchObject({ nearest: "high" })
    expect(validateKiroEffort(metadataOf(["minimal", "low"]), "max")).toMatchObject({ nearest: "low" })
    // A vocabulary the ladder has never seen falls back on declaration order, which Kiro's schema
    // publishes ascending.
    expect(validateKiroEffort(metadataOf(["gentle", "fierce"]), "high")).toMatchObject({ nearest: "fierce" })
  })
})

// Task 23.2 — the budget rung's own property. Property 15 above says *when* the rung is consulted;
// this block says what it answers when it is. Both claims are needed: an order that consults a
// mapping is only as good as the mapping, and a client that raises its budget and gets less
// reasoning has been misread however correct the precedence was.
describe("Feature: native-api-mode, Property 16: Budget-to-level mapping is monotone and in-enum", () => {
  /**
   * The level names `REASONING_EFFORT_BUDGETS` prices.
   *
   * Read from the constant rather than written out, so a level added to or repriced in
   * `src/upstream/kiro/constants.ts` changes what this block generates instead of quietly falling
   * outside it.
   */
  const BUDGETED_LEVEL_NAMES = Object.keys(REASONING_EFFORT_BUDGETS)

  /**
   * An enum containing at least one priced level, plus up to two unpriced ones.
   *
   * The unpriced arm is the part worth generating: `minimal`, `max` and any prose a schema
   * publishes carry no token figure, so they are not candidates, and their presence must not
   * change which priced level wins. An enum of only priced names would never exercise that.
   */
  const arbLevelsWithBudget: fc.Arbitrary<string[]> = fc
    .tuple(
      fc.uniqueArray(fc.constantFrom(...BUDGETED_LEVEL_NAMES), { minLength: 1, maxLength: 4 }),
      fc.uniqueArray(arbLevelName, { maxLength: 2 }),
    )
    .map(([priced, extra]) => [...new Set([...priced, ...extra])])

  /**
   * The token figure a level is priced at, or `undefined` when the constant does not price it.
   *
   * Guarded with `Object.hasOwn` plus `typeof … === "number"` rather than read as a bare index, for
   * the same hazard the `arbSchemaLevels` comment above records: the prose arm of
   * {@link arbLevelName} can emit a prototype key, and `REASONING_EFFORT_BUDGETS["valueOf"]` walks
   * the prototype chain and answers with a **function**. A bare `!== undefined` test would admit
   * that name as a priced candidate and every distance derived from it would be `NaN` — an oracle
   * failure, not a production one.
   *
   * The guard is deliberately the same one production uses: `budgetToLevel()` in
   * `src/upstream/kiro/effort.ts` filters candidates with `typeof candidate.budget === "number"`, so
   * a prototype key is already excluded there. Matching it here is what keeps this block's notion of
   * "priced" identical to the implementation's. Narrowing the generator instead would be the wrong
   * fix: a hostile level name is worth generating precisely because production handles it.
   */
  const priceOf = (level: string): number | undefined => {
    if (!Object.hasOwn(REASONING_EFFORT_BUDGETS, level)) return undefined
    const budget = REASONING_EFFORT_BUDGETS[level]
    return typeof budget === "number" ? budget : undefined
  }

  /** Whether a level is a candidate at all — the predicate every filter below shares. */
  const isPriced = (level: string) => priceOf(level) !== undefined

  /** The token figure a priced level carries, for the ordering the property is stated over. */
  const budgetOf = (level: string) => priceOf(level)!

  test("Feature: native-api-mode, Property 16: a budget that does not fall selects a level that does not fall", () => {
    fc.assert(fc.property(arbLevelsWithBudget, arbBudgetTokens, arbBudgetTokens, (levels, first, second) => {
      const [lower, higher] = first <= second ? [first, second] : [second, first]

      const fromLower = budgetToLevel(lower, levels)
      const fromHigher = budgetToLevel(higher, levels)

      // Requirement 16.7 — monotone under the budget ordering. Equality is allowed and expected:
      // the mapping is onto a handful of rungs, so most budget pairs land on the same one. What is
      // forbidden is inversion, which is the failure a client would actually feel.
      expect(fromLower).toBeDefined()
      expect(fromHigher).toBeDefined()
      expect(budgetOf(fromLower!)).toBeLessThanOrEqual(budgetOf(fromHigher!))

      // And in-enum, which is Property 14's post-condition holding through this rung: a level
      // reached by mapping a budget is drawn from the model's own vocabulary like any other.
      expect(levels).toContain(fromLower!)
      expect(levels).toContain(fromHigher!)
    }), { numRuns: 300 })
  })

  test("Feature: native-api-mode, Property 16: the selected level is the nearest priced one, ties upward", () => {
    fc.assert(fc.property(arbLevelsWithBudget, arbBudgetTokens, (levels, budgetTokens) => {
      const selectedLevel = budgetToLevel(budgetTokens, levels)
      expect(selectedLevel).toBeDefined()

      // "Nearest" checked against every candidate rather than recomputed: no other priced level in
      // this enum is strictly closer to the budget than the one chosen. A tie is settled upward, so
      // an equally-distant candidate is only acceptable when it is the weaker of the two.
      const distance = (level: string) => Math.abs(budgetOf(level) - budgetTokens)
      for (const candidate of levels.filter(isPriced)) {
        expect(distance(candidate)).toBeGreaterThanOrEqual(distance(selectedLevel!))
        if (distance(candidate) === distance(selectedLevel!)) expect(budgetOf(candidate)).toBeLessThanOrEqual(budgetOf(selectedLevel!))
      }
    }), { numRuns: 300 })
  })

  test("Feature: native-api-mode, Property 16: neither extreme throws — the smallest budget lands on the weakest priced level, the largest on the strongest", () => {
    fc.assert(fc.property(arbLevelsWithBudget, (levels) => {
      const priced = levels.filter(isPriced)
      const weakest = priced.reduce((best, level) => (budgetOf(level) < budgetOf(best) ? level : best))
      const strongest = priced.reduce((best, level) => (budgetOf(level) > budgetOf(best) ? level : best))

      // A budget under every entry is a real request, not an error: `budget_tokens: 1` asks for as
      // little reasoning as can be bought, and the weakest published level is that answer.
      expect(budgetToLevel(1, levels)).toBe(weakest)
      expect(budgetToLevel(10_000_000, levels)).toBe(strongest)
    }), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 16: an unpriced enum declines rather than guessing a level", () => {
    fc.assert(fc.property(fc.uniqueArray(arbLevelName, { minLength: 1, maxLength: 4 }), arbBudgetTokens, (levels, budgetTokens) => {
      fc.pre(!levels.some(isPriced))
      // No level in this enum carries a token figure, so no level is nearest to anything. Declining
      // sends the ladder on to the model default; inventing a figure for `minimal` or for a name a
      // schema made up would be this module deciding what Kiro's own constants do not say.
      expect(budgetToLevel(budgetTokens, levels)).toBeUndefined()
    }), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 16: a budget that is not a usable number is not a budget", () => {
    fc.assert(fc.property(fc.constantFrom(undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY), (budgetTokens) => {
      // `undefined` is the ordinary "no budget sent". The rest cannot be mapped without reading one
      // of them as "the smallest budget", which would put a level on the wire the client never
      // asked for.
      expect(budgetToLevel(budgetTokens, ["low", "medium", "high", "xhigh"])).toBeUndefined()
    }), { numRuns: 100 })
  })

  test("Feature: native-api-mode, Property 16: the units — 16000 is high, 1 is the weakest level, and the midpoint rounds up", () => {
    const levels = ["low", "medium", "high", "xhigh"]
    expect(budgetToLevel(16_000, levels)).toBe("high")
    expect(budgetToLevel(1, levels)).toBe("low")
    // Exactly between low (4000) and medium (8000). A budget is what the client is willing to
    // spend, so spending it is closer to the request than withholding it.
    expect(budgetToLevel(6000, levels)).toBe("medium")
    expect(budgetToLevel(32_000, levels)).toBe("xhigh")
    // An enum that publishes only part of the ladder maps within what it publishes.
    expect(budgetToLevel(16_000, ["low", "medium"])).toBe("medium")
  })

  test("Feature: native-api-mode, Property 16: a level named after an Object.prototype key is not priced", () => {
    // The counterexample the property above found once, pinned as a unit so it is checked on every
    // run rather than when a seed happens to generate it. A schema is free to publish a level called
    // `valueOf`, and `REASONING_EFFORT_BUDGETS["valueOf"]` is `Object.prototype.valueOf` — a
    // function, not a token figure. `budgetToLevel()` filters on `typeof … === "number"`, so the
    // name is simply unpriced: it is never a candidate, and never the answer.
    expect(budgetToLevel(1, ["low", "valueOf"])).toBe("low")
    expect(budgetToLevel(10_000_000, ["low", "valueOf"])).toBe("low")
    expect(budgetToLevel(8000, ["valueOf", "toString", "constructor", "__proto__"])).toBeUndefined()
    // And the oracle this block reasons with agrees with that filter, which is the whole point.
    expect(isPriced("valueOf")).toBe(false)
    expect(isPriced("__proto__")).toBe(false)
    expect(isPriced("low")).toBe(true)
  })
})

// Task 23.3 — Property 15's remaining half. Everything in the Property 15 block above is about the
// pure decision, and the claim completed here cannot be made there: "a notice is emitted if and
// only if the emitted value differs from what the client stated" is a claim about notices, and
// notices are emitted in `src/upstream/kiro/index.ts`. So these run through the provider.
describe("Feature: native-api-mode, Property 15 (notice half): Effort precedence is a total order with notices only on substitution", () => {
  /** The `thinkingBudget` notices on a result — the feature every effort substitution reports under. */
  function budgetNotices(result: Awaited<ReturnType<KiroEffortProbe["proxy"]>>) {
    const notices = result.type === "canonical_response" ? result.featureNotices ?? [] : []
    return notices.filter((notice) => notice.feature === "thinkingBudget")
  }

  /** Levels drawn from the priced vocabulary, so a budget always has somewhere to land. */
  const arbPricedLevels: fc.Arbitrary<string[]> = fc
    .uniqueArray(fc.constantFrom(...Object.keys(REASONING_EFFORT_BUDGETS)), { minLength: 1, maxLength: 4 })
    .map((levels) => [...levels])

  test("Feature: native-api-mode, Property 15 (notice half): an explicit in-enum value with a budget beside it emits zero thinkingBudget notices", async () => {
    await fc.assert(fc.asyncProperty(arbPricedLevels, fc.integer({ min: 0, max: 5 }), arbBudgetTokens, async (levels, index, budgetTokens) => {
      const requested = levels[index % levels.length]!
      const probe = kiroEffortProbe({ levels })

      const result = await probe.proxy(requested, { mode: "enabled", budgetTokens })

      // Requirement 16.8 — the stated value is what went upstream, so nothing was substituted, so
      // there is nothing to report. A notice here would tell the client its request had been
      // changed when it had not, which is worse than no notice at all.
      expect(probe.sentEffort()).toBe(requested)
      expect(budgetNotices(result)).toEqual([])
    }), { numRuns: 40 })
  })

  test("Feature: native-api-mode, Property 15 (notice half): a budget with no stated value is mapped, and the notice names the mapping", async () => {
    await fc.assert(fc.asyncProperty(arbPricedLevels, arbBudgetTokens, async (levels, budgetTokens) => {
      const probe = kiroEffortProbe({ levels })

      const result = await probe.proxy(undefined, { mode: "enabled", budgetTokens })
      const sent = probe.sentEffort()

      // Requirement 16.7 — the budget reached the model as a level, and the level is the one the
      // pure mapping chose, so the wire agrees with `budgetToLevel()` rather than with a second
      // copy of the rule living in the provider.
      expect(sent).toBe(budgetToLevel(budgetTokens, levels))
      expect(levels).toContain(sent!)

      // Exactly one notice, and it carries both sides: the figure the client sent and the level it
      // became. Either alone leaves the client unable to tell what its budget bought.
      const [notice, ...rest] = budgetNotices(result)
      expect(rest).toEqual([])
      expect(notice).toBeDefined()
      expect(notice!.detail).toContain(`${budgetTokens} → ${sent}`)
    }), { numRuns: 40 })
  })

  test("Feature: native-api-mode, Property 15 (notice half): a disabled thinking member sends no effort and reports no budget", async () => {
    await fc.assert(fc.asyncProperty(arbPricedLevels, arbBudgetTokens, async (levels, budgetTokens) => {
      const probe = kiroEffortProbe({ levels })

      const result = await probe.proxy(undefined, { mode: "disabled", budgetTokens })

      // Requirement 16.9 — `disabled` is a request for no reasoning, so the budget beside it is not
      // a level waiting to be found. Nothing was emitted, so nothing differs from what the client
      // stated, so the iff gives zero notices.
      expect(probe.sentEffort()).toBeUndefined()
      expect(budgetNotices(result)).toEqual([])
      expect(result.type).toBe("canonical_response")
    }), { numRuns: 40 })
  })

  test("Feature: native-api-mode, Property 15 (notice half): a canonical request never carries a budget in reasoningEffort", () => {
    fc.assert(fc.property(arbBudgetTokens, arbThinkingMode, arbEffortMetadata, (budgetTokens, mode, metadata) => {
      const intent = effortIntentFromRequest({ thinking: { mode, budgetTokens } })

      // Requirement 12.7's boundary, read from the narrowing: a budget is a `thinking` member and
      // stays one. It never arrives as a stated effort level, so the explicit rung cannot be
      // triggered by it and `reasoningEffort` never holds a token figure.
      expect(intent.requested).toBeUndefined()
      expect(intent.thinking).toEqual({ mode, budgetTokens })

      // And what the decision emits is a level name from the enum, never the figure restated.
      const level = sentLevel(selectEffortLevel(metadata, intent))
      if (level !== undefined) {
        expect(metadata.levels).toContain(level)
        expect(level).not.toBe(String(budgetTokens))
      }
    }), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 15 (notice half): the units — 16000 becomes high with a '16000 → high' notice", async () => {
    const probe = kiroEffortProbe({ levels: ["low", "medium", "high", "xhigh"] })

    const result = await probe.proxy(undefined, { mode: "enabled", budgetTokens: 16_000 })

    expect(probe.sentEffort()).toBe("high")
    const [notice, ...rest] = budgetNotices(result)
    expect(rest).toEqual([])
    expect(notice).toMatchObject({ feature: "thinkingBudget", policy: "degrade" })
    expect(notice!.detail).toContain("16000 → high")
  })

  test("Feature: native-api-mode, Property 15 (notice half): the units — a budget of 1 lands on the weakest level rather than failing", async () => {
    const probe = kiroEffortProbe({ levels: ["low", "medium", "high", "xhigh"] })

    const result = await probe.proxy(undefined, { mode: "enabled", budgetTokens: 1 })

    expect(result.type).toBe("canonical_response")
    expect(probe.sentEffort()).toBe("low")
    expect(budgetNotices(result)[0]!.detail).toContain("1 → low")
  })

  test("Feature: native-api-mode, Property 15 (notice half): the units — an explicit level beside a budget is sent verbatim and silently", async () => {
    const probe = kiroEffortProbe({ levels: ["low", "medium", "high", "xhigh"] })

    const result = await probe.proxy("low", { mode: "enabled", budgetTokens: 32_000 })

    // Requirement 16.8 — the budget would have chosen `xhigh`, and it does not get to.
    expect(probe.sentEffort()).toBe("low")
    expect(budgetNotices(result)).toEqual([])
  })
})
