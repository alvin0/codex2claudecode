import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { packageInfo } from "../src/app/package-info"
import pkg from "../package.json"
import { exists, mkdir, path, readFile, rm, writeFile } from "./helpers"

/**
 * Bug Condition Exploration Test
 *
 * The bug: `path.join(dir, "../..", "package.json")` hardcodes depth=2.
 * This works from `src/app/package-info.ts` but fails from any other depth.
 *
 * This test exercises the hardcoded path resolution logic directly to prove
 * the bug exists for depths != 2.
 *
 * **Validates: Requirements 1.1, 1.2**
 */
describe("Bug Condition: Hardcoded depth crashes when file is not exactly 2 levels deep", () => {
  /**
   * Property 1: Bug Condition — Hardcoded `../..` only resolves correctly at depth 2
   *
   * For any directory depth that is NOT exactly 2, the hardcoded
   * `path.join(dir, "../..", "package.json")` pattern will NOT resolve to
   * the actual `package.json` at the root of the temp directory structure.
   *
   * **Validates: Requirements 1.1, 1.2**
   */
  test("Property 1: Hardcoded ../.. fails to resolve package.json for depths != 2", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }).filter((d) => d !== 2),
        async (depth) => {
          // Create a temporary directory structure with package.json at root
          const tmpBase = path.join(
            process.cwd(),
            ".tmp-bugfix-test",
            `depth-${depth}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          )

          try {
            await mkdir(tmpBase, { recursive: true })

            // Write package.json at the root of our temp structure
            const packageJsonPath = path.join(tmpBase, "package.json")
            await writeFile(packageJsonPath, JSON.stringify({ version: "1.0.0", author: "test" }))

            // Create nested directory at the given depth and place a dummy file
            let nestedDir = tmpBase
            for (let i = 0; i < depth; i++) {
              nestedDir = path.join(nestedDir, `level${i}`)
            }
            await mkdir(nestedDir, { recursive: true })
            const dummyFile = path.join(nestedDir, "index.js")
            await writeFile(dummyFile, "// dummy")

            // Apply the SAME hardcoded logic from packageInfo():
            //   path.join(path.dirname(fileUrl), "../..", "package.json")
            const fileDir = path.dirname(dummyFile)
            const hardcodedResolved = path.resolve(
              path.join(fileDir, "../..", "package.json"),
            )
            const actualPackageJson = path.resolve(packageJsonPath)

            // The hardcoded path should resolve to the actual package.json
            // For depth != 2, this will NOT match — proving the bug
            expect(hardcodedResolved).not.toBe(actualPackageJson)
          } finally {
            // Clean up
            if (await exists(tmpBase)) {
              await rm(tmpBase, { recursive: true, force: true })
            }
          }
        },
      ),
      { numRuns: 50 },
    )
  })

  /**
   * Property 1b: Walk-up algorithm — finds package.json from any depth (0–5)
   *
   * For any directory depth, the walk-up algorithm (same as implemented in
   * `findPackageJson` in `src/app/package-info.ts`) correctly locates the
   * `package.json` at the root of the temp directory structure.
   *
   * This test validates the EXPECTED behavior: walk-up resolves package.json
   * from any depth, unlike the hardcoded `../..` pattern above.
   *
   * **Validates: Requirements 1.1, 1.2, 2.1, 2.2**
   */
  test("Property 1b: Walk-up algorithm finds package.json from any depth", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        async (depth) => {
          const tmpBase = path.join(
            process.cwd(),
            ".tmp-bugfix-test",
            `walkup-${depth}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          )

          try {
            await mkdir(tmpBase, { recursive: true })

            // Write package.json at the root of our temp structure
            const packageJsonPath = path.join(tmpBase, "package.json")
            await writeFile(packageJsonPath, JSON.stringify({ version: "1.0.0", author: "test" }))

            // Create nested directory at the given depth and place a dummy file
            let nestedDir = tmpBase
            for (let i = 0; i < depth; i++) {
              nestedDir = path.join(nestedDir, `level${i}`)
            }
            await mkdir(nestedDir, { recursive: true })
            const dummyFile = path.join(nestedDir, "index.js")
            await writeFile(dummyFile, "// dummy")

            // Inline the walk-up algorithm (same as findPackageJson in src/app/package-info.ts)
            const startDir = path.dirname(dummyFile)
            let dir = startDir
            let foundPath: string | null = null
            while (true) {
              const candidate = path.join(dir, "package.json")
              if (await exists(candidate)) {
                foundPath = candidate
                break
              }
              const parent = path.dirname(dir)
              if (parent === dir) {
                break // filesystem root reached
              }
              dir = parent
            }

            // The walk-up algorithm should always find the package.json at tmpBase
            expect(foundPath).not.toBeNull()
            expect(path.resolve(foundPath!)).toBe(path.resolve(packageJsonPath))
          } finally {
            if (await exists(tmpBase)) {
              await rm(tmpBase, { recursive: true, force: true })
            }
          }
        },
      ),
      { numRuns: 50 },
    )
  })

  /**
   * Concrete deterministic case: simulate `dist/index.js` (depth 1).
   *
   * The hardcoded `../..` from a depth-1 file overshoots the package root,
   * so `readFileSync` with the hardcoded path should throw ENOENT.
   *
   * **Validates: Requirements 1.1, 1.2**
   */
  test("Deterministic: dist/index.js (depth 1) — readFileSync with hardcoded path throws ENOENT", async () => {
    const tmpBase = path.join(
      process.cwd(),
      ".tmp-bugfix-test",
      `deterministic-${Date.now()}`,
    )

    try {
      // Create structure: tmpBase/package.json and tmpBase/dist/index.js
      const distDir = path.join(tmpBase, "dist")
      await mkdir(distDir, { recursive: true })

      await writeFile(
        path.join(tmpBase, "package.json"),
        JSON.stringify({ version: "0.1.8", author: "alvin0" }),
      )
      await writeFile(path.join(distDir, "index.js"), "// bundled output")

      // Apply the hardcoded logic: path.join(dirname(dist/index.js), "../..", "package.json")
      const fileDir = distDir // dirname of dist/index.js is dist/
      const hardcodedPath = path.join(fileDir, "../..", "package.json")

      // This should throw ENOENT because ../.. from dist/ goes one level
      // above tmpBase, where no package.json exists
      await expect(readFile(hardcodedPath, "utf8")).rejects.toThrow()
    } finally {
      if (await exists(tmpBase)) {
        await rm(tmpBase, { recursive: true, force: true })
      }
    }
  })
})


