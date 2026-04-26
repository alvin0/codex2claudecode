import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { normalizeKiroModelName } from "../../../src/upstream/kiro"

describe("Kiro model properties", () => {
  test("Property 16: model name normalization idempotence", () => {
    fc.assert(fc.property(fc.string(), (model) => {
      expect(normalizeKiroModelName(normalizeKiroModelName(model))).toBe(normalizeKiroModelName(model))
    }), { numRuns: 100 })
  })
})
