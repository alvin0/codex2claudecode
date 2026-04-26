import BunModule from "bun"
import { expect } from "vitest"

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
})
