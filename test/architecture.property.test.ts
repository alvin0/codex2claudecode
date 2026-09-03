import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { path, readFile } from "./helpers"

/**
 * Architecture boundary invariants — the machine-checkable form of
 * `.kiro/steering/provider-architecture-coding-rules.md`.
 *
 * **Feature: native-api-mode, Property 2: Layer boundaries hold as an
 * import-graph invariant.**
 *
 * For any source file under `src/`, its import specifiers respect every
 * declared edge: files under `src/core/` (including `src/core/mcp/`) reach no
 * `src/inbound/` or `src/upstream/` module, files under `src/inbound/` reach no
 * `src/upstream/` module, files under `src/upstream/` reach no `src/inbound/`
 * module, no internal file imports through `src/index.ts`,
 * `src/core/provider-capabilities.ts` and `src/app/runtime.ts` contain zero
 * occurrences of the four provider identifiers, and the direct file children of
 * `src/` are exactly `index.ts`.
 *
 * **Validates: Requirements 1.5, 2.6, 16.12, 20.7, 27.1, 27.2, 27.3, 27.4,
 * 27.5, 27.7, 29.7**
 *
 * ---
 *
 * How later tasks extend this file — every extension is a table row, not a new
 * block of bespoke logic:
 *
 * - Task 24.3 ("core gained no model-family names", Requirement 16.12) is
 *   {@link CORE_MODEL_FAMILY_BASELINE} plus its own clause below. A
 *   {@link FORBIDDEN_TOKEN_SCOPES} row was the plan and does not fit: that table
 *   asserts *zero* occurrences, and `src/core/reasoning.ts` legitimately contains
 *   one — the pre-existing `gpt-5` pattern, which Requirement 16.11 pins in place.
 *   16.12 is a claim about **gaining** names, so it is a pinned-count comparison
 *   rather than an absence check. It still reuses `countOccurrences` and
 *   `resolveScopeFiles`, and the count may only shrink.
 * - Task 31.6 (`src/core/mcp/`, Requirement 20.7): the import-graph claim was
 *   already covered — the `core-mcp-no-provider` row of {@link BOUNDARY_RULES}
 *   is evaluated by clause 1 and by the transitive clause like every other row,
 *   and `src/core/mcp/` now exists. What 31.6 added is the **non-vacuity guard**
 *   below: a row whose `fromPrefixes` match no file on disk passes for free, so
 *   every row must govern at least one real file.
 * - A new layer boundary is a new {@link BOUNDARY_RULES} row.
 * - A pre-existing violation that gets fixed is a deletion from
 *   {@link PRE_EXISTING_LAYER_EDGES}; the rot guard below makes any stale entry
 *   fail, so the allowlist can only shrink.
 */

// ---------------------------------------------------------------------------
// Rule tables — the data every clause is driven from
// ---------------------------------------------------------------------------

interface BoundaryRule {
  /** Stable id used in failure messages and in the allowlist. */
  id: string
  /** Requirement acceptance criteria this row enforces. */
  requirement: string
  /** A source file is governed by this rule when it starts with one of these. */
  fromPrefixes: readonly string[]
  /** The resolved target of an import must not start with any of these. */
  forbiddenPrefixes: readonly string[]
}

const BOUNDARY_RULES: readonly BoundaryRule[] = [
  {
    id: "core-no-provider",
    requirement: "27.2, 2.6",
    fromPrefixes: ["src/core/"],
    forbiddenPrefixes: ["src/inbound/", "src/upstream/"],
  },
  {
    // Implied by `core-no-provider`, stated separately because Requirement 20.7
    // is a claim about `src/core/mcp/` specifically: the provider-agnostic MCP
    // client imports zero modules from `src/upstream/` and zero from
    // `src/inbound/`. Naming it keeps the failure message point at 20.7, and the
    // non-vacuity guard below keeps the row from passing on an empty directory.
    id: "core-mcp-no-provider",
    requirement: "20.7",
    fromPrefixes: ["src/core/mcp/"],
    forbiddenPrefixes: ["src/inbound/", "src/upstream/"],
  },
  {
    id: "inbound-no-upstream",
    requirement: "27.3",
    fromPrefixes: ["src/inbound/"],
    forbiddenPrefixes: ["src/upstream/"],
  },
  {
    id: "upstream-no-inbound",
    requirement: "27.4",
    fromPrefixes: ["src/upstream/"],
    forbiddenPrefixes: ["src/inbound/"],
  },
]

/** The public package barrel. No internal file may import through it (27.7). */
const PUBLIC_BARREL = "src/index.ts"

/** The only permitted direct file child of `src/` (27.1). */
const PERMITTED_SRC_ROOT_FILES: readonly string[] = ["index.ts"]

/** The four provider identifiers (Requirements 1.5, 27.5). */
const PROVIDER_IDENTIFIERS: readonly string[] = ["kiro", "codex", "copilot", "claude"]

