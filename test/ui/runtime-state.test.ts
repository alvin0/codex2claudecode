import { describe, expect, test } from "bun:test"

import { runtimeLine } from "../../src/ui/runtime-state"

describe("runtime state line", () => {
  test("renders provider-aware starting states", () => {
    expect(runtimeLine({ status: "starting" }, "localhost", 8787, "codex")).toBe("Starting Codex runtime...")
    expect(runtimeLine({ status: "starting" }, "localhost", 8787, "kiro")).toBe("Starting Kiro runtime...")
    expect(runtimeLine({ status: "starting" }, "localhost", 8787)).toBe("Starting Codex runtime...")
  })

  test("renders provider-aware running states", () => {
    const startedAt = Date.now()
    expect(runtimeLine({ status: "running", server: {} as any, startedAt }, "localhost", 8787, "codex")).toContain("Codex runtime listening on http://localhost:8787")
    expect(runtimeLine({ status: "running", server: {} as any, startedAt }, "localhost", 8787, "kiro")).toContain("Kiro runtime listening on http://localhost:8787")
  })

  test("renders mode-independent error state", () => {
    expect(runtimeLine({ status: "error", error: "port in use" }, "localhost", 8787, "codex")).toBe("Runtime error: port in use")
    expect(runtimeLine({ status: "error", error: "port in use" }, "localhost", 8787, "kiro")).toBe("Runtime error: port in use")
  })
})
