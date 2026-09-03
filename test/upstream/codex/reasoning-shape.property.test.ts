// Feature: native-api-mode, Property 39: The Codex reasoning shape is nested at the source and
// survives normalization — for any canonical request, the Codex body carries `reasoning_effort` at
// no nesting level; it carries `reasoning.effort` exactly when the canonical request carries effort
// and omits `reasoning` entirely otherwise; and passing the body through `normalizeReasoningBody()`
// preserves `reasoning.effort` for a model both inside and outside the `gpt-5` regex.
//
// **Validates: Requirements 4.4**
//
// ## The load-bearing half is the out-of-regex model
//
// The first two clauses are the shape change itself, and they would be satisfied by task 19b.1 alone.
// The third clause is the reason the task exists. Before the change, `canonicalToCodexBody()` emitted
// flat `reasoning_effort` and the only thing keeping live traffic off a 400 was
// `normalizeReasoningBody()` (`src/core/reasoning.ts`), which runs inside
// `CodexStandaloneClient.request()`, deletes `reasoning_effort` unconditionally, and re-emits it as
// `reasoning: { effort }` **only** for a model matching
// `^(gpt-5(?:\.[^_]+)?)(?:_(none|low|medium|high|xhigh|max|ultra))?$`. For a model outside that regex
// — `gpt-5-codex` is the live example, since `-codex` is neither `.something` nor `_level` — the
// field was deleted and never re-emitted: the client's effort vanished on a 200 with zero notice
// (spike §10.3). That silent drop is what the out-of-regex cases below assert is gone.
//
// The spike is explicit that the out-of-regex drop was **inferred from reading `src/core/reasoning.ts`,
// not measured live** (§10.3), and this file does not change that. It measures the *code*: the
// composition `normalizeReasoningBody(canonicalToCodexBody(request))` is two pure functions and is
// reachable with no client, no auth, and no network, so what reaches the wire builder is checkable
// generatively. Whether the wire accepts it on a `gpt-5-codex` model is task 19b.4's live gate.
//
// ## Why the composition and not just the builder
//
// Asserting only on `canonicalToCodexBody()` would pass while the normalizer quietly ate the nested
// object one layer later — which is a mirror image of the bug being fixed, and exactly the failure a
// unit test of the builder alone cannot see. The two functions are separately owned (`src/upstream/`
// and `src/core/`) and 19b.1 deliberately changes only the first, so the claim that they compose has
// to be asserted somewhere. Here.
//
// ## Input space
//
// `reasoningEffort` is `string | undefined` in the canonical contract and the emit is guarded by
// truthiness, so the generated space covers: the four levels the endpoint's own catalog advertises
// (`low`, `medium`, `high`, `xhigh` — §10), the two extra levels the model-suffix regex accepts
// (`none`, `max`), a value outside every enum, `undefined`, and the empty string. The last two are
// the "carries no effort" side of clause 2: `""` is falsy, so a client that sent an empty effort gets
// no `reasoning` object, and asserting that keeps the guard's actual semantics on the record rather
// than a paraphrase of them.
//
// `"ultra"` is deliberately **excluded** from the level generator. `normalizeReasoningEffort()`
// rewrites `ultra → max` for in-regex models, which is pre-existing `src/core/reasoning.ts` behavior
// that task 19b.1 does not touch and that this property does not describe — "preserves
// `reasoning.effort`" is a claim about the nested field surviving the normalizer, and generating the
// one value the normalizer intentionally rewrites would make the property assert something else. The
// exclusion is a statement about that value, not a hole: `ultra` is covered where it belongs, in
// `test/auth-reasoning.test.ts`.
//
// The model generator is split into an explicitly in-regex list and an explicitly out-of-regex list,
// each membership checked against the regex itself by a guard test below, so a future edit to the
// regex that silently empties one half fails loudly instead of leaving that half vacuous.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import type { Canonical_Request } from "../../../src/core/canonical"
import { normalizeReasoningBody } from "../../../src/core/reasoning"
import type { JsonObject } from "../../../src/core/types"
import { canonicalToCodexBody } from "../../../src/upstream/codex/parse"

