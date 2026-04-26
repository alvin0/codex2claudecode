import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { filterCommands, getCommands } from "../../src/ui/commands"
import type { ProviderMode } from "../../src/ui/types"

describe("UI commands properties", () => {
  test("filterCommands returns a valid subset of getCommands", () => {
    fc.assert(
      fc.property(fc.constantFrom<ProviderMode>("codex", "kiro"), fc.string(), (mode, query) => {
        const filtered = filterCommands(query, mode)
        const names = new Set(getCommands(mode).map((command) => command.name))

        expect(filtered.length).toBeLessThanOrEqual(8)
        for (const command of filtered) {
          expect(names.has(command.name)).toBe(true)
          expect(command.name.startsWith("/")).toBe(true)
          expect(command.name.length).toBeGreaterThan(1)
          expect(command.description.length).toBeGreaterThan(0)
        }
      }),
    )
  })
})
