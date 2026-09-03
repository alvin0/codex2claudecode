// The fetch-to-search substitution on the two Responses-shaped upstreams.
//
// ## What moved, and why this file exists
//
// A Claude `web_fetch_*` tool used to become `{ type: "web_search" }` inside
// `src/inbound/claude/web.ts`, before any upstream saw the request. That had two consequences: an
// upstream able to emulate a fetch never received one (the reason a Claude-driven fetch could not
// reach Kiro's emulation at all), and the swap was invisible — no Feature_Notice, nothing on the
// canonical request, which is exactly the silent capability substitution Requirement 10.1 forbids.
//
// The canonical vocabulary now carries the fetch (`src/core/canonical-tools.ts`), so the inbound
// layer states the intent and each upstream decides what to do with it. Codex and Copilot both post
// an OpenAI **Responses** body, and Responses has no fetch tool — `web_fetch` is not among the ten
// hosted type names in Requirement 19.1 — so on those two the substitution is still the right
// answer. It just happens at the boundary that owns the wire vocabulary, and it is reported.
//
// ## The two claims, per upstream
//
//  1. **The bytes did not change.** A fetch leaves as a search, with its scoping fields, and a
//     client that declared both a search and a fetch still sends exactly one search — which is what
//     the old inbound dedupe produced. This is the regression guard for moving the swap: without it,
//     a `web_fetch` type would reach the Responses API, which does not accept one.
//  2. **The swap is reported.** One notice, recorded under `webFetch`, carrying the declared policy
//     for that cell and naming the tool the client asked for.
//
// Nothing here issues a network call: claim 1 reads the body builders, claim 2 reads a
// `FeatureDecisions` the way each provider's `proxy()` does.
import { describe, expect, test } from "bun:test"

import type { Canonical_Request } from "../../src/core/canonical"
import { FeatureDecisions } from "../../src/core/feature-decisions"
import type { JsonObject } from "../../src/core/types"
import { CODEX_CAPABILITIES } from "../../src/upstream/codex/capabilities"
import { resolveCodexHostedTools } from "../../src/upstream/codex/hosted-tools"
import { canonicalToCodexBody } from "../../src/upstream/codex/parse"
import { COPILOT_CAPABILITIES } from "../../src/upstream/copilot/capabilities"
import { resolveCopilotHostedTools } from "../../src/upstream/copilot/hosted-tools"
import { buildCopilotResponsesBody } from "../../src/upstream/copilot/parse"

function request(tools: JsonObject[]): Canonical_Request {
  return {
    model: "gpt-5.4",
    input: [{ role: "user", content: [{ type: "input_text", text: "read https://bun.sh/docs" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
    tools,
  }
}

const UPSTREAMS = [
  {
    name: "codex",
    body: (tools: JsonObject[]) => canonicalToCodexBody(request(tools)),
    resolve: resolveCodexHostedTools,
    declared: CODEX_CAPABILITIES.features.webFetch,
  },
  {
    name: "copilot",
    body: (tools: JsonObject[]) => buildCopilotResponsesBody(request(tools)),
    resolve: resolveCopilotHostedTools,
    declared: COPILOT_CAPABILITIES.features.webFetch,
  },
] as const

describe.each(UPSTREAMS.map((upstream) => [upstream.name, upstream] as const))("%s — a canonical fetch travels as a search", (_name, upstream) => {
  /**
   * Claim 1 — the wire bytes are the ones this upstream received before the vocabulary change.
   *
   * **Validates: Requirements 19.1, 10.1**
   */
  test("sends a fetch as a search, keeping its scoping fields", () => {
    const body = upstream.body([{ type: "web_fetch", filters: { allowed_domains: ["bun.sh"] } }])

    expect(body.tools).toEqual([{ type: "web_search", filters: { allowed_domains: ["bun.sh"] } }])
  })

  /** Claim 1, the pair: one search on the wire, as the old inbound dedupe produced. */
  test("collapses a declared search and fetch into one search", () => {
    const body = upstream.body([{ type: "web_search" }, { type: "web_fetch", filters: { allowed_domains: ["bun.sh"] } }])

    expect(body.tools).toEqual([{ type: "web_search" }])
  })

  /** Claim 1's control: every other type is untouched, so the substitution is scoped to the fetch. */
  test("leaves every other tool type alone", () => {
    const tools: JsonObject[] = [{ type: "web_search" }, { type: "mcp", server_label: "docs" }, { type: "function", name: "save" }]
    const body = upstream.body(tools)

    expect(body.tools).toEqual(tools)
  })

  /**
   * Claim 2 — the swap is reported once, under `webFetch`, with this upstream's declared policy.
   *
   * The feature attribution is asserted here, unlike in `hosted-tools.property.test.ts` where it is
   * deliberately left free: for this type the attribution *is* the fix. A notice filed under
   * `mcpToolset` would tell a client its fetch was some unspecified hosted tool, which is the report
   * the declared `features.webFetch` cell exists to replace.
   *
   * **Validates: Requirements 10.1, 10.2**
   */
  test("reports the substitution exactly once, under webFetch", () => {
    const decisions = new FeatureDecisions(upstream.name === "codex" ? CODEX_CAPABILITIES.features : COPILOT_CAPABILITIES.features, false)
    upstream.resolve([{ type: "web_fetch_20250910" }], decisions)

    const notices = decisions.notices()
    expect(notices).toHaveLength(1)
    expect(notices[0]!.feature).toBe("webFetch")
    // Compared as the declared cell rather than as a literal, so the assertion follows the matrix if
    // a measurement ever moves it. A notice can only carry a reporting policy, hence the widening.
    expect(notices[0]!.policy as string).toBe(upstream.declared)
    expect(notices[0]!.detail).toContain("web_fetch_20250910")
    expect(decisions.firstRejection()).toBeUndefined()
    expect([...decisions.resolvedFeatures()]).toEqual(["webFetch"])
  })
})
