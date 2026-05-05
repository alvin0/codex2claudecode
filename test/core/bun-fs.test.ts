import { afterEach, describe, expect, test } from "bun:test"

import { atomicJsonWrite, fileStat, makeTempDir, pathExists, readDirectory, readTextFile, removePath, setFileMode, writeTextFile } from "../../src/core/bun-fs"
import { joinPath, makeDir, tempDir } from "../../src/core/paths"

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => removePath(root, { recursive: true, force: true })))
})

describe("bun-fs helpers", () => {
  test("writes, reads, stats, and lists files", async () => {
    const root = await tempRoot()
    const file = joinPath(root, "note.txt")

    await writeTextFile(file, "hello")

    expect(await pathExists(file)).toBe(true)
    expect(await readTextFile(file)).toBe("hello")
    expect((await fileStat(file)).isFile()).toBe(true)
    expect(await readDirectory(root)).toContain("note.txt")
  })

  test("removes files and recursive directories", async () => {
    const root = await tempRoot()
    const nested = joinPath(root, "nested", "child")
    const file = joinPath(nested, "note.txt")

    await makeDir(nested)
    await writeTextFile(file, "hello")
    await removePath(joinPath(root, "nested"), { recursive: true })

    expect(await pathExists(joinPath(root, "nested"))).toBe(false)
  })

  test("treats force removal of a missing path as success", async () => {
    await expect(removePath(joinPath(await tempRoot(), "missing"), { force: true })).resolves.toBeUndefined()
  })

  test("handles shell metacharacters as literal path text", async () => {
    const root = await tempRoot()
    const literalName = process.platform === "win32" ? "literal ; 'quoted' path" : 'literal ; "quoted" path'
    const literal = joinPath(root, literalName)
    const file = joinPath(literal, "child.txt")

    await writeTextFile(file, "safe")
    await removePath(literal, { recursive: true, force: true })

    expect(await pathExists(literal)).toBe(false)
    expect(await pathExists(root)).toBe(true)
  })

  test("sets file mode on POSIX", async () => {
    if (process.platform === "win32") return

    const file = joinPath(await tempRoot(), "mode.txt")
    await writeTextFile(file, "secret")
    await setFileMode(file, 0o600)

    expect((await fileStat(file)).mode & 0o777).toBe(0o600)
  })

  test("atomicJsonWrite creates file with correct content and permissions", async () => {
    const root = await tempRoot()
    const file = joinPath(root, "creds.json")
    const data = { accessToken: "abc", refreshToken: "def" }

    await atomicJsonWrite(file, data)

    const content = JSON.parse(await readTextFile(file))
    expect(content).toEqual(data)
    if (process.platform !== "win32") {
      expect((await fileStat(file)).mode & 0o777).toBe(0o600)
    }
  })

  test("atomicJsonWrite preserves old file on write failure", async () => {
    const root = await tempRoot()
    const dir = joinPath(root, "readonly-parent")
    await makeDir(dir)
    const file = joinPath(dir, "existing.json")
    await writeTextFile(file, '{"old":true}\n')

    // Make the directory read-only so the temp file creation fails
    if (process.platform === "win32") return
    const fs = await import("node:fs")
    fs.chmodSync(dir, 0o555)
    try {
      await expect(atomicJsonWrite(file, { new: true })).rejects.toThrow()
      // Restore read permission to verify content
      fs.chmodSync(dir, 0o755)
      const content = await readTextFile(file)
      expect(content).toBe('{"old":true}\n')
    } finally {
      fs.chmodSync(dir, 0o755)
    }
  })
})

async function tempRoot() {
  const root = await makeTempDir(joinPath(tempDir(), "bun-fs-test-"))
  tempRoots.push(root)
  return root
}
