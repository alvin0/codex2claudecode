import { afterEach, describe, expect, test } from "bun:test"
import fc from "fast-check"

import { readProviderConfig, resolveProviderMode, writeProviderConfig, type ProviderMode } from "../../src/app/provider-config"
import { mkdtemp, path, readFile, rm, tmpdir, writeFile } from "../helpers"

const tempDirs: string[] = []
const originalWarn = console.warn

afterEach(async () => {
  console.warn = originalWarn
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("provider config properties", () => {
  test("config round-trip preserves extra fields", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ProviderMode>("codex", "kiro"),
        fc.dictionary(fc.string().filter((key) => key !== "provider"), fc.jsonValue()),
        async (mode, extraFields) => {
          const file = await tempFile()
          await writeFile(file, JSON.stringify({ provider: mode, ...extraFields }))

          await writeProviderConfig(mode, file)

          expect(await readProviderConfig(file)).toBe(mode)
          const saved = JSON.parse(await readFile(file, "utf-8"))
          for (const [key, value] of Object.entries(extraFields)) expect(saved[key]).toEqual(JSON.parse(JSON.stringify(value)))
        },
      ),
    )
  })

  test("invalid provider values default to codex", async () => {
    console.warn = () => {}
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((value) => value !== "codex" && value !== "kiro"),
        async (invalidValue) => {
          const file = await tempFile()
          await writeFile(file, JSON.stringify({ provider: invalidValue }))
          expect(await readProviderConfig(file)).toBe("codex")
        },
      ),
    )
  })

  test("environment variable override takes precedence", () => {
    fc.assert(
      fc.property(fc.constantFrom<ProviderMode | undefined>("codex", "kiro", undefined), fc.string({ minLength: 1 }), (configMode, envVar) => {
        const resolved = resolveProviderMode(envVar, configMode)
        expect(resolved).toBe(envVar === "kiro" ? "kiro" : "codex")
      }),
    )
  })
})

async function tempFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "provider-config-property-test-"))
  tempDirs.push(dir)
  return path.join(dir, "provider-config.json")
}
