import BunModule from "bun"
import { describe, expect, test } from "vitest"

if (typeof globalThis.Bun === "undefined") {
  globalThis.Bun = BunModule
}

expect.extend({
  toBeString(received: unknown) {
    return {
      pass: typeof received === "string",
      message: () => `${this.utils ? this.utils.printReceived(received) : received} is not a string`,
    }
  },
  toInclude(received: unknown, expected: string) {
    if (typeof received !== "string") {
      throw new TypeError("toInclude() requires the first argument to be a string")
    }
    return {
      pass: received.includes(expected),
      message: () => `expected ${this.utils ? this.utils.printReceived(received) : received} ${this.isNot ? "not " : ""}to include ${this.utils ? this.utils.printExpected(expected) : expected}`,
    }
  },
})

// `bun:test` exposes `test.failing` (bun's name for an expected-to-fail test) and
// `describe.serial` (bun's name for a sequential suite). Vitest ships the same behavior
// under `test.fails` and `describe.sequential`; alias them here so test files written
// against `bun:test` run unchanged under the `vitest.config.ts` alias (`bun:test` ->
// `vitest`, see above).
;(test as unknown as { failing: typeof test.fails }).failing = test.fails
;(describe as unknown as { serial: typeof describe.sequential }).serial = describe.sequential
