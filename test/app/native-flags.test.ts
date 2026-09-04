import { describe, expect, test } from "bun:test"

import { kiroDebugOnErrorEnabled } from "../../src/core/debug-capture"
import { isEnablingValue, readNativeFlags, type NativeFlags } from "../../src/app/native-flags"

/**
 * Unit coverage for the only reader of the native-mode environment.
 *
 * Property 5 (strict escalation) belongs to `test/core/strict.property.test.ts`
 * in task 11.3; this file covers the reader itself — the flag-to-variable
 * mapping, the enabling-value set, and the default-off guarantee.
 */

const FLAG_VARIABLES: ReadonlyArray<[keyof NativeFlags, string]> = [
  ["strict", "NATIVE_STRICT"],
  ["passthrough", "NATIVE_PASSTHROUGH"],
  ["mcpEmulation", "NATIVE_MCP_EMULATION"],
  ["kiroWebSearchHeuristics", "KIRO_WEB_SEARCH_HEURISTICS"],
  ["featureNotices", "NATIVE_FEATURE_NOTICES"],
]

const ENABLING = ["1", "true", "yes", "on", "TRUE", "Yes", "On", "TrUe"]
const DISABLING = ["", "0", "false", "no", "off", "2", "true ", " 1", "yes\n", "enabled", "y", "null", "undefined", "on1"]

describe("readNativeFlags", () => {
  test("every flag is disabled when the environment is empty", () => {
    expect(readNativeFlags({})).toEqual({
      strict: false,
      passthrough: false,
      mcpEmulation: false,
      kiroWebSearchHeuristics: false,
      featureNotices: false,
    })
  })

  test("each flag reads exactly its own variable", () => {
    for (const [flag, variable] of FLAG_VARIABLES) {
      const flags = readNativeFlags({ [variable]: "1" })
      expect(flags[flag]).toBe(true)
      for (const [otherFlag] of FLAG_VARIABLES) {
        if (otherFlag !== flag) expect(flags[otherFlag]).toBe(false)
      }
    }
  })

  test("all five flags can be enabled at once", () => {
    const env = Object.fromEntries(FLAG_VARIABLES.map(([, variable]) => [variable, "on"]))
    expect(readNativeFlags(env)).toEqual({
      strict: true,
      passthrough: true,
      mcpEmulation: true,
      kiroWebSearchHeuristics: true,
      featureNotices: true,
    })
  })

  test("only the documented enabling values enable a flag", () => {
    for (const value of ENABLING) expect(readNativeFlags({ NATIVE_STRICT: value }).strict).toBe(true)
    for (const value of DISABLING) expect(readNativeFlags({ NATIVE_STRICT: value }).strict).toBe(false)
    expect(readNativeFlags({ NATIVE_STRICT: undefined }).strict).toBe(false)
  })

  test("reading twice returns an equal but independent object, so nothing is cached", () => {
    const first = readNativeFlags({ NATIVE_STRICT: "1" })
    const second = readNativeFlags({})
    expect(first.strict).toBe(true)
    expect(second.strict).toBe(false)
    expect(first).not.toBe(second)
  })

  test("the process environment is never mutated", () => {
    const before = JSON.stringify(process.env)
    readNativeFlags()
    readNativeFlags({ NATIVE_STRICT: "1" })
    expect(JSON.stringify(process.env)).toBe(before)
  })
})

describe("isEnablingValue", () => {
  test("agrees with kiroDebugOnErrorEnabled on every value", () => {
    for (const value of [...ENABLING, ...DISABLING, undefined]) {
      expect(isEnablingValue(value)).toBe(kiroDebugOnErrorEnabled({ KIRO_DEBUG_ON_ERROR: value }))
    }
  })
})
