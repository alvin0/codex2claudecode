import { describe, expect, test } from "bun:test"

import { isKiroMeteringPayload, parseKiroMeteringUsage } from "../../../src/upstream/kiro/metering"

// The payload measured across ~30 live Kiro calls (`.omc/research/kiro-wire-spike.md` §2).
const MEASURED_METERING_PAYLOAD = '{"unit":"credit","unitPlural":"credits","usage":0.0148}'

describe("isKiroMeteringPayload", () => {
  test("accepts the measured metering payload verbatim", () => {
    const payload = JSON.parse(MEASURED_METERING_PAYLOAD)
    expect(isKiroMeteringPayload(payload)).toBe(true)
  })

  test("accepts the structural minimum without unitPlural", () => {
    expect(isKiroMeteringPayload({ unit: "credit", usage: 0.0148 })).toBe(true)
  })

  test("accepts extra unknown keys so a new provider field does not unclassify metering", () => {
    expect(isKiroMeteringPayload({ unit: "credit", unitPlural: "credits", usage: 1, tier: "flex" })).toBe(true)
  })

  test("accepts usage of zero", () => {
    expect(isKiroMeteringPayload({ unit: "credit", usage: 0 })).toBe(true)
  })

  test("accepts negative usage rather than letting the frame fall through to token usage", () => {
    expect(isKiroMeteringPayload({ unit: "credit", usage: -0.5 })).toBe(true)
  })

  test("accepts an empty-string unit", () => {
    expect(isKiroMeteringPayload({ unit: "", usage: 0.0148 })).toBe(true)
  })

  test("accepts a null-prototype object", () => {
    const payload = Object.create(null) as { unit: string; usage: number }
    payload.unit = "credit"
    payload.usage = 0.0148
    expect(isKiroMeteringPayload(payload)).toBe(true)
  })

  test("rejects non-finite usage", () => {
    expect(isKiroMeteringPayload({ unit: "credit", usage: Number.NaN })).toBe(false)
    expect(isKiroMeteringPayload({ unit: "credit", usage: Number.POSITIVE_INFINITY })).toBe(false)
    expect(isKiroMeteringPayload({ unit: "credit", usage: Number.NEGATIVE_INFINITY })).toBe(false)
  })

  test("rejects the token-usage shape, which carries an object usage and no unit", () => {
    const tokenUsage = { usage: { cacheReadInputTokens: 5, cacheCreationInputTokens: 2, outputTokens: 7 } }
    expect(isKiroMeteringPayload(tokenUsage)).toBe(false)
  })

  test("rejects a numeric usage event with no unit", () => {
    expect(isKiroMeteringPayload({ usage: 3 })).toBe(false)
  })

  test("rejects a unit that is not a string", () => {
    expect(isKiroMeteringPayload({ unit: 1, usage: 0.0148 })).toBe(false)
    expect(isKiroMeteringPayload({ unit: null, usage: 0.0148 })).toBe(false)
  })

  test("rejects a usage that is a numeric string", () => {
    expect(isKiroMeteringPayload({ unit: "credit", usage: "0.0148" })).toBe(false)
  })

  test("rejects a payload missing usage entirely", () => {
    expect(isKiroMeteringPayload({ unit: "credit", unitPlural: "credits" })).toBe(false)
  })

  test("rejects other measured Kiro payloads", () => {
    expect(isKiroMeteringPayload({ content: "ello spike" })).toBe(false)
    expect(isKiroMeteringPayload({ contextUsagePercentage: 0.6485 })).toBe(false)
    expect(isKiroMeteringPayload({ name: "get_weather", toolUseId: "toolu_bdrk_01" })).toBe(false)
    expect(isKiroMeteringPayload({ signature: "EqwCCpEB" })).toBe(false)
  })

  test("rejects null, primitives, and arrays", () => {
    expect(isKiroMeteringPayload(null)).toBe(false)
    expect(isKiroMeteringPayload(undefined)).toBe(false)
    expect(isKiroMeteringPayload(0.0148)).toBe(false)
    expect(isKiroMeteringPayload(MEASURED_METERING_PAYLOAD)).toBe(false)
    expect(isKiroMeteringPayload([{ unit: "credit", usage: 0.0148 }])).toBe(false)
  })
})

describe("parseKiroMeteringUsage", () => {
  test("extracts the credit amount from the measured payload", () => {
    expect(parseKiroMeteringUsage(JSON.parse(MEASURED_METERING_PAYLOAD))).toBe(0.0148)
  })

  test("extracts zero and negative amounts", () => {
    expect(parseKiroMeteringUsage({ unit: "credit", usage: 0 })).toBe(0)
    expect(parseKiroMeteringUsage({ unit: "credit", usage: -0.5 })).toBe(-0.5)
  })

  test("returns undefined for non-finite usage", () => {
    expect(parseKiroMeteringUsage({ unit: "credit", usage: Number.NaN })).toBeUndefined()
    expect(parseKiroMeteringUsage({ unit: "credit", usage: Number.POSITIVE_INFINITY })).toBeUndefined()
  })

  test("returns undefined for the token-usage shape", () => {
    expect(parseKiroMeteringUsage({ usage: { outputTokens: 7 } })).toBeUndefined()
    expect(parseKiroMeteringUsage({ usage: 3 })).toBeUndefined()
  })

  test("returns undefined for every other payload kind", () => {
    expect(parseKiroMeteringUsage({ content: "hello" })).toBeUndefined()
    expect(parseKiroMeteringUsage(null)).toBeUndefined()
    expect(parseKiroMeteringUsage(undefined)).toBeUndefined()
  })

  test("summing across frames totals the credits and skips non-metering payloads", () => {
    const frames: unknown[] = [
      { content: "hello" },
      JSON.parse(MEASURED_METERING_PAYLOAD),
      { usage: { outputTokens: 7 } },
      { unit: "credit", unitPlural: "credits", usage: 0.0052 },
      { contextUsagePercentage: 0.6485 },
    ]

    let providerCredits: number | undefined
    for (const frame of frames) {
      const credits = parseKiroMeteringUsage(frame)
      if (credits === undefined) continue
      providerCredits = (providerCredits ?? 0) + credits
    }

    expect(providerCredits).toBeCloseTo(0.02, 10)
  })

  test("a frame sequence with no metering payload leaves the total undefined", () => {
    const frames: unknown[] = [{ content: "hello" }, { usage: 3 }, { contextUsagePercentage: 0.6485 }]

    let providerCredits: number | undefined
    for (const frame of frames) {
      const credits = parseKiroMeteringUsage(frame)
      if (credits === undefined) continue
      providerCredits = (providerCredits ?? 0) + credits
    }

    expect(providerCredits).toBeUndefined()
  })
})
