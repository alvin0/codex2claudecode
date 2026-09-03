// Feature: native-api-mode, task 29.3 (Kiro half) — hosted tool handling read from the declared
// matrix instead of from two hardcoded type comparisons.
//
// _Requirements: 19.2, 19.3, 19.4, 19.5_
//
// Scope: `src/upstream/kiro/hosted-tools.ts` on its own. The cross-provider clauses — the ten-name
// key set, the Codex forward, the end-to-end terminal state — belong to
// `test/upstream/hosted-tools.property.test.ts` (task 29.4) and are not repeated here. What this
// file covers is the module's own behavior: which types it treats as hosted, what each declared cell
// produces on a `FeatureDecisions`, and that an undeclared type reports rather than refuses.
import { describe, expect, test } from "bun:test"

import { FeatureDecisions } from "../../../src/core/feature-decisions"
import type { JsonObject } from "../../../src/core/types"
import { KIRO_CAPABILITIES, KIRO_UNDECLARED_HOSTED_TOOL_POLICY } from "../../../src/upstream/kiro/capabilities"
import { isKiroHostedTool, kiroHostedToolTypes, resolveKiroHostedTools } from "../../../src/upstream/kiro/hosted-tools"
import { computeEffectiveTools } from "../../../src/upstream/kiro/index"

function decisions(strict = false) {
  return new FeatureDecisions(KIRO_CAPABILITIES.features, strict)
}

/** One declared type of each outcome the matrix actually contains, read off the declaration. */
const REFUSED_TYPE = "code_interpreter"
const EMULATED_TYPE = "web_search"

describe("isKiroHostedTool", () => {
  test("a function tool is not a hosted tool", () => {
    expect(isKiroHostedTool({ type: "function", name: "read_file" })).toBe(false)
  })

  test("any other non-empty type is a hosted tool, declared or not", () => {
    expect(isKiroHostedTool({ type: REFUSED_TYPE })).toBe(true)
    expect(isKiroHostedTool({ type: "something_nobody_declared" })).toBe(true)
  })

  test("a tool with no usable type is not a hosted tool", () => {
    expect(isKiroHostedTool({ name: "read_file" })).toBe(false)
    expect(isKiroHostedTool({ type: "" })).toBe(false)
    expect(isKiroHostedTool({ type: 7 } as unknown as JsonObject)).toBe(false)
  })
})

describe("kiroHostedToolTypes", () => {
  test("keeps client order, drops function tools, and reports each type once", () => {
    const types = kiroHostedToolTypes([
      { type: EMULATED_TYPE },
      { type: "function", name: "read_file" },
      { type: REFUSED_TYPE },
      { type: EMULATED_TYPE, extra: "second copy" },
    ])
    expect(types).toEqual([EMULATED_TYPE, REFUSED_TYPE])
  })

  test("an absent or tool-free list carries no hosted tool types", () => {
    expect(kiroHostedToolTypes(undefined)).toEqual([])
    expect(kiroHostedToolTypes([])).toEqual([])
    expect(kiroHostedToolTypes([{ type: "function", name: "read_file" }])).toEqual([])
  })
})