interface ForbiddenTokenScope {
  /** Stable id used in failure messages. */
  id: string
  requirement: string
  /** Root-relative file paths, or `Bun.Glob` patterns, that must be token-free. */
  files: readonly string[]
  /** Lowercase tokens that must not occur. */
  tokens: readonly string[]
  /**
   * Pre-existing occurrences that differ from the token only by case, permitted
   * because Requirements 1.5 and 27.5 are verified case-sensitively against the
   * lowercase identifiers (see the `Architecture_Check` command set in
   * design.md). Each literal is removed from the text before the stricter
   * case-insensitive pass runs, and each is rot-guarded: a literal that no
   * longer occurs fails the test rather than silently widening the exemption.
   */
  allowedCaseVariantLiterals: readonly string[]
}

const FORBIDDEN_TOKEN_SCOPES: readonly ForbiddenTokenScope[] = [
  {
    id: "core-capabilities-provider-agnostic",
    requirement: "1.5",
    files: ["src/core/provider-capabilities.ts"],
    tokens: PROVIDER_IDENTIFIERS,
    allowedCaseVariantLiterals: [],
  },
  {
    id: "runtime-provider-agnostic",
    requirement: "27.5",
    files: ["src/app/runtime.ts"],
    tokens: PROVIDER_IDENTIFIERS,
    // Pre-existing console banner text, not provider coupling: the product name
    // and the two route-banner labels. Nothing in native-api-mode may edit
    // `src/app/runtime.ts` (Requirement 27.5), so these stay.
    allowedCaseVariantLiterals: ["Codex2ClaudeCode", "Claude messages:", "Claude tokens:"],
  },
]

/**
 * Model-family names that must not spread into `src/core/` (Requirement 16.12).
 *
 * These are *model families*, not the four provider identifiers of
 * {@link PROVIDER_IDENTIFIERS}: `src/core/` legitimately names providers in a
 * dozen places (`UpstreamProviderKind`, `ProviderMode`, the debug bundle), and
 * Requirements 1.5 and 27.5 scope the provider-name ban to two specific files.
 * What 16.12 forbids is core learning that a *model* is called `claude-sonnet-5`
 * or `gemini-2.5` — because a core module that recognizes a model name has taken
 * over work belonging to the upstream layer that owns the model enum
 * (Requirement 16.10).
 *
 * Hyphens are deliberate where the bare word would be ambiguous: `claude-` is a
 * model prefix, while `claude` alone matches `src/inbound/claude/` in a comment.
 */
const CORE_MODEL_FAMILY_TOKENS: readonly string[] = [
  "gpt-3",
  "gpt-4",
  "gpt-5",
  "o1-",
  "o3-",
  "o4-",
  "claude-",
  "sonnet",
  "haiku",
  "opus",
  "gemini",
  "llama",
  "qwen",
  "deepseek",
  "mistral",
  "grok",
  "nova-",
  "titan",
  "amazon-q",
  "command-r",
  "kimi",
  "glm-",
  "minimax",
]

/** Every `src/core/` file, for the model-family count. */
const CORE_SCOPE: readonly string[] = ["src/core/**/*.ts"]

/**
 * The pinned model-family occurrence count across all of `src/core/`, per token,
 * counted case-insensitively. Absent means zero.
 *
 * One entry, and it is the whole of core's model knowledge: the `gpt-5` alternative
 * inside `REASONING_MODEL_PATTERN` in `src/core/reasoning.ts`. Requirement 16.11
 * keeps that behavior unchanged, so the count is 1 rather than 0; Requirement 16.12
 * is that it never becomes 2. A new family is handled in
 * `src/upstream/kiro/effort.ts`, where the level enum lives.
 *
 * The baseline may only **shrink**: the clause below fails on a count above the
 * pin, and separately on a pinned token that no longer occurs, so a deleted
 * occurrence forces a deliberate edit here instead of quietly widening the budget.
 */
const CORE_MODEL_FAMILY_BASELINE: Readonly<Record<string, number>> = {
  "gpt-5": 1,
}

/** Where each pinned occurrence is allowed to live, so it cannot migrate silently. */
const CORE_MODEL_FAMILY_BASELINE_FILES: Readonly<Record<string, readonly string[]>> = {
  "gpt-5": ["src/core/reasoning.ts"],
}

interface KnownLayerEdge {
  /** The {@link BoundaryRule} id this edge violates. */
  rule: string
  /** Root-relative path of the importing file. */
  from: string
  /** The specifier exactly as written in the source. */
  specifier: string
  /** Root-relative path the specifier resolves to. */
  to: string
  /** Why it is still here and what removing it takes. */
  note: string
}