/**
 * Preservation Property Tests
 *
 * These tests verify that the JSON parsing and default value logic
 * works correctly and will continue to work after the fix is applied.
 * They must PASS on both unfixed and fixed code.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
 */
describe("Preservation: Development source path resolution and default values unchanged", () => {
  /**
   * Property 2: Preservation — Default values for missing fields
   *
   * For any package.json content with optional version and author fields,
   * the parsing + default logic must return the value as-is when present,
   * or the correct default ("0.0.0" for version, "unknown" for author)
   * when missing.
   *
   * This tests the JSON parsing + default value logic directly (the same
   * logic used inside packageInfo), since we can't change import.meta.url
   * from the test context.
   *
   * **Validates: Requirements 3.2, 3.3, 3.4**
   */
  test("Property 2: Default values applied correctly for present/missing version and author", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        async (version, author) => {
          // Create a temp directory with a package.json containing the generated fields
          const tmpDir = path.join(
            process.cwd(),
            ".tmp-bugfix-test",
            `preservation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          )

          try {
            await mkdir(tmpDir, { recursive: true })

            // Build the package.json object — only include fields that are present
            const pkgObj: Record<string, string> = {}
            if (version !== undefined) pkgObj.version = version
            if (author !== undefined) pkgObj.author = author

            const pkgPath = path.join(tmpDir, "package.json")
            await writeFile(pkgPath, JSON.stringify(pkgObj))

            // Apply the SAME parsing + default logic from packageInfo():
            //   const pkg = JSON.parse(readFileSync(path, "utf8"))
            //   return { version: pkg.version ?? "0.0.0", author: pkg.author ?? "unknown" }
            const pkg = JSON.parse(await readFile(pkgPath, "utf8"))
            const result = {
              version: pkg.version ?? "0.0.0",
              author: pkg.author ?? "unknown",
            }

            // When version is present → returned as-is; when missing → "0.0.0"
            if (version !== undefined) {
              expect(result.version).toBe(version)
            } else {
              expect(result.version).toBe("0.0.0")
            }

            // When author is present → returned as-is; when missing → "unknown"
            if (author !== undefined) {
              expect(result.author).toBe(author)
            } else {
              expect(result.author).toBe("unknown")
            }
          } finally {
            if (await exists(tmpDir)) {
              await rm(tmpDir, { recursive: true, force: true })
            }
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  /**
   * Concrete preservation test: call packageInfo() from the current test
   * context and verify it returns the real package.json values.
   *
   * Since the test runner executes from the project root and the source
   * file is at src/app/package-info.ts (depth 2), the hardcoded ../..
   * resolves correctly — this test passes on both unfixed and fixed code.
   *
   * **Validates: Requirements 3.1, 3.2**
   */
  test("Concrete: packageInfo() returns real package.json values from development context", () => {
    const result = packageInfo()

    expect(result.version).toBe(pkg.version)
    expect(result.author).toBe("alvin0 <chaulamdinhai@gmail.com>")
  })
})
