// Feature: native-api-mode — the static effort descriptor fallback, and what it may not do.
//
// Root cause on the record (Run_Record 23 and 27): the live `ListAvailableModels` entry for
// `claude-sonnet-4.5` carries `additionalModelRequestFieldsSchema: null`, so the registry produced
// no effort descriptor for it and three live effort cases had nothing to send. `kiro-models.json`
// does declare that model's levels. The fix makes the bundled file a **fallback**, so these tests
// are as much about the ordering as about the translation:
//
//  1. Where live publishes an enum, the live enum is what the registry carries — untouched, and
//     marked `provenance: "live"`.
//  2. Where live is **silent** — no `additionalModelRequestFieldsSchema` key at all, or a string-only
//     entry — the static descriptor fills the gap, marked `provenance: "static"` so a client can tell
//     a shipped assumption from a measurement.
//  3. `effort_max: false` means `max` is not a level, and a model with every flag false gets no
//     descriptor at all rather than an empty enum.
//  4. A model the static file has never heard of keeps today's behaviour exactly: no `effort`.
//
// And the correction the first version of this fallback needed. Filling on
// `additionalModelRequestFieldsSchema: null` was wrong: the key is *present*, so the endpoint is
// saying "there are no additional request fields", not "I have no information" — nine other entries
// in the same catalog response publish a real effort enum, so a `null` is a denial. Filling it made
// the gateway send `additionalModelRequestFields.output_config` to a model that answers
// `400 REQUEST_BODY_INVALID` for that field regardless of value, turning two requests that had been
// returning 200 into 400s. So the fallback fills silence only, and the tests below pin the difference
// between silence and denial rather than merely the translation.

import { describe, expect, test } from "bun:test"

import { KiroModelMetadataRegistry } from "../../../src/upstream/kiro/model-metadata"
import { resetStaticKiroEffortCache, staticKiroEffortDescriptor, staticKiroEffortModelIds } from "../../../src/upstream/kiro/static-models"

/** The live shape that carries an effort enum, as `parseEffortMetadata()` reads it. */
function liveEffortSchema(schemaPath: "output_config" | "reasoning", levels: string[], defaultLevel?: string) {
  return {
    properties: {
      [schemaPath]: {
        properties: { effort: { enum: levels, ...(defaultLevel ? { default: defaultLevel } : {}) } },
      },
    },
  }
}