/**
 * Pre-existing layer violations, enumerated. Every one predates
 * native-api-mode: `src/` was provably untouched through tasks 1–4, and this
 * task may not modify `src/`.
 *
 * These are recorded rather than suppressed. The clause still fails on any edge
 * that is not on this list, so a newly introduced violation is caught, and the
 * rot guard below fails on any entry that no longer describes a real edge — so
 * the list can only shrink.
 *
 * No task in native-api-mode removes any of them: none of these files appear in
 * that plan's file table. Removal is separate work — `canonicalToCodexBody()`
 * and the Codex response parsers would have to be reached through a core seam
 * or composed in `src/app/` instead of imported from `src/inbound/`.
 */
const PRE_EXISTING_LAYER_EDGES: readonly KnownLayerEdge[] = [
  {
    rule: "inbound-no-upstream",
    from: "src/inbound/claude/codex-convert.ts",
    specifier: "../../upstream/codex/parse",
    to: "src/upstream/codex/parse.ts",
    note:
      "Claude→Responses body conversion calls canonicalToCodexBody() directly. " +
      "Removing it means routing canonical→wire construction through the upstream provider " +
      "interface instead of importing the Codex module. Not scheduled by native-api-mode.",
  },
  {
    rule: "inbound-no-upstream",
    from: "src/inbound/claude/codex.ts",
    specifier: "../../upstream/codex/parse",
    to: "src/upstream/codex/parse.ts",
    note:
      "The Claude-over-Codex composite provider consumes collectCodexResponse()/streamCodexResponse() " +
      "instead of a canonical result type. Not scheduled by native-api-mode.",
  },
  {
    rule: "inbound-no-upstream",
    from: "src/inbound/claude/codex.ts",
    specifier: "../../upstream/codex/client",
    to: "src/upstream/codex/client.ts",
    note:
      "Type-only import of CodexStandaloneClient. Removing it means the composite provider " +
      "depends on a core interface rather than the concrete client type. Not scheduled by native-api-mode.",
  },
  {
    rule: "inbound-no-upstream",
    from: "src/inbound/client.ts",
    specifier: "../upstream/codex/client",
    to: "src/upstream/codex/client.ts",
    note:
      "Orphaned re-export shim: no file under src/, test/, or scripts/ imports src/inbound/client.ts, " +
      "and it is absent from test/backward-compat-baseline.json. Deleting the file removes this edge. " +
      "Not scheduled by native-api-mode.",
  },
]

// ---------------------------------------------------------------------------
// Import-graph construction
// ---------------------------------------------------------------------------

export interface ImportEdge {
  /** Root-relative path of the importing file. */
  from: string
  /** The specifier exactly as written in the source. */
  specifier: string
  /** Root-relative path the specifier resolves to. */
  to: string
}

/**
 * Every specifier form that creates a module edge: `import ... from`,
 * `export ... from`, `export * from`, side-effect `import "x"`, dynamic
 * `import("x")`, and `require("x")`.
 */
const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g

/** Extract every module specifier written in a TypeScript source file. */
export function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = []
  for (const match of content.matchAll(SPECIFIER_PATTERN)) specifiers.push(match[1])
  return specifiers
}

/**
 * Resolve a relative specifier the way the TypeScript/Bun resolver does, against
 * the set of files that actually exist.
 *
 * A naive substring test on `"upstream/"` is wrong in both directions: it misses
 * `../../upstream/codex/parse` reached through a differently spelled path and it
 * fires on the string `"upstream/"` inside a test assertion. Resolution against
 * the real file set fixes both.
 *
 * Extensionless directory specifiers resolve to that directory's own
 * `index.ts` — `from "./index"` inside `src/inbound/claude/` resolves to
 * `src/inbound/claude/index.ts`, **not** to the `src/index.ts` barrel. Five such
 * imports exist today and all are legitimate.
 *
 * Returns null for bare specifiers (`node:fs`, `react`), for non-code targets
 * (`../../package.json`), and for relative specifiers that resolve to no
 * existing file. That last case loses no coverage: an import of a nonexistent
 * module is a type error, and `bun run typecheck` owns it.
 */
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  existingFiles: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null
  const base = normalizeSlashes(path.join(path.dirname(fromFile), specifier))
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  for (const candidate of candidates) {
    if (/\.(ts|tsx)$/.test(candidate) && existingFiles.has(candidate)) return candidate
  }
  return null
}

function normalizeSlashes(value: string): string {
  return path.normalize(value).replace(/\\/g, "/")
}

/**
 * The extensionless relative specifier that `fromFile` would write to reach
 * `toFile`. Used to synthesize specifiers in the detector-correctness property.
 */
function toRelativeSpecifier(fromFile: string, toFile: string): string {
  const fromDir = normalizeSlashes(path.dirname(fromFile)).split("/")
  const target = normalizeSlashes(toFile).split("/")
  let shared = 0
  while (shared < fromDir.length && shared < target.length && fromDir[shared] === target[shared]) shared += 1
  const ups = fromDir.length - shared
  const rest = target.slice(shared).join("/")
  const prefix = ups === 0 ? "./" : "../".repeat(ups)
  return `${prefix}${rest}`.replace(/\.tsx?$/, "")
}

