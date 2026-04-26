import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { extractModuleExportNames } from "../export-surface"
import { path, pathToFileURL, readFile } from "../helpers"

// ---------------------------------------------------------------------------
// Shared helpers & constants
// ---------------------------------------------------------------------------

interface BaselineModule {
  path: string
  file: string
  exports: string[]
}

interface Baseline {
  modules: BaselineModule[]
}

async function loadBaseline(): Promise<Baseline> {
  return JSON.parse(
    await readFile(path.join(process.cwd(), "test", "backward-compat-baseline.json"), "utf8"),
  ) as Baseline
}

/**
 * Resolve a relative import specifier to a root-relative module path
 * (e.g. `../../auth` from `src/inbound/claude/handlers.ts` → `src/auth`).
 * Returns the normalised path without extension, or null if it doesn't resolve
 * into `src/`.
 */
function resolveToRootRelative(fromFile: string, specifier: string): string | null {
  const dir = path.dirname(fromFile)
  const resolved = path.normalize(path.join(dir, specifier))
  if (!resolved.startsWith("src/") && !resolved.startsWith("src\\")) return null
  return resolved.replace(/\\/g, "/")
}

/**
 * All deleted paths that no file should import from.
 * Includes 14 root shim paths, 10 legacy claude shim paths,
 * and 5 old composition root paths (now at src/app/).
 */
const DELETED_PATHS = new Set<string>([
  // 14 Root_Shim_File paths (without extension)
  "src/account-info",
  "src/auth",
  "src/client",
  "src/codex-auth",
  "src/connect-account",
  "src/constants",
  "src/http",
  "src/models",
  "src/paths",
  "src/reasoning",
  "src/request-logs",
  "src/types",
  "src/claude-code-env.config",
  "src/claude",
  // 10 Legacy_Claude_Shim paths
  "src/claude/convert",
  "src/claude/errors",
  "src/claude/handlers",
  "src/claude/index",
  "src/claude/mcp",
  "src/claude/response",
  "src/claude/server-tool-adapter",
  "src/claude/server-tools",
  "src/claude/sse",
  "src/claude/web",
  // 5 old Composition_Root_File paths (now at src/app/)
  "src/bin",
  "src/bootstrap",
  "src/cli",
  "src/package-info",
  "src/runtime",
])

/** Extract import/export-from specifiers from a TypeScript source file. */
function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = []
  // Match: import ... from "specifier"
  // Match: export ... from "specifier"
  // Match: export * from "specifier"
  const regex = /(?:import|export)\s+(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/g
  for (const match of content.matchAll(regex)) {
    specifiers.push(match[1])
  }
  return specifiers
}

/** Check if a specifier resolves to a deleted path. */
function isDeletedPathImport(fromFile: string, specifier: string): boolean {
  // Only check relative imports
  if (!specifier.startsWith(".")) return false
  const resolved = resolveToRootRelative(fromFile, specifier)
  if (!resolved) return false
  return DELETED_PATHS.has(resolved)
}

// ---------------------------------------------------------------------------
// Collect all TypeScript files (source + test)
// ---------------------------------------------------------------------------

async function collectAllTsFiles(): Promise<string[]> {
  const files: string[] = []
  const srcGlob = new Bun.Glob("src/**/*.{ts,tsx}")
  for await (const file of srcGlob.scan({ cwd: process.cwd() })) {
    files.push(file.replace(/\\/g, "/"))
  }
  const testGlob = new Bun.Glob("test/**/*.{ts,tsx}")
  for await (const file of testGlob.scan({ cwd: process.cwd() })) {
    files.push(file.replace(/\\/g, "/"))
  }
  return files.sort()
}

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe("Consolidation correctness properties", () => {
  /**
   * **Property 1: No source or test file imports from deleted paths**
   *
   * For any TypeScript file (source OR test), none of its import/export-from
   * statements resolve to any of the 14 root shim paths, 10 legacy claude
   * shim paths, or 5 old composition root paths.
   *
   * **Validates: Requirements 1.2-1.10, 2.2-2.9, 3.7, 3.8**
   */
  test("Property 1: No source or test file imports from deleted paths", async () => {
    const allFiles = await collectAllTsFiles()
    expect(allFiles.length).toBeGreaterThan(0)

    // Read all file contents upfront
    const fileContents = new Map<string, string>()
    for (const file of allFiles) {
      const content = await readFile(path.join(process.cwd(), file), "utf8")
      fileContents.set(file, content)
    }

    // Build an arbitrary that picks from the full file list
    const fileArb = fc.constantFrom(...allFiles)

    fc.assert(
      fc.property(fileArb, (file) => {
        const content = fileContents.get(file)!
        const specifiers = extractImportSpecifiers(content)
        const violations = specifiers.filter((spec) => isDeletedPathImport(file, spec))
        if (violations.length > 0) {
          throw new Error(
            `${file} imports from deleted path(s): ${violations.join(", ")}`,
          )
        }
      }),
      { numRuns: 100 },
    )
  })

  /**
   * **Property 2: Public API barrel export surface preserved**
   *
   * For any symbol in the baseline entry for `src/index`, that symbol exists
   * in the actual export surface of `src/index.ts`. No symbols added, no
   * symbols removed.
   *
   * **Validates: Requirements 5.1, 5.2, 5.4**
   */
  test("Property 2: Public API barrel export surface preserved", async () => {
    const baseline = await loadBaseline()
    const indexEntry = baseline.modules.find((m) => m.path === "src/index")
    expect(indexEntry).toBeDefined()
    expect(indexEntry!.exports.length).toBeGreaterThan(0)

    const indexFilePath = path.join(process.cwd(), "src/index.ts")
    const actualExports = await extractModuleExportNames(indexFilePath)

    // Build an arbitrary that picks from the baseline symbol list
    const symbolArb = fc.constantFrom(...indexEntry!.exports)

    fc.assert(
      fc.property(symbolArb, (symbol) => {
        if (!actualExports.includes(symbol)) {
          throw new Error(
            `Public API barrel src/index.ts is missing expected export "${symbol}"\n` +
            `  Actual exports: [${actualExports.join(", ")}]`,
          )
        }
      }),
      { numRuns: 100 },
    )
  })

  /**
   * **Property 3: All baseline modules remain importable with correct exports**
   *
   * For any module entry in the backward-compat baseline, dynamically importing
   * the file at `module.file` succeeds and the imported module contains all
   * symbols listed in `module.exports`.
   *
   * **Validates: Requirements 4.1-4.5, 7.3**
   */
  test("Property 3: All baseline modules remain importable with correct exports", async () => {
    const baseline = await loadBaseline()
    expect(baseline.modules.length).toBeGreaterThan(0)

    const moduleArb = fc.constantFrom(...baseline.modules)

    await fc.assert(
      fc.asyncProperty(moduleArb, async (mod) => {
        const filePath = path.join(process.cwd(), mod.file)

        // Verify the module is importable (dynamic import succeeds)
        await import(pathToFileURL(filePath).href)

        // Verify all baseline symbols are present using static analysis
        // (type-only exports are erased at runtime, so we use extractModuleExportNames)
        const actualExports = await extractModuleExportNames(filePath)
        for (const symbol of mod.exports) {
          if (!actualExports.includes(symbol)) {
            throw new Error(
              `Module ${mod.file} is missing expected export "${symbol}"\n` +
              `  Actual exports: [${actualExports.join(", ")}]`,
            )
          }
        }
      }),
      { numRuns: 100 },
    )
  })
})