describe("Feature: native-api-mode, the bundled Kiro descriptor file as an effort fallback", () => {
  test("translates the effort_* booleans into a descriptor, excluding the false flags", () => {
    resetStaticKiroEffortCache()
    const descriptor = staticKiroEffortDescriptor("claude-sonnet-4.5")

    // `effort_low/medium/high/xhigh = true`, `effort_max = false` in `kiro-models.json`, so `max`
    // is absent — the same vocabulary the `effort-degrade` live case degrades `max` against.
    expect(descriptor).toEqual({
      schemaPath: "output_config",
      levels: ["low", "medium", "high", "xhigh"],
      defaultLevel: "low",
      provenance: "static",
    })
    expect(descriptor!.levels).not.toContain("max")
    // Containment: the default this file supplies is a member of its own enum, which is the
    // post-condition `selectEffortLevel()` relies on.
    expect(descriptor!.levels).toContain(descriptor!.defaultLevel!)
  })

  test("a model whose every effort flag is false gets no descriptor rather than an empty enum", () => {
    // `claude-3.5-haiku` and `claude-3-haiku` declare no thinking and no effort level. An empty
    // enum would claim the model accepts effort while accepting nothing.
    expect(staticKiroEffortDescriptor("claude-3.5-haiku")).toBeUndefined()
    expect(staticKiroEffortDescriptor("claude-3-haiku")).toBeUndefined()
    expect(staticKiroEffortModelIds()).not.toContain("claude-3.5-haiku")
  })

  test("resolves the file's own aliases, and answers nothing for an unknown id", () => {
    expect(staticKiroEffortDescriptor("claude-4.5-sonnet")).toEqual(staticKiroEffortDescriptor("claude-sonnet-4.5"))
    expect(staticKiroEffortDescriptor("claude-sonnet-4-5")).toEqual(staticKiroEffortDescriptor("claude-sonnet-4.5"))
    expect(staticKiroEffortDescriptor("deepseek-3.2")).toBeUndefined()
    expect(staticKiroEffortDescriptor("")).toBeUndefined()
  })

  test("treats a present-but-null live schema as a denial and produces no descriptor", () => {
    const registry = new KiroModelMetadataRegistry()
    // The measured live bytes for `claude-sonnet-4.5`: key present, value null. The static file has
    // a descriptor for this exact id — the previous test proves it — so a descriptor appearing here
    // could only come from the fallback overruling the endpoint.
    registry.populate({ models: [{ modelId: "claude-sonnet-4.5", additionalModelRequestFieldsSchema: null }] })

    expect(staticKiroEffortDescriptor("claude-sonnet-4.5")).toBeDefined()
    expect(registry.get("claude-sonnet-4.5")?.effort).toBeUndefined()
    expect(registry.get("claude-sonnet-4.5")?.effortSchemaDisclosure).toBe("answered")
    // Everything else about the entry is still the live parse.
    expect(registry.get("claude-sonnet-4.5")?.richMetadata).toBe(true)
  })

  test("fills the gap for a live entry that never mentions the schema key", () => {
    const registry = new KiroModelMetadataRegistry()
    // Same model, same static descriptor, one difference: the endpoint said nothing at all about
    // additional request fields. Silence is a gap, and a gap is what the bundled file is for.
    registry.populate({ models: [{ modelId: "claude-sonnet-4.5", modelName: "Claude Sonnet 4.5" }] })

    const effort = registry.get("claude-sonnet-4.5")?.effort
    expect(effort).toMatchObject({ schemaPath: "output_config", levels: ["low", "medium", "high", "xhigh"], provenance: "static" })
    expect(effort?.defaultLevel).toBe("low")
    expect(registry.get("claude-sonnet-4.5")?.effortSchemaDisclosure).toBe("silent")
  })

  test("a present schema that publishes no effort enum is a denial too", () => {
    const registry = new KiroModelMetadataRegistry()
    // The endpoint listed its additional request fields and effort is not among them. That is an
    // answer, and the bundled file does not get to contradict an answer.
    registry.populate({
      models: [{ modelId: "claude-sonnet-4.5", additionalModelRequestFieldsSchema: { properties: { output_config: { properties: {} } } } }],
    })

    expect(registry.get("claude-sonnet-4.5")?.effort).toBeUndefined()
    expect(registry.get("claude-sonnet-4.5")?.effortSchemaDisclosure).toBe("answered")
  })

  test("an explicit undefined schema reads as silence, not as an answer", () => {
    const registry = new KiroModelMetadataRegistry()
    // `undefined` and an absent key are indistinguishable once a body has been through
    // JSON.stringify/parse, so the verdict must not depend on which one reached us.
    registry.populate({ models: [{ modelId: "claude-sonnet-4.5", additionalModelRequestFieldsSchema: undefined }] })

    expect(registry.get("claude-sonnet-4.5")?.effortSchemaDisclosure).toBe("silent")
    expect(registry.get("claude-sonnet-4.5")?.effort).toMatchObject({ provenance: "static" })
  })

  test("live metadata wins wherever it exists, and is marked as measured", () => {
    const registry = new KiroModelMetadataRegistry()
    registry.populate({
      models: [{
        modelId: "claude-sonnet-4.5",
        // A live enum that disagrees with the file on every axis: a different path, a different
        // vocabulary (including the `max` the file calls unsupported), a different default.
        additionalModelRequestFieldsSchema: liveEffortSchema("reasoning", ["medium", "max"], "max"),
      }],
    })

    expect(registry.get("claude-sonnet-4.5")?.effort).toEqual({
      schemaPath: "reasoning",
      levels: ["medium", "max"],
      defaultLevel: "max",
      provenance: "live",
    })
  })

  test("a model absent from the file keeps today's behaviour: no effort descriptor", () => {
    const registry = new KiroModelMetadataRegistry()
    registry.populate({ models: [{ modelId: "deepseek-3.2", additionalModelRequestFieldsSchema: null }] })

    expect(registry.get("deepseek-3.2")?.effort).toBeUndefined()
    expect(registry.isPopulated).toBe(true)
  })

  test("fills the gap for string-only entries and for the default model", () => {
    const registry = new KiroModelMetadataRegistry()
    registry.populate({ defaultModel: { modelId: "claude-opus-4.5" }, models: ["claude-haiku-4.5"] })

    // A string entry is still a model the account can call; there is no reason to know less
    // about it than about a rich neighbour.
    expect(registry.get("claude-haiku-4.5")?.effort).toMatchObject({ provenance: "static", defaultLevel: "low" })
    expect(registry.getDefault()?.effort).toMatchObject({ provenance: "static", levels: ["low", "medium", "high", "xhigh"] })
  })

  test("the default model is held to the same denial rule as any other entry", () => {
    const registry = new KiroModelMetadataRegistry()
    registry.populate({ defaultModel: { modelId: "claude-opus-4.5", additionalModelRequestFieldsSchema: null }, models: [] })

    expect(registry.getDefault()?.effortSchemaDisclosure).toBe("answered")
    expect(registry.getDefault()?.effort).toBeUndefined()
  })

  test("clear() drops the merged descriptors with the rest of the registry", () => {
    const registry = new KiroModelMetadataRegistry()
    registry.populate({ models: [{ modelId: "claude-sonnet-4.5", additionalModelRequestFieldsSchema: null }] })
    registry.clear()

    expect(registry.isPopulated).toBe(false)
    expect(registry.get("claude-sonnet-4.5")).toBeUndefined()
  })
})