/** The regex `normalizeReasoningModel()` gates its re-emit on, restated so the split can be checked. */
const GPT5_MODEL_REGEX = /^(gpt-5(?:\.[^_]+)?)(?:_(none|low|medium|high|xhigh|max|ultra))?$/

/** Models the normalizer rewrites: it strips any suffix and merges the existing `reasoning` object. */
const IN_REGEX_MODELS = ["gpt-5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.4_high", "gpt-5.6-sol_low"] as const

/**
 * Models the normalizer leaves alone by returning `{}` — the silent-drop cases before this fix.
 *
 * `gpt-5-codex` is the one that matters in production: `-codex` is neither `.something` nor `_level`.
 */
const OUT_OF_REGEX_MODELS = ["gpt-5-codex", "gpt-5-codex_high", "gpt-4.1", "gpt-5_bogus", "o3-mini", "claude-sonnet-4-5"] as const

/** Effort values a client can land in `reasoningEffort`. See the input-space note on `"ultra"`. */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "none", "max", "not-an-enum-member"] as const

const anyModel = fc.constantFrom(...IN_REGEX_MODELS, ...OUT_OF_REGEX_MODELS)

function canonicalRequest(model: string, reasoningEffort: string | undefined, overrides: Partial<Canonical_Request> = {}): Canonical_Request {
  return {
    model,
    instructions: "Be helpful",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...overrides,
  }
}

/** Every key at every nesting level, so "at no nesting level" is checked rather than asserted shallowly. */
function collectKeysDeep(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeysDeep(entry, into)
    return into
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      into.push(key)
      collectKeysDeep(nested, into)
    }
  }
  return into
}

function reasoningOf(body: JsonObject): { effort?: unknown; summary?: unknown } | undefined {
  const reasoning = body.reasoning
  return reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning) ? (reasoning as { effort?: unknown; summary?: unknown }) : undefined
}

