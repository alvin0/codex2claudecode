import { describe, expect, test } from "bun:test"

import { DEFAULT_KIRO_VERSION, resolveKiroVersion } from "../../../src/upstream/kiro/constants"

describe("Kiro client version", () => {
  test("uses a concrete bundled version when no version is configured", () => {
    expect(resolveKiroVersion(undefined, {})).toBe(DEFAULT_KIRO_VERSION)
    expect(DEFAULT_KIRO_VERSION).toBe("1.4.154")
  })

  test("prefers an explicit version over the environment", () => {
    expect(resolveKiroVersion(" 1.4.155 ", { KIRO_VERSION: "1.4.154" })).toBe("1.4.155")
  })

  test("uses the environment when the explicit version is absent or blank", () => {
    expect(resolveKiroVersion(undefined, { KIRO_VERSION: " 1.4.156 " })).toBe("1.4.156")
    expect(resolveKiroVersion(" ", { KIRO_VERSION: "1.4.156" })).toBe("1.4.156")
    expect(resolveKiroVersion(" ", { KIRO_VERSION: " " })).toBe(DEFAULT_KIRO_VERSION)
  })

  test("accepts version prerelease and build identifiers", () => {
    expect(resolveKiroVersion("1.4.154-rc.1+build.2", {})).toBe("1.4.154-rc.1+build.2")
  })

  test("rejects unknown versions and invalid header values", () => {
    for (const version of ["unknown", "latest", "1.4", "1.4.154 injected", "1.4.154\r\nx-test: value"]) {
      expect(() => resolveKiroVersion(version, {})).toThrow("Kiro client version")
      expect(() => resolveKiroVersion(undefined, { KIRO_VERSION: version })).toThrow("Kiro client version")
    }
  })
})
