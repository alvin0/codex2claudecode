// Property 24 for the `mcp.ts` → `web-search.ts` rename (task 26.3).
//
// The pre-rename export lists below are **recorded literals**, read once out of `git show
// HEAD:src/upstream/kiro/mcp.ts` and `git show HEAD:src/upstream/kiro/index.ts` at the commit
// before the rename. They are deliberately not derived from the current surface: a list computed
// from today's files would make the property assert "the current exports are the current exports",
// which is true of any surface and so proves nothing about the rename. Frozen literals are the only
// form in which this property can fail.
//
// The alias site is `src/upstream/kiro/index.ts` — the barrel re-export the rename had to keep
// working (Requirement 17.2). Two sites are checked because the pre-rename surface had two: the
// module exported eight names, of which the barrel re-exported five. Asserting all eight at the
// barrel would not test the rename, it would widen the surface the rename was supposed to preserve.
//
// Value names are checked by importing the module and looking the name up on the namespace object;
// type-only names have no runtime binding, so they are checked against the static extractor. The
// value arm deliberately does not also use the static extractor: `test/export-surface.ts` matches
// `export function name` but not the generator form `export async function* name`, so
// `maybeHandleKiroServerTool` is invisible to it. That blind spot belongs to the shared extractor, which the backward-compat
// baseline also reads, so it is left alone here rather than widened for one test.
//
// **Validates: Requirements 17.2, 28.5, 28.6**
import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { extractModuleExportNames } from "../../export-surface"
import { exists, path, pathToFileURL, readFile } from "../../helpers"

/** Every name `src/upstream/kiro/mcp.ts` exported at the commit before the rename. */
const PRE_RENAME_MODULE_EXPORTS = [
  "KiroWebSearchExecution",
  "KiroServerToolHandlers",
  "kiroWebSearchTool",
  "extractWebSearchQuery",
  "webSearchSummary",
  "webSearchBlocks",
  "parseMcpWebSearchResults",
  "maybeHandleKiroServerTool",
] as const

/** The subset `src/upstream/kiro/index.ts` re-exported from `./mcp` before the rename. */
const PRE_RENAME_ALIAS_SITE_EXPORTS = [
  "extractWebSearchQuery",
  "kiroWebSearchTool",
  "parseMcpWebSearchResults",
  "webSearchBlocks",
  "webSearchSummary",
] as const

/** Names with no runtime binding — statically visible only. */
const TYPE_ONLY_EXPORTS = new Set<string>(["KiroWebSearchExecution", "KiroServerToolHandlers"])

const MODULE_FILE = path.join(process.cwd(), "src", "upstream", "kiro", "web-search.ts")
const ALIAS_SITE_FILE = path.join(process.cwd(), "src", "upstream", "kiro", "index.ts")

function load(file: string) {
  return import(pathToFileURL(file).href) as Promise<Record<string, unknown>>
}

describe("Kiro web search export surface", () => {
  test("Feature: native-api-mode, Property 24: Deprecated aliases keep the pre-rename export surface — every pre-rename module export resolves from the renamed module", async () => {
    const staticNames = await extractModuleExportNames(MODULE_FILE)
    const namespace = await load(MODULE_FILE)

    fc.assert(fc.property(
      fc.constantFrom(...PRE_RENAME_MODULE_EXPORTS),
      (name) => {
        if (TYPE_ONLY_EXPORTS.has(name)) expect(staticNames).toContain(name)
        else expect(namespace[name]).toBeDefined()
      },
    ), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 24: Deprecated aliases keep the pre-rename export surface — every pre-rename alias-site export resolves from the alias site", async () => {
    const staticNames = await extractModuleExportNames(ALIAS_SITE_FILE)
    const namespace = await load(ALIAS_SITE_FILE)

    fc.assert(fc.property(
      fc.constantFrom(...PRE_RENAME_ALIAS_SITE_EXPORTS),
      (name) => {
        expect(staticNames).toContain(name)
        expect(namespace[name]).toBeDefined()
      },
    ), { numRuns: 200 })
  })

  test("Feature: native-api-mode, Property 24: alias-site resolution agrees with the renamed module for every shared name", async () => {
    const moduleNamespace = await load(MODULE_FILE)
    const aliasNamespace = await load(ALIAS_SITE_FILE)

    fc.assert(fc.property(
      fc.constantFrom(...PRE_RENAME_ALIAS_SITE_EXPORTS),
      (name) => {
        expect(aliasNamespace[name]).toBe(moduleNamespace[name])
      },
    ), { numRuns: 200 })
  })

  test("the rename actually happened and left no old module behind", async () => {
    expect(await exists(MODULE_FILE)).toBe(true)
    expect(await exists(path.join(process.cwd(), "src", "upstream", "kiro", "mcp.ts"))).toBe(false)
  })

  test("the alias site is marked deprecated and sourced from the renamed module", async () => {
    const source = await readFile(ALIAS_SITE_FILE, "utf8")
    const line = source.split("\n").find((candidate) => candidate.includes("parseMcpWebSearchResults") && candidate.startsWith("export {"))
    expect(line).toBeDefined()
    expect(line).toContain("./web-search")

    const docStart = source.lastIndexOf("/**", source.indexOf(line!))
    expect(docStart).toBeGreaterThan(-1)
    expect(source.slice(docStart, source.indexOf(line!))).toContain("@deprecated")
  })

  test("no Kiro module imports the pre-rename path", async () => {
    for (const file of ["index.ts", "client.ts", "parse.ts", "web-search.ts"]) {
      const source = await readFile(path.join(process.cwd(), "src", "upstream", "kiro", file), "utf8")
      expect(source).not.toContain('from "./mcp"')
    }
  })
})
