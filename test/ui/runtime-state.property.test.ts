import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { runtimeLine } from "../../src/ui/runtime-state"
import type { ProviderMode } from "../../src/ui/types"

describe("runtime state properties", () => {
  test("running output contains provider label and URL", () => {
    fc.assert(
      fc.property(fc.constantFrom<ProviderMode>("codex", "kiro"), fc.string({ minLength: 1 }), fc.integer({ min: 1, max: 65535 }), fc.integer({ min: 0 }), (mode, hostname, port, startedAt) => {
        const line = runtimeLine({ status: "running", server: {} as any, startedAt }, hostname, port, mode)
        expect(line).toContain(mode === "codex" ? "Codex" : "Kiro")
        expect(line).toContain(`http://${hostname}:${port}`)
      }),
    )
  })

  test("error output is mode-independent", () => {
    fc.assert(
      fc.property(fc.constantFrom<ProviderMode>("codex", "kiro"), fc.string(), (mode, errorMessage) => {
        expect(runtimeLine({ status: "error", error: errorMessage }, "localhost", 8787, mode)).toBe(`Runtime error: ${errorMessage}`)
      }),
    )
  })
})
