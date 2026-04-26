import { afterEach, describe, expect, test } from "bun:test"

import { dirnamePath, isAbsolutePath, joinPath, makeDir, normalizePath, tempDir } from "../../src/core/paths"
import { pathExists, removePath } from "../../src/core/bun-fs"

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => removePath(root, { recursive: true, force: true })))
})

describe("Bun path helpers", () => {
  test("normalizes dot segments, repeated separators, and trailing slashes", () => {
    expect(canonical(normalizePath("alpha//beta/./gamma/..//"))).toBe("alpha/beta")
    expect(canonical(normalizePath("/alpha/../beta/"))).toBe("/beta")
    expect(canonical(normalizePath("."))).toBe(".")
  })

  test("handles Windows drive paths without treating drive-relative paths as absolute", () => {
    expect(canonical(normalizePath("C:\\Users\\me\\..\\you\\"))).toBe("C:/Users/you")
    expect(canonical(dirnamePath("C:\\Users\\you\\file.txt"))).toBe("C:/Users/you")
    expect(canonical(dirnamePath("C:\\"))).toBe("C:/")
    expect(isAbsolutePath("C:\\Users\\you")).toBe(true)
    expect(isAbsolutePath("C:/Users/you")).toBe(true)
    expect(isAbsolutePath("C:relative\\file.txt")).toBe(false)
    expect(isAbsolutePath("C:")).toBe(false)
  })

  test("computes dirname and join behavior consistently", () => {
    expect(canonical(dirnamePath("/"))).toBe("/")
    expect(canonical(dirnamePath("/alpha/beta/"))).toBe("/alpha")
    expect(dirnamePath("file.txt")).toBe(".")
    expect(canonical(joinPath("/alpha/", "beta", "../gamma"))).toBe("/alpha/gamma")
    expect(canonical(joinPath("/alpha", "/reset", "child"))).toBe("/reset/child")
  })

  test("creates literal directory names containing shell metacharacters", async () => {
    const root = joinPath(tempDir(), `paths-test-${crypto.randomUUID()}`)
    tempRoots.push(root)
    const literal = joinPath(root, "semi;quote'and space")

    await makeDir(literal)

    expect(await pathExists(literal)).toBe(true)
  })
})

function canonical(value: string) {
  return value.replace(/\\/g, "/")
}