describe("resolveKiroHostedTools", () => {
  test("a refusing cell produces a 400 naming the type and an alternative", () => {
    expect(KIRO_CAPABILITIES.hostedTools![REFUSED_TYPE]).toBe("reject")

    const record = decisions()
    resolveKiroHostedTools([{ type: REFUSED_TYPE }], record)

    const rejection = record.firstRejection()
    expect(rejection).toBeDefined()
    expect(rejection!.message).toContain(REFUSED_TYPE)
    expect(rejection!.message).toMatch(/Use .+ instead\./)
    // A rejection travels the error path, so it contributes no notice.
    expect(record.notices()).toEqual([])
  })

  test("an emulating cell produces one notice under its own feature and no 400", () => {
    expect(KIRO_CAPABILITIES.hostedTools![EMULATED_TYPE]).toBe("emulate")

    const record = decisions()
    resolveKiroHostedTools([{ type: EMULATED_TYPE }], record)

    expect(record.firstRejection()).toBeUndefined()
    const notices = record.notices()
    expect(notices).toHaveLength(1)
    expect(notices[0]!.feature).toBe("webSearch")
    expect(notices[0]!.policy).toBe("emulate")
    expect(notices[0]!.detail).toContain(EMULATED_TYPE)
  })

  test("a type absent from the matrix reports and does not refuse the request", () => {
    const type = "quantum_interpreter"
    expect(KIRO_CAPABILITIES.hostedTools![type]).toBeUndefined()

    const record = decisions()
    resolveKiroHostedTools([{ type }], record)

    expect(record.firstRejection()).toBeUndefined()
    const notices = record.notices()
    expect(notices).toHaveLength(1)
    // Widened to `string` on both sides: a notice policy is the three-member reporting union and the
    // declared fallback is the four-member policy union, and the assertion is that the two spell the
    // same value rather than that the types coincide.
    expect(notices[0]!.policy as string).toBe(KIRO_UNDECLARED_HOSTED_TOOL_POLICY as string)
    expect(notices[0]!.detail).toContain(type)
  })

  test("every declared type is resolved, and the eight refusing cells are the ones that refuse", () => {
    for (const [type, policy] of Object.entries(KIRO_CAPABILITIES.hostedTools!)) {
      const record = decisions()
      resolveKiroHostedTools([{ type }], record)

      const refused = Boolean(record.firstRejection())
      expect(refused, `${type} declared ${policy}`).toBe(policy === "reject")
      expect(record.notices().length, `${type} declared ${policy}`).toBe(policy === "reject" ? 0 : 1)
      expect(record.resolvedFeatures().size, `${type} was resolved`).toBe(1)
    }
  })

  test("resolution does not stop at the first refusal, and the first one is the 400 the client sees", () => {
    const record = decisions()
    resolveKiroHostedTools([{ type: REFUSED_TYPE }, { type: "file_search" }, { type: EMULATED_TYPE }], record)

    expect(record.firstRejection()!.message).toContain(REFUSED_TYPE)
    expect(record.firstRejection()!.message).not.toContain("file_search")
    // The emulated tool behind the refusal was still resolved, so a refused request reports every
    // other decision it made.
    expect(record.notices().map((notice) => notice.feature)).toEqual(["webSearch"])
  })

  test("notices decided elsewhere on the same request survive a hosted tool refusal", () => {
    const record = decisions()
    // `outputLength` is one of this upstream's reporting cells, so it contributes a notice rather
    // than a competing 400 — which is what makes this a test about notices surviving.
    record.resolve("outputLength", "the requested output length limit was left off the request", "stop reading the reply on the client")
    resolveKiroHostedTools([{ type: REFUSED_TYPE }], record)

    expect(record.firstRejection()!.message).toContain(REFUSED_TYPE)
    expect(record.notices().map((notice) => notice.feature)).toEqual(["outputLength"])
  })

  test("strict mode escalates the undeclared fallback and leaves emulation alone", () => {
    const undeclared = decisions(true)
    resolveKiroHostedTools([{ type: "quantum_interpreter" }], undeclared)
    // The fallback is a degrading policy, so strict mode turns it into the 400 it escalates to.
    expect(undeclared.firstRejection()).toBeDefined()
    expect(undeclared.notices()).toEqual([])

    const emulated = decisions(true)
    resolveKiroHostedTools([{ type: EMULATED_TYPE }], emulated)
    expect(emulated.firstRejection()).toBeUndefined()
    expect(emulated.notices()).toHaveLength(1)
  })

  test("a request with no hosted tools decides nothing", () => {
    const record = decisions()
    resolveKiroHostedTools([{ type: "function", name: "read_file" }], record)

    expect(record.firstRejection()).toBeUndefined()
    expect(record.notices()).toEqual([])
    expect(record.resolvedFeatures().size).toBe(0)
  })

  test("both spellings of the web search capability are one notice", () => {
    // `web_search` and `web_search_preview` are one hosted intent declared twice: same `emulate`
    // cell, same `webSearch` feature. Requirement 10.2 is per field — a field resolving to
    // `emulate` gets exactly one notice — so a request carrying both spellings owes the client one
    // notice, not one per spelling.
    expect(KIRO_CAPABILITIES.hostedTools!["web_search"]).toBe("emulate")
    expect(KIRO_CAPABILITIES.hostedTools!["web_search_preview"]).toBe("emulate")

    const record = decisions()
    resolveKiroHostedTools([{ type: "web_search" }, { type: "web_search_preview" }], record)

    // Both spellings were resolved — the collapse is in the reporting, not in the resolution.
    expect(kiroHostedToolTypes([{ type: "web_search" }, { type: "web_search_preview" }])).toEqual([
      "web_search",
      "web_search_preview",
    ])
    expect(record.firstRejection()).toBeUndefined()

    const notices = record.notices()
    expect(notices).toHaveLength(1)
    expect(notices[0]!.feature).toBe("webSearch")
    expect(notices[0]!.policy).toBe("emulate")
    // The one detail names the capability in a way either client recognises.
    expect(notices[0]!.detail).toContain("web_search")
    expect(notices[0]!.detail).toContain("web_search_preview")
  })

  test("either spelling alone produces the same single notice", () => {
    const alone = decisions()
    resolveKiroHostedTools([{ type: "web_search_preview" }], alone)
    const preview = alone.notices()
    expect(preview).toHaveLength(1)

    const plain = decisions()
    resolveKiroHostedTools([{ type: "web_search" }], plain)
    expect(plain.notices()).toEqual(preview)
  })

  // A canonical fetch is the one hosted type whose outcome is not a `hostedTools` lookup: the ten
  // declared names are this protocol's hosted vocabulary and a fetch is not among them, so its policy
  // is the declared `features.webFetch` cell. These four units exist because the fetch only started
  // arriving here as `web_fetch` once the canonical vocabulary gained a spelling for it
  // (`src/core/canonical-tools.ts`); before that a Claude fetch reached this module as `web_search`
  // and this path was unreachable.
  describe("a canonical web_fetch", () => {
    test("resolves under webFetch with the declared cell, not as an undeclared type", () => {
      expect(KIRO_CAPABILITIES.features.webFetch).toBe("emulate")
      expect(KIRO_CAPABILITIES.hostedTools!["web_fetch"]).toBeUndefined()

      const record = decisions()
      resolveKiroHostedTools([{ type: "web_fetch" }], record)

      expect(record.firstRejection()).toBeUndefined()
      const notices = record.notices()
      expect(notices).toHaveLength(1)
      expect(notices[0]!.feature).toBe("webFetch")
      expect(notices[0]!.policy).toBe("emulate")
      expect(notices[0]!.detail).toContain("web_fetch")
    })

    test("the notice says the fetch happens rather than that nothing runs it", () => {
      const record = decisions()
      resolveKiroHostedTools([{ type: "web_fetch" }], record)

      // The declared cell is `emulate`, and `computeEffectiveTools()` below shows the gateway really
      // does run it — so the undeclared fallback's wording would be the opposite of what happens.
      expect(record.notices()[0]!.detail).not.toContain("may not run at all")
      expect(record.notices()[0]!.detail).toContain("gateway fetches the URL itself")
    })

    test("strict mode does not refuse a fetch this upstream declares it emulates", () => {
      const record = decisions(true)
      resolveKiroHostedTools([{ type: "web_fetch" }], record)

      // An emulating cell is a terminal, reported outcome in strict mode too; only degrading cells
      // escalate. The undeclared fallback is degrading, which is how this request used to 400.
      expect(record.firstRejection()).toBeUndefined()
      expect(record.notices()).toHaveLength(1)
      expect(record.notices()[0]!.feature).toBe("webFetch")
    })

    test("the dated spelling a Claude client sends resolves identically", () => {
      const dated = decisions()
      resolveKiroHostedTools([{ type: "web_fetch_20250910" }], dated)

      expect(dated.firstRejection()).toBeUndefined()
      expect(dated.notices()).toHaveLength(1)
      expect(dated.notices()[0]!.feature).toBe("webFetch")
      expect(dated.notices()[0]!.detail).toContain("web_fetch_20250910")
    })

    test("the reported outcome matches what the tool-list expansion actually does", () => {
      const record = decisions()
      resolveKiroHostedTools([{ type: "web_fetch" }], record)
      expect(record.notices()[0]!.policy).toBe("emulate")

      // The other half of "emulate": the gateway declares its own fetch tool to the model and offers
      // the interceptor that executes it. Asserted here so the notice and the behavior cannot drift.
      const effective = computeEffectiveTools([{ type: "web_fetch" }])
      expect("error" in effective).toBe(false)
      if ("error" in effective) return
      expect(effective.webFetch).toBe(true)
      expect(effective.tools.map((tool) => tool.name)).toContain("web_fetch")
    })

    test("a fetch beside a refused hosted tool still reports its own outcome", () => {
      const record = decisions()
      resolveKiroHostedTools([{ type: REFUSED_TYPE }, { type: "web_fetch" }], record)

      expect(record.firstRejection()!.message).toContain(REFUSED_TYPE)
      expect(record.notices().map((notice) => notice.feature)).toEqual(["webFetch"])
    })
  })

  test("two copies of one type are one decision", () => {
    const record = decisions()
    resolveKiroHostedTools([{ type: EMULATED_TYPE }, { type: EMULATED_TYPE, filters: "other" }], record)

    expect(record.notices()).toHaveLength(1)
  })
})