describe("The Codex reasoning shape is nested at the source and survives normalization", () => {
  // -------------------------------------------------------------------------------------------
  // Guards on the generators themselves
  // -------------------------------------------------------------------------------------------

  test("Feature: native-api-mode, Property 39: the model split matches the regex the normalizer actually gates on", () => {
    for (const model of IN_REGEX_MODELS) expect(GPT5_MODEL_REGEX.test(model)).toBe(true)
    for (const model of OUT_OF_REGEX_MODELS) expect(GPT5_MODEL_REGEX.test(model)).toBe(false)
    // Neither half may be empty, or the clause covering it would pass vacuously.
    expect(IN_REGEX_MODELS.length).toBeGreaterThan(0)
    expect(OUT_OF_REGEX_MODELS.length).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------------------------
  // Clause 1 — `reasoning_effort` appears at no nesting level
  // -------------------------------------------------------------------------------------------

  test("Feature: native-api-mode, Property 39: the emitted body carries `reasoning_effort` at no nesting level", () => {
    fc.assert(
      fc.property(anyModel, fc.option(fc.constantFrom(...EFFORT_LEVELS, ""), { nil: undefined }), (model, effort) => {
        const body = canonicalToCodexBody(canonicalRequest(model, effort))
        expect(collectKeysDeep(body)).not.toContain("reasoning_effort")

        // And it stays absent after the normalizer, which is the layer that used to be the only
        // reason a 400 was avoided. §10.2 measured the flat key refused outright.
        expect(collectKeysDeep(normalizeReasoningBody(body))).not.toContain("reasoning_effort")
      }),
      { numRuns: 300 },
    )
  })

  // -------------------------------------------------------------------------------------------
  // Clause 2 — `reasoning.effort` exactly when canonical carries effort, `reasoning` absent otherwise
  // -------------------------------------------------------------------------------------------

  test("Feature: native-api-mode, Property 39: `reasoning.effort` is emitted exactly when the canonical request carries effort", () => {
    fc.assert(
      fc.property(anyModel, fc.constantFrom(...EFFORT_LEVELS), (model, effort) => {
        const body = canonicalToCodexBody(canonicalRequest(model, effort))
        expect(reasoningOf(body)?.effort).toBe(effort)
        // `summary: "auto"` is the measured choice — accepted and echoed back as `"detailed"` (§10.4).
        expect(reasoningOf(body)?.summary).toBe("auto")
      }),
      { numRuns: 150 },
    )
  })

  test("Feature: native-api-mode, Property 39: `reasoning` is omitted entirely when the canonical request carries no effort", () => {
    fc.assert(
      // Both ways a request can carry no effort: the member absent, and the falsy empty string the
      // truthiness guard treats as absent.
      fc.property(anyModel, fc.constantFrom(undefined, ""), (model, effort) => {
        const body = canonicalToCodexBody(canonicalRequest(model, effort))
        expect(body).not.toHaveProperty("reasoning")
        // No empty husk: `reasoning: {}` would read as a stated-but-empty configuration.
        expect(reasoningOf(body)).toBeUndefined()
      }),
      { numRuns: 150 },
    )
  })

  // -------------------------------------------------------------------------------------------
  // Clause 3 — the nested effort survives `normalizeReasoningBody()` on both sides of the regex
  // -------------------------------------------------------------------------------------------

  test("Feature: native-api-mode, Property 39: `reasoning.effort` survives normalization for a model inside the `gpt-5` regex", () => {
    fc.assert(
      fc.property(fc.constantFrom(...IN_REGEX_MODELS), fc.constantFrom(...EFFORT_LEVELS), (model, effort) => {
        const normalized = normalizeReasoningBody(canonicalToCodexBody(canonicalRequest(model, effort)))

        // The client's stated effort wins over the level the normalizer would have defaulted to from
        // the model suffix — `gpt-5.4_high` with a canonical `low` must still send `low`.
        expect(reasoningOf(normalized)?.effort).toBe(effort)
        expect(reasoningOf(normalized)?.summary).toBe("auto")
      }),
      { numRuns: 150 },
    )
  })

  test("Feature: native-api-mode, Property 39: `reasoning.effort` survives normalization for a model outside the `gpt-5` regex", () => {
    fc.assert(
      // The point of the fix. Before 19b.1 the builder emitted flat `reasoning_effort`, the
      // normalizer deleted it, `normalizeReasoningModel()` returned `{}` for these models, and the
      // effort reached the wire under no key at all (§10.3).
      fc.property(fc.constantFrom(...OUT_OF_REGEX_MODELS), fc.constantFrom(...EFFORT_LEVELS), (model, effort) => {
        const normalized = normalizeReasoningBody(canonicalToCodexBody(canonicalRequest(model, effort)))

        expect(reasoningOf(normalized)?.effort).toBe(effort)
        expect(reasoningOf(normalized)?.summary).toBe("auto")
        // The normalizer leaves an out-of-regex model's name alone; only the in-regex path rewrites it.
        expect(normalized.model).toBe(model)
      }),
      { numRuns: 150 },
    )
  })

  test("Feature: native-api-mode, Property 39: normalization introduces no `reasoning` object for a request that carries no effort", () => {
    fc.assert(
      fc.property(anyModel, fc.constantFrom(undefined, ""), (model, effort) => {
        const normalized = normalizeReasoningBody(canonicalToCodexBody(canonicalRequest(model, effort)))
        const reasoning = reasoningOf(normalized)

        // In-regex models are the exception the normalizer owns: with no effort anywhere in the body
        // it fills in its own `medium` default from the suffix. That is pre-existing behavior this
        // task does not touch, so it is asserted as it is rather than asserted away — what matters
        // here is that nothing the *builder* produced invented a reasoning configuration.
        if (GPT5_MODEL_REGEX.test(model)) expect(typeof reasoning?.effort).toBe("string")
        else expect(reasoning).toBeUndefined()
      }),
      { numRuns: 150 },
    )
  })
})
