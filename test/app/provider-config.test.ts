import { afterEach, describe, expect, test } from "bun:test"

import { readProviderConfig, resolveProviderMode, writeProviderConfig } from "../../src/app/provider-config"
import { mkdir, mkdtemp, path, readFile, rm, tmpdir, writeFile } from "../helpers"

const tempDirs: string[] = []
const originalWarn = console.warn

afterEach(async () => {
  console.warn = originalWarn
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("provider config", () => {
  test("missing file defaults to codex", async () => {
    const file = path.join(await tempDir(), "missing.json")
    await expect(readProviderConfig(file)).resolves.toBe("codex")
  })

  test("reads kiro provider", async () => {
    const file = await tempFile()
    await writeFile(file, JSON.stringify({ provider: "kiro" }))
    await expect(readProviderConfig(file)).resolves.toBe("kiro")
  })

  test("reads codex provider", async () => {
    const file = await tempFile()
    await writeFile(file, JSON.stringify({ provider: "codex" }))
    await expect(readProviderConfig(file)).resolves.toBe("codex")
  })

  test("invalid JSON defaults to codex and warns", async () => {
    const warnings = captureWarnings()
    const file = await tempFile()
    await writeFile(file, "not json")

    await expect(readProviderConfig(file)).resolves.toBe("codex")
    expect(warnings.some((message) => message.includes(file))).toBe(true)
  })

  test("unknown provider defaults to codex and warns", async () => {
    const warnings = captureWarnings()
    const file = await tempFile()
    await writeFile(file, JSON.stringify({ provider: "unknown" }))

    await expect(readProviderConfig(file)).resolves.toBe("codex")
    expect(warnings.some((message) => message.includes("unrecognized provider"))).toBe(true)
  })

  test("write updates provider and preserves future fields", async () => {
    const file = await tempFile()
    await writeFile(file, JSON.stringify({ provider: "kiro", futureField: 42 }))

    await writeProviderConfig("codex", file)

    const saved = JSON.parse(await readFile(file, "utf-8"))
    expect(saved).toEqual({ provider: "codex", futureField: 42 })
  })

  test("write creates parent directory", async () => {
    const dir = path.join(await tempDir(), "nested", "config")
    const file = path.join(dir, "provider-config.json")

    await writeProviderConfig("kiro", file)

    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({ provider: "kiro" })
  })

  test("write failure warns and does not throw", async () => {
    const warnings = captureWarnings()
    const dirPath = await tempDir()

    await expect(writeProviderConfig("kiro", dirPath)).resolves.toBeUndefined()
    expect(warnings.some((message) => message.includes("failed to write provider config"))).toBe(true)
  })

  test("resolves provider mode with environment override", () => {
    expect(resolveProviderMode("kiro", "codex")).toBe("kiro")
    expect(resolveProviderMode("codex", "kiro")).toBe("codex")
    expect(resolveProviderMode("anything", "kiro")).toBe("codex")
    expect(resolveProviderMode(undefined, "kiro")).toBe("kiro")
    expect(resolveProviderMode(undefined, undefined)).toBe("codex")
    expect(resolveProviderMode("", "kiro")).toBe("kiro")
  })
})

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "provider-config-test-"))
  tempDirs.push(dir)
  return dir
}

async function tempFile() {
  const dir = await tempDir()
  await mkdir(dir, { recursive: true })
  return path.join(dir, "provider-config.json")
}

function captureWarnings() {
  const warnings: string[] = []
  console.warn = (message?: unknown) => {
    warnings.push(String(message))
  }
  return warnings
}