async function scanFiles(pattern: string, cwd: string): Promise<string[]> {
  const files: string[] = []
  for await (const file of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true })) {
    files.push(normalizeSlashes(file))
  }
  return files.sort()
}

/** Every TypeScript file under `src/` and `test/`, root-relative and sorted. */
async function collectTsFiles(): Promise<string[]> {
  const root = process.cwd()
  return [
    ...(await scanFiles("src/**/*.{ts,tsx}", root)),
    ...(await scanFiles("test/**/*.{ts,tsx}", root)),
  ].sort()
}

interface ImportGraph {
  files: readonly string[]
  contents: ReadonlyMap<string, string>
  edges: readonly ImportEdge[]
}

let graphPromise: Promise<ImportGraph> | undefined

/** Build the whole graph once; every clause below reads the same snapshot. */
export async function loadImportGraph(): Promise<ImportGraph> {
  graphPromise ??= (async () => {
    const files = await collectTsFiles()
    const existing = new Set(files)
    const contents = new Map<string, string>()
    const edges: ImportEdge[] = []
    for (const file of files) {
      const content = await readFile(path.join(process.cwd(), file), "utf8")
      contents.set(file, content)
      for (const specifier of extractImportSpecifiers(content)) {
        const to = resolveSpecifier(file, specifier, existing)
        if (to) edges.push({ from: file, specifier, to })
      }
    }
    return { files, contents, edges }
  })()
  return graphPromise
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

function hasPrefix(file: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => file.startsWith(prefix))
}

/** True when this edge crosses the boundary the rule forbids. */
export function violatesRule(edge: ImportEdge, rule: BoundaryRule): boolean {
  return hasPrefix(edge.from, rule.fromPrefixes) && hasPrefix(edge.to, rule.forbiddenPrefixes)
}

function edgeKey(edge: { from: string; specifier: string; to: string }): string {
  return `${edge.from} --"${edge.specifier}"--> ${edge.to}`
}

const ALLOWED_EDGE_KEYS = new Set(PRE_EXISTING_LAYER_EDGES.map(edgeKey))

/**
 * Every boundary-crossing edge in the graph, whether allowlisted or not.
 * Returned in graph order so failure messages are stable.
 */
export function findBoundaryViolations(
  edges: readonly ImportEdge[],
): Array<{ rule: BoundaryRule; edge: ImportEdge }> {
  const violations: Array<{ rule: BoundaryRule; edge: ImportEdge }> = []
  for (const edge of edges) {
    for (const rule of BOUNDARY_RULES) {
      if (violatesRule(edge, rule)) violations.push({ rule, edge })
    }
  }
  return violations
}

/**
 * Adjacency over `src/` only, with the allowlisted edges cut. Reachability over
 * this graph proves that the only path from a governed file across a forbidden
 * boundary is an enumerated pre-existing edge — so an indirect new violation
 * (say `src/inbound/x.ts` → `src/app/y.ts` → `src/upstream/z.ts`) fails too.
 */
function buildCutAdjacency(edges: readonly ImportEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (!edge.from.startsWith("src/") || !edge.to.startsWith("src/")) continue
    if (ALLOWED_EDGE_KEYS.has(edgeKey(edge))) continue
    const list = adjacency.get(edge.from)
    if (list) list.push(edge.to)
    else adjacency.set(edge.from, [edge.to])
  }
  return adjacency
}

function reachableFrom(start: string, adjacency: ReadonlyMap<string, string[]>): Set<string> {
  const seen = new Set<string>()
  const stack = [start]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(next)
    }
  }
  return seen
}

/**
 * Check `check` against every member of a closed finite set.
 *
 * The exhaustive loop is the assertion: the files on disk are a closed finite
 * set, so enumerating all of them is strictly stronger than sampling. The
 * fast-check pass over the same set follows the repo convention of at least 100
 * iterations per property and shrinks to a minimal counterexample.
 */
function assertForEvery<T>(items: readonly T[], check: (item: T) => void): void {
  for (const item of items) check(item)
  if (items.length === 0) return
  fc.assert(
    fc.property(fc.constantFrom(...items), (item) => {
      check(item)
    }),
    { numRuns: 100 },
  )
}

// ---------------------------------------------------------------------------
// Forbidden-token scopes
// ---------------------------------------------------------------------------

function stripLiterals(content: string, literals: readonly string[]): string {
  let stripped = content
  for (const literal of literals) stripped = stripped.split(literal).join("")
  return stripped
}

