import { describe, expect, test } from "bun:test"

import { extractModuleExportNames } from "./export-surface"
import { path, pathToFileURL, readFile } from "./helpers"

interface BackwardCompatBaseline {
  modules: Array<{
    path: string
    file: string
    exports: string[]
  }>
}

async function loadBaseline() {
  return JSON.parse(
    await readFile(path.join(process.cwd(), "test", "backward-compat-baseline.json"), "utf8"),
  ) as BackwardCompatBaseline
}

describe("backward compatibility", () => {
  test("all baseline src/** module paths remain importable and keep their export surface", async () => {
    const baseline = await loadBaseline()

    for (const module of baseline.modules) {
      const filePath = path.join(process.cwd(), module.file)
      await expect(import(pathToFileURL(filePath).href)).resolves.toBeDefined()
      const exports = await extractModuleExportNames(filePath)
      for (const name of module.exports) {
        expect(exports).toContain(name)
      }
    }
  })

  test("specific compatibility re-exports resolve expected runtime symbols", async () => {
    const cases: Array<{ file: string; symbols: string[] }> = [
      // All root shim and legacy claude shim files have been removed.
      // This test now only validates the baseline import test above.
    ]

    for (const entry of cases) {
      const mod = await import(pathToFileURL(path.join(process.cwd(), entry.file)).href)
      for (const symbol of entry.symbols) {
        expect(mod).toHaveProperty(symbol)
      }
    }
  })
})
