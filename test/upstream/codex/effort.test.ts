// Feature: native-api-mode, task 20.2 — the model effort default on the Codex path.
//
// Covers Requirements 16.1 (apply `effort.defaultLevel` when the client omits effort), 16.2 (omit
// entirely when the descriptor carries no default), 16.3 (a stated client value beats the default),
// and 16.9 (`thinking.mode === "disabled"` omits).
//
// The end of the chain is asserted through `canonicalToCodexBody()` as well as through the decision
// function, because the requirement is about what reaches the wire and the wire shape changed in
// task 19b.1: a defaulted level has to land in the nested `reasoning: { effort }` object, never in a
// flat `reasoning_effort` that spike §10.2 measured as a 400.
import { describe, expect, test } from "bun:test"
import type { Canonical_Request } from "../../../src/core/canonical"
import { applyCodexEffortDefault, codexEffortMetadata, selectCodexEffortLevel } from "../../../src/upstream/codex/effort"
import { CodexModelMetadataRegistry } from "../../../src/upstream/codex/model-metadata"
import { canonicalToCodexBody } from "../../../src/upstream/codex/parse"

const LEVELS = ["low", "medium", "high", "xhigh"] as const

/** A descriptor whose default is a member of its own enum — the shape the catalog advertises. */
const withDefault = { levels: [...LEVELS], defaultLevel: "high" }
/** A model that advertises levels but names no default. */
const withoutDefault = { levels: [...LEVELS] }

function request(overrides: Partial<Canonical_Request> = {}): Canonical_Request {
  return {
    model: "gpt-5-codex",
    instructions: "Be helpful",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
    ...overrides,
  }
}

function reasoningOf(body: Record<string, unknown>): { effort?: unknown; summary?: unknown } | undefined {
  const reasoning = body.reasoning
  return reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning) ? (reasoning as { effort?: unknown }) : undefined
}

describe("selectCodexEffortLevel", () => {
  test("applies the model default when the client states no effort (Requirement 16.1)", () => {
    expect(selectCodexEffortLevel(withDefault, {})).toEqual({ kind: "selected", source: "model_default", level: "high" })
  })

  test("omits effort when the descriptor carries no default (Requirement 16.2)", () => {
    expect(selectCodexEffortLevel(withoutDefault, {})).toEqual({ kind: "absent", reason: "no_model_default" })
  })

  test("omits effort when the model advertises no effort vocabulary at all", () => {
    expect(selectCodexEffortLevel(undefined, {})).toEqual({ kind: "absent", reason: "no_model_default" })
  })

  test("a stated client value beats the model default (Requirement 16.3)", () => {
    expect(selectCodexEffortLevel(withDefault, { requested: "low" })).toEqual({ kind: "selected", source: "explicit", level: "low" })
  })

  test("a stated value survives a model with no vocabulary — forwarded, not validated", () => {
    // The registry is empty until `listModels()` has run. Dropping a client's level here would be a
    // silent regression on a cold start, so explicit input is forwarded whatever the metadata says.
    expect(selectCodexEffortLevel(undefined, { requested: "xhigh" })).toEqual({ kind: "selected", source: "explicit", level: "xhigh" })
  })

  test("an empty stated value is not a stated value, so the default still applies", () => {
    expect(selectCodexEffortLevel(withDefault, { requested: "" })).toEqual({ kind: "selected", source: "model_default", level: "high" })
  })

  test("thinking disabled outranks every rung, including an explicit level (Requirement 16.9)", () => {
    expect(selectCodexEffortLevel(withDefault, { requested: "high", thinking: { mode: "disabled" } })).toEqual({
      kind: "absent",
      reason: "thinking_disabled",
    })
  })

  test("thinking enabled with a budget still falls through to the model default — the budget rung is inert", () => {
    // Documented behavior, not an accident: the budget→level mapping is a separate task, and an
    // unmapped rung declines rather than inventing the lowest level.
    expect(selectCodexEffortLevel(withDefault, { thinking: { mode: "enabled", budgetTokens: 4000 } })).toEqual({
      kind: "selected",
      source: "model_default",
      level: "high",
    })
  })

  test("a default outside its own enum is not honoured — nothing this module chooses leaves the vocabulary", () => {
    expect(selectCodexEffortLevel({ levels: [...LEVELS], defaultLevel: "ultra" }, {})).toEqual({ kind: "absent", reason: "no_model_default" })
  })
})

describe("codexEffortMetadata", () => {
  test("derives levels and default from a registry entry populated by the catalog", () => {
    const registry = new CodexModelMetadataRegistry()
    registry.populate({
      models: [
        {
          slug: "gpt-5-codex",
          supported_reasoning_levels: LEVELS.map((effort) => ({ effort })),
          default_reasoning_level: "medium",
        },
      ],
    })

    expect(codexEffortMetadata(registry.get("gpt-5-codex"))).toEqual({ levels: [...LEVELS], defaultLevel: "medium" })
  })

  test("is undefined for a model advertising no levels, and for a model absent from the registry", () => {
    const registry = new CodexModelMetadataRegistry()
    registry.populate({ models: [{ slug: "gpt-4.1" }] })

    expect(codexEffortMetadata(registry.get("gpt-4.1"))).toBeUndefined()
    expect(codexEffortMetadata(registry.get("nope"))).toBeUndefined()
  })
})

describe("applyCodexEffortDefault", () => {
  test("the defaulted level reaches the wire nested under `reasoning`, never as `reasoning_effort`", () => {
    const body = canonicalToCodexBody(applyCodexEffortDefault(request(), withDefault))

    expect(reasoningOf(body)).toEqual({ effort: "high", summary: "auto" })
    expect(body).not.toHaveProperty("reasoning_effort")
  })

  test("no default means no `reasoning` object at all — not an empty husk", () => {
    const body = canonicalToCodexBody(applyCodexEffortDefault(request(), withoutDefault))

    expect(body).not.toHaveProperty("reasoning")
  })

  test("a stated level is what goes on the wire", () => {
    const body = canonicalToCodexBody(applyCodexEffortDefault(request({ reasoningEffort: "low" }), withDefault))

    expect(reasoningOf(body)?.effort).toBe("low")
  })

  test("thinking disabled strips a stated level so no reasoning is configured", () => {
    const resolved = applyCodexEffortDefault(request({ reasoningEffort: "high", thinking: { mode: "disabled" } }), withDefault)

    expect(resolved).not.toHaveProperty("reasoningEffort")
    expect(canonicalToCodexBody(resolved)).not.toHaveProperty("reasoning")
  })

  test("returns the same request object when the resolution changes nothing", () => {
    // Byte-stability for the common case: an unchanged request must not become a new object whose
    // key order could differ from what the live fixtures recorded.
    const stated = request({ reasoningEffort: "high" })
    expect(applyCodexEffortDefault(stated, withDefault)).toBe(stated)

    const none = request()
    expect(applyCodexEffortDefault(none, undefined)).toBe(none)
  })

  test("leaves the rest of the request untouched", () => {
    const original = request({ reasoningEffort: "low", instructions: "stay terse", stream: true })
    const resolved = applyCodexEffortDefault(original, withDefault)

    expect(resolved.instructions).toBe("stay terse")
    expect(resolved.stream).toBe(true)
    expect(resolved.input).toEqual(original.input)
  })
})