export function countOccurrences(content: string, token: string, caseInsensitive: boolean): number {
  const haystack = caseInsensitive ? content.toLowerCase() : content
  const needle = caseInsensitive ? token.toLowerCase() : token
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

async function resolveScopeFiles(scope: ForbiddenTokenScope): Promise<string[]> {
  const files: string[] = []
  for (const entry of scope.files) {
    if (entry.includes("*")) files.push(...(await scanFiles(entry, process.cwd())))
    else files.push(entry)
  }
  return files.sort()
}

// ---------------------------------------------------------------------------
// Property 2
// ---------------------------------------------------------------------------

describe("Architecture boundary invariants", () => {
  /**
   * Clause 1 — core reaches no provider, inbound reaches no upstream, upstream
   * reaches no inbound. Exhaustive over every edge of the real graph.
   *
   * **Validates: Requirements 2.6, 20.7, 27.2, 27.3, 27.4, 29.7**
   */
  test("Feature: native-api-mode, Property 2: no source file crosses a declared layer boundary", async () => {
    const { edges } = await loadImportGraph()
    expect(edges.length).toBeGreaterThan(0)

    const violations = findBoundaryViolations(edges)
    const unexpected = violations.filter(({ edge }) => !ALLOWED_EDGE_KEYS.has(edgeKey(edge)))

    // Every boundary-crossing edge must be an enumerated pre-existing one.
    assertForEvery(violations, ({ rule, edge }) => {
      if (!ALLOWED_EDGE_KEYS.has(edgeKey(edge))) {
        throw new Error(
          `Layer boundary violation (${rule.id}, Requirement ${rule.requirement}):\n` +
            `  ${edgeKey(edge)}\n` +
            `  Move the logic to its owning directory instead of adding an allowlist entry.\n` +
            `  All ${unexpected.length} new violation(s):\n` +
            unexpected.map(({ edge: bad }) => `    ${edgeKey(bad)}`).join("\n"),
        )
      }
    })

    expect(unexpected.map(({ edge }) => edgeKey(edge))).toEqual([])
    // The allowlist may only shrink.
    expect(violations.length).toBeLessThanOrEqual(PRE_EXISTING_LAYER_EDGES.length)
  })

  /**
   * Clause 1, non-vacuity — every {@link BOUNDARY_RULES} row governs at least one
   * real file, and every row's forbidden side is a directory that exists.
   *
   * Clause 1 above quantifies over the edges that exist, so a row whose
   * `fromPrefixes` match nothing passes for free. That is exactly what
   * `core-mcp-no-provider` did before `src/core/mcp/` was created: the row read
   * as an enforced invariant while proving nothing. This clause makes the
   * distinction observable — if `src/core/mcp/` were deleted or renamed, the row
   * would fail here instead of going quietly green.
   *
   * `src/core/mcp/` is additionally required to hold the client module by name,
   * since a directory containing only a type file would satisfy a bare
   * "non-empty" check while the import-graph claim of Requirement 20.7 went
   * untested.
   *
   * **Validates: Requirement 20.7**
   */
  test("Feature: native-api-mode, Property 2: every boundary rule governs at least one real file", async () => {
    const { files } = await loadImportGraph()

    assertForEvery(BOUNDARY_RULES, (rule) => {
      const governed = files.filter((file) => hasPrefix(file, rule.fromPrefixes))
      if (governed.length === 0) {
        throw new Error(
          `Boundary rule "${rule.id}" (Requirement ${rule.requirement}) governs no file: ` +
            `none of ${rule.fromPrefixes.join(", ")} exists.\n` +
            `  A rule over an empty prefix passes vacuously. Fix the prefix or delete the row.`,
        )
      }
      for (const forbidden of rule.forbiddenPrefixes) {
        if (!files.some((file) => file.startsWith(forbidden))) {
          throw new Error(
            `Boundary rule "${rule.id}" forbids "${forbidden}", which matches no file — ` +
              `nothing could violate it.`,
          )
        }
      }
    })

    // Requirement 20.7's subject, spelled out: the core MCP directory and the
    // module whose import graph the claim is about.
    const mcpFiles = files.filter((file) => file.startsWith("src/core/mcp/"))
    expect(mcpFiles).toContain("src/core/mcp/client.ts")
    expect(mcpFiles.length).toBeGreaterThan(1)

    // And it really does import nothing from either provider layer — asserted
    // directly here, not only as an absence in the aggregate edge list.
    const { edges } = await loadImportGraph()
    const mcpOut = edges.filter((edge) => edge.from.startsWith("src/core/mcp/"))
    expect(mcpOut.length).toBeGreaterThan(0)
    expect(
      mcpOut.filter((edge) => edge.to.startsWith("src/upstream/") || edge.to.startsWith("src/inbound/")).map(edgeKey),
    ).toEqual([])
  })

  /**
   * Rot guard — every allowlist entry still describes a real edge. Once a
   * pre-existing violation is fixed, its entry must be deleted, so the
   * allowlist cannot outlive the debt it documents.
   */
  test("Feature: native-api-mode, Property 2: the pre-existing-edge allowlist contains no stale entry", async () => {
    const { edges } = await loadImportGraph()
    const actual = new Set(findBoundaryViolations(edges).map(({ edge }) => edgeKey(edge)))
    // No duplicate entries: one exemption per real edge.
    expect(ALLOWED_EDGE_KEYS.size).toBe(PRE_EXISTING_LAYER_EDGES.length)

    assertForEvery(PRE_EXISTING_LAYER_EDGES, (entry) => {
      if (!actual.has(edgeKey(entry))) {
        throw new Error(
          `Stale allowlist entry: ${edgeKey(entry)} is no longer a violating edge.\n` +
            `  Delete it from PRE_EXISTING_LAYER_EDGES — the allowlist may only shrink.`,
        )
      }
      if (!BOUNDARY_RULES.some((rule) => rule.id === entry.rule)) {
        throw new Error(`Allowlist entry names unknown rule "${entry.rule}"`)
      }
      expect(entry.note.length).toBeGreaterThan(0)
    })
  })

  /**
   * Clause 1, transitive form — "reach" means reach. With the enumerated edges
   * cut, no governed file reaches a forbidden module by any path, so an
   * indirect violation routed through `src/app/` or `src/ui/` fails as well.
   *
   * **Validates: Requirements 2.6, 20.7, 27.2, 27.3, 27.4**
   */
  test("Feature: native-api-mode, Property 2: no source file transitively reaches across a boundary", async () => {
    const { files, edges } = await loadImportGraph()
    const adjacency = buildCutAdjacency(edges)

    const governed = BOUNDARY_RULES.flatMap((rule) =>
      files.filter((file) => hasPrefix(file, rule.fromPrefixes)).map((file) => ({ rule, file })),
    )

    assertForEvery(governed, ({ rule, file }) => {
      const reached = [...reachableFrom(file, adjacency)].filter((target) =>
        hasPrefix(target, rule.forbiddenPrefixes),
      )
      if (reached.length > 0) {
        throw new Error(
          `Transitive layer boundary violation (${rule.id}, Requirement ${rule.requirement}):\n` +
            `  ${file} reaches ${reached.sort().join(", ")}`,
        )
      }
    })
  })

  /**
   * Clause 2 — no internal file imports through the public barrel. Exhaustive
   * over every file under `src/` and `test/`.
   *
   * **Validates: Requirement 27.7**
   */
  test("Feature: native-api-mode, Property 2: no internal file imports through src/index.ts", async () => {
    const { edges } = await loadImportGraph()

    assertForEvery(edges, (edge) => {
      if (edge.to === PUBLIC_BARREL && edge.from !== PUBLIC_BARREL) {
        throw new Error(
          `${edge.from} imports through the public barrel (Requirement 27.7): "${edge.specifier}".\n` +
            `  Import from the directory that owns the logic instead.`,
        )
      }
    })
  })

  /**
   * Clause 2, resolver correctness — `from "./index"` inside a provider
   * directory resolves to that directory's own `index.ts`, never to the barrel.
   * Generated rather than enumerated: this proves the resolver classifies **any**
   * such specifier correctly, not just the five that exist today.
   *
   * **Validates: Requirement 27.7**
   */
  test("Feature: native-api-mode, Property 2: a directory-local index specifier never resolves to the barrel", async () => {
    const { files } = await loadImportGraph()
    const existing = new Set(files)
    const dirsWithIndex = [...new Set(files.filter((f) => f.endsWith("/index.ts")).map((f) => path.dirname(f)))]
      .filter((dir) => dir !== "src")
      .sort()
    expect(dirsWithIndex.length).toBeGreaterThan(0)

    fc.assert(
      fc.property(
        fc.constantFrom(...dirsWithIndex),
        fc.constantFrom("./index", "./index.ts", "."),
        (dir, specifier) => {
          const from = `${dir}/probe.ts`
          const resolved = resolveSpecifier(from, specifier, new Set([...existing, from]))
          if (specifier === ".") {
            // A bare "." resolves to the directory's own index, or to nothing.
            expect(resolved === null || resolved === `${dir}/index.ts`).toBe(true)
            return
          }
          expect(resolved).toBe(`${dir}/index.ts`)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * Detector correctness — a *synthesized* forbidden edge is always flagged, and
   * a synthesized legal edge to `src/core/` never is. Without this, a clause
   * that passes proves nothing about whether it can fail.
   *
   * **Validates: Requirements 27.2, 27.3, 27.4**
   */
  test("Feature: native-api-mode, Property 2: the detector flags any synthesized boundary-crossing specifier", async () => {
    const { files } = await loadImportGraph()
    const existing = new Set(files)
    const inbound = files.filter((f) => f.startsWith("src/inbound/"))
    const upstream = files.filter((f) => f.startsWith("src/upstream/"))
    const core = files.filter((f) => f.startsWith("src/core/"))
    expect(Math.min(inbound.length, upstream.length, core.length)).toBeGreaterThan(0)

    fc.assert(
      fc.property(
        fc.constantFrom(...inbound),
        fc.constantFrom(...upstream),
        fc.constantFrom(...core),
        (from, forbiddenTarget, legalTarget) => {
          const forbidden = toRelativeSpecifier(from, forbiddenTarget)
          const resolvedForbidden = resolveSpecifier(from, forbidden, existing)
          expect(resolvedForbidden).toBe(forbiddenTarget)
          const synthesized: ImportEdge = { from, specifier: forbidden, to: resolvedForbidden! }
          // A generated pair may coincide with one of the four enumerated
          // pre-existing edges; those are exempt by construction, so skip them.
          fc.pre(!ALLOWED_EDGE_KEYS.has(edgeKey(synthesized)))
          const flagged = findBoundaryViolations([synthesized])
          expect(flagged.map(({ rule }) => rule.id)).toContain("inbound-no-upstream")

          const legal = toRelativeSpecifier(from, legalTarget)
          const resolvedLegal = resolveSpecifier(from, legal, existing)
          expect(resolvedLegal).toBe(legalTarget)
          expect(findBoundaryViolations([{ from, specifier: legal, to: resolvedLegal! }])).toEqual([])
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * Clause 3 — `src/core/provider-capabilities.ts` and `src/app/runtime.ts`
   * contain zero occurrences of `kiro`, `codex`, `copilot`, `claude`.
   *
   * Two passes. The first is the requirement's own verification, case-sensitive
   * against the lowercase identifiers. The second is stricter: with the
   * enumerated pre-existing banner literals removed, a case-insensitive search
   * must also find nothing — that is what catches a new `Kiro_Upstream_Provider`
   * or `CODEX_CAPABILITIES` reference, which the lowercase pass would miss.
   *
   * **Validates: Requirements 1.5, 27.5**
   */
  test("Feature: native-api-mode, Property 2: provider-agnostic files contain no provider identifier", async () => {
    const scopeFiles: Array<{ scope: ForbiddenTokenScope; file: string; content: string }> = []
    for (const scope of FORBIDDEN_TOKEN_SCOPES) {
      for (const file of await resolveScopeFiles(scope)) {
        scopeFiles.push({
          scope,
          file,
          content: await readFile(path.join(process.cwd(), file), "utf8"),
        })
      }
    }
    expect(scopeFiles.length).toBe(2)

    const cases = scopeFiles.flatMap(({ scope, file, content }) =>
      scope.tokens.map((token) => ({ scope, file, content, token })),
    )

    assertForEvery(cases, ({ scope, file, content, token }) => {
      const exact = countOccurrences(content, token, false)
      if (exact > 0) {
        throw new Error(
          `${file} contains ${exact} occurrence(s) of "${token}" ` +
            `(${scope.id}, Requirement ${scope.requirement}).`,
        )
      }
      const stripped = stripLiterals(content, scope.allowedCaseVariantLiterals)
      const loose = countOccurrences(stripped, token, true)
      if (loose > 0) {
        throw new Error(
          `${file} contains ${loose} case-variant occurrence(s) of "${token}" ` +
            `(${scope.id}, Requirement ${scope.requirement}).\n` +
            `  Provider-specific naming belongs in src/inbound/<provider>/ or src/upstream/<provider>/.`,
        )
      }
    })

    // Rot guard: an exemption whose literal is gone must be deleted, not kept.
    assertForEvery(scopeFiles, ({ scope, file, content }) => {
      for (const literal of scope.allowedCaseVariantLiterals) {
        if (!content.includes(literal)) {
          throw new Error(
            `Stale exemption: ${file} no longer contains the literal "${literal}".\n` +
              `  Delete it from allowedCaseVariantLiterals for scope "${scope.id}".`,
          )
        }
      }
    })
  })

  /**
   * Clause 3b — `src/core/` has gained zero additional model-family names.
   *
   * The grep-based check Requirement 16.12 asks for, phrased as a comparison
   * against {@link CORE_MODEL_FAMILY_BASELINE} rather than as an absence, because
   * core's one pre-existing `gpt-5` pattern must stay (Requirement 16.11) while
   * nothing may join it. Three assertions, and each fails for a different reason:
   *
   *  - a count **above** the pin — a model family leaked into core;
   *  - a pinned token in an **unexpected file** — the same count, relocated, which
   *    a total-only check would miss;
   *  - a pinned token that no longer occurs — a stale pin, so the budget can only
   *    shrink.
   *
   * Counting is case-insensitive, which is stricter than the requirement's grep and
   * catches a `GPT_5_MODELS` constant the lowercase pass would not.
   *
   * **Validates: Requirement 16.12**
   */
  test("Feature: native-api-mode, Property 2: src/core/ gained no additional model-family name", async () => {
    const coreFiles = await resolveScopeFiles({
      id: "core-model-family-free",
      requirement: "16.12",
      files: CORE_SCOPE,
      tokens: CORE_MODEL_FAMILY_TOKENS,
      allowedCaseVariantLiterals: [],
    })
    // Non-vacuity: a glob matching nothing would pass every assertion below.
    expect(coreFiles.length).toBeGreaterThan(10)
    expect(coreFiles).toContain("src/core/reasoning.ts")
    expect(CORE_MODEL_FAMILY_TOKENS.length).toBeGreaterThan(0)

    const contents = new Map<string, string>()
    for (const file of coreFiles) contents.set(file, await readFile(path.join(process.cwd(), file), "utf8"))

    const cases = CORE_MODEL_FAMILY_TOKENS.flatMap((token) => coreFiles.map((file) => ({ token, file })))

    // Per-file: only the pinned locations may contain a pinned token, and nothing
    // else may contain any token at all.
    assertForEvery(cases, ({ token, file }) => {
      const count = countOccurrences(contents.get(file)!, token, true)
      if (count === 0) return
      const permitted = CORE_MODEL_FAMILY_BASELINE_FILES[token] ?? []
      if (!permitted.includes(file)) {
        throw new Error(
          `${file} contains ${count} occurrence(s) of the model-family name "${token}" ` +
            `(Requirement 16.12).\n` +
            `  src/core/ must not learn model names. Resolve the model in the upstream layer that ` +
            `owns the model enum (src/upstream/<provider>/), e.g. parseModelEffortSuffix() in ` +
            `src/upstream/kiro/effort.ts.`,
        )
      }
    })

    // Totals: at or below the pin, for every token.
    assertForEvery(CORE_MODEL_FAMILY_TOKENS, (token) => {
      const total = coreFiles.reduce((sum, file) => sum + countOccurrences(contents.get(file)!, token, true), 0)
      const pinned = CORE_MODEL_FAMILY_BASELINE[token] ?? 0
      if (total > pinned) {
        throw new Error(
          `src/core/ now contains ${total} occurrence(s) of "${token}", up from the pinned ${pinned} ` +
            `(Requirement 16.12).\n` +
            `  Do not raise the pin. Move the model-specific knowledge upstream instead.`,
        )
      }
    })

    // Rot guard: a pin that describes nothing must be deleted, not kept.
    assertForEvery(Object.keys(CORE_MODEL_FAMILY_BASELINE), (token) => {
      expect(CORE_MODEL_FAMILY_TOKENS).toContain(token)
      const total = coreFiles.reduce((sum, file) => sum + countOccurrences(contents.get(file)!, token, true), 0)
      if (total !== CORE_MODEL_FAMILY_BASELINE[token]) {
        throw new Error(
          `Stale model-family pin: "${token}" is pinned at ${CORE_MODEL_FAMILY_BASELINE[token]} but ` +
            `occurs ${total} time(s) in src/core/.\n` +
            `  Lower or delete the entry in CORE_MODEL_FAMILY_BASELINE — it may only shrink.`,
        )
      }
      for (const file of CORE_MODEL_FAMILY_BASELINE_FILES[token] ?? []) {
        expect(coreFiles).toContain(file)
      }
    })

    // Detector correctness: each token really is findable, so a green result above
    // means absence rather than a broken search.
    fc.assert(
      fc.property(fc.constantFrom(...CORE_MODEL_FAMILY_TOKENS), (token) => {
        expect(countOccurrences(`prefix ${token.toUpperCase()} suffix`, token, true)).toBe(1)
        expect(countOccurrences("nothing to find here", token, true)).toBe(0)
      }),
      { numRuns: 100 },
    )
  })

  /**
   * Clause 4 — the direct file children of `src/` are exactly `index.ts`.
   * Equivalent to `find src -maxdepth 1 -type f ! -name index.ts` returning
   * nothing. Dotfiles are excluded: they are not source files.
   *
   * **Validates: Requirement 27.1**
   */
  test("Feature: native-api-mode, Property 2: the direct file children of src/ are exactly index.ts", async () => {
    const rootFiles = await scanFiles("*", path.join(process.cwd(), "src"))
    expect(rootFiles).toEqual([...PERMITTED_SRC_ROOT_FILES])

    assertForEvery(rootFiles, (file) => {
      if (!PERMITTED_SRC_ROOT_FILES.includes(file)) {
        throw new Error(
          `src/${file} is a new direct file child of src/ (Requirement 27.1).\n` +
            `  Place it in src/core/, src/inbound/<provider>/, src/upstream/<provider>/, src/app/, or src/ui/.`,
        )
      }
    })
  })
})
