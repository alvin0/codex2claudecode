// Property 34 for the Kiro-side MCP approval policy (task 36.2, Requirement 23).
//
// Asserted at the **module level**, against `src/upstream/kiro/mcp-toolset.ts` plus the request's
// `FeatureDecisions`. That is a deliberate split of one requirement across two files, the same split
// `web-search.property.test.ts` and `index.test.ts` already keep for the server-tool path:
//
// - **This file owns classification and collector contents.** Which kind every `require_approval`
//   value resolves to, what reaches the network as a consequence, and what the request's
//   `FeatureDecisions` holds afterwards — the recorded `FeatureRejection` whose `message` *is* the
//   400 body verbatim (`resolveFeature()` builds it), and the notices whose details state the
//   interpretation. Generated over every value the type admits plus three it does not.
// - **`test/upstream/kiro/index.test.ts` owns delivery**, in "turns a require_approval toolset into a
//   400 the client reads, without calling Kiro": that `Kiro_Upstream_Provider` reads
//   `decisions.firstRejection()` and returns `canonicalError(400, rejection.message)` instead of
//   recording the rejection and streaming on. That is one shared bail point every Kiro rejection
//   passes through, so it is asserted once there and deliberately not restated here — no clause below
//   constructs a provider, a response, or a status code.
//
// End to end, 36.3's live case `mcp-approval-reject` closes the loop over a real client.
//
// **Validates: Requirements 23.1, 23.2, 23.3, 23.4**
import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_Event } from "../../../src/core/canonical"
import { FeatureDecisions } from "../../../src/core/feature-decisions"
import type { McpClientLike } from "../../../src/core/mcp/toolset"
import type { McpToolsetSpec } from "../../../src/core/mcp/types"
import type { JsonObject } from "../../../src/core/types"
import {
  KIRO_CAPABILITIES,
  KIRO_MCP_APPROVAL_SELECTIVE_POLICY,
} from "../../../src/upstream/kiro/capabilities"
import {
  createKiroMcpSession,
  kiroMcpApprovalKind,
  kiroMcpToolsets,
  mcpCallOutputItem,
  resolveKiroMcpApproval,
} from "../../../src/upstream/kiro/mcp-toolset"

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

interface ServerFixture {
  label: string
  url: string
  toolName: string
  /** The raw `require_approval` value as it appears on the client's `mcp` tool. */
  approval: unknown
}

/** Everything the fake transport was asked to do, so "nothing ran" is a countable claim. */
interface CallLog {
  listed: string[]
  calls: Array<{ url: string; tool: string }>
}

function fakeClientFactory(servers: readonly ServerFixture[], log: CallLog) {
  const byUrl = new Map(servers.map((server) => [server.url, server]))
  return (spec: McpToolsetSpec): McpClientLike => {
    const url = spec.server_url ?? ""
    const server = byUrl.get(url)
    return {
      async initialize() {},
      async listTools() {
        log.listed.push(url)
        return server ? [{ name: server.toolName, description: "generated" }] : []
      },
      async callTool(name: string) {
        log.calls.push({ url, tool: name })
        return { content: [{ type: "text", text: "done" }], isError: false }
      },
    }
  }
}

function requestTools(servers: readonly ServerFixture[]): JsonObject[] {
  return servers.map((server) => ({
    type: "mcp",
    server_label: server.label,
    server_url: server.url,
    ...(server.approval === undefined ? {} : { require_approval: server.approval as JsonObject }),
  }))
}

function decisionsFor(strict = false): FeatureDecisions {
  return new FeatureDecisions(KIRO_CAPABILITIES.features, strict)
}

async function drain(events: AsyncIterable<Canonical_Event>): Promise<Canonical_Event[]> {
  const collected: Canonical_Event[] = []
  for await (const event of events) collected.push(event)
  return collected
}

/**
 * The expected classification, computed from the **raw** generated value by a rule written here.
 *
 * Independent of `kiroMcpApprovalKind()` on purpose: reusing the module's classifier would make the
 * three-way split a tautology. This rule is the requirement's own wording — `"never"` and an absent
 * value ask for nothing, `"always"` asks for approval on every call, and anything else is a
 * selection, including the shapes the inbound converter would have refused (a bare `{}`, an
 * unrecognised string, an array), which must land on the *restrictive* side rather than be dropped.
 */
function expectedKind(raw: unknown): "unrestricted" | "required" | "selective" {
  if (raw === undefined || raw === "never") return "unrestricted"
  if (raw === "always") return "required"
  return "selective"
}

/**
 * Every key path in a value whose name mentions approval.
 *
 * The evidence for the "no automatic approval" clause, and the reason it is falsifiable rather than
 * a restatement: an approval that the gateway granted itself has to be *expressed* somewhere to have
 * any effect, and on this wire there is exactly one expression of it — the `approval_request_id`
 * field, which `mcpCallItemToBlocks()` forwards onto an `mcp_tool_use` block whenever it finds one on
 * the input item. So the check is a recursive key scan over everything this module emits (blocks,
 * events, notices, `mcp_call` items) for any key matching /approval/, which fails the moment such a
 * field is written — including by a future edit to the block writer or to `mcpCallOutputItem()`.
 * This scan was verified non-vacuous by running it against an item carrying
 * `approval_request_id` (see the last clause below), so a `0` here means "no such key", not "the
 * scan cannot see one".
 */
function approvalKeyPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => approvalKeyPaths(item, `${path}[${index}]`))
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, item]) => [
    ...(/approval/i.test(key) ? [`${path}.${key}`] : []),
    ...approvalKeyPaths(item, `${path}.${key}`),
  ])
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

const identifier = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/).filter((value) => value.length > 0)
const host = identifier.map((name) => `${name}.example.test`)

/**
 * Every `require_approval` value the type admits, plus three the type does not.
 *
 * The last three matter: `McpToolsetSpec.require_approval` is typed, but the field crosses a JSON
 * boundary on the way in, and Requirement 23.4 says *zero* automatic approvals **for any value** —
 * a value the classifier fails to recognise must not fall through to the executing branch.
 */
const approvalValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.constant("never"),
  fc.constant("always"),
  fc.record({ read_only: fc.boolean() }),
  fc.record({ tool_names: fc.array(identifier, { minLength: 1, maxLength: 2 }) }),
  fc.record({ read_only: fc.boolean(), tool_names: fc.array(identifier, { minLength: 1, maxLength: 2 }) }),
  fc.constant({}),
  fc.constant("sometimes"),
  fc.constant([]),
)

const serverFixture: fc.Arbitrary<ServerFixture> = fc
  .tuple(identifier, host, identifier, approvalValue)
  .map(([label, hostname, toolName, approval]) => ({ label, url: `https://${hostname}/mcp`, toolName, approval }))

/**
 * Distinct labels **and** distinct URLs.
 *
 * Two toolsets sharing a URL resolve to one identity and blur the tool counts; two sharing a label
 * produce the same notice detail and are deduped by `FeatureDecisions`, which would blur the notice
 * count. Both are real behaviours, and neither is what this property is measuring.
 */
const serverFixtures = fc.uniqueArray(serverFixture, {
  minLength: 1,
  maxLength: 4,
  comparator: (a, b) => a.label === b.label || a.url === b.url,
})

// ---------------------------------------------------------------------------------------------
// Property 34
// ---------------------------------------------------------------------------------------------

describe("Feature: native-api-mode, Property 34: Approval is never granted automatically", () => {
  /**
   * For any `require_approval` value the outcome is exactly one of the three the requirement names,
   * and no path emits an approval on the user's behalf.
   *
   * The three are checked as *mutually exclusive* per toolset rather than as three separate
   * expectations, so a value that produced two outcomes — say a rejection *and* an expansion — fails
   * here rather than satisfying whichever clause was asserted first.
   *
   * **Validates: Requirements 23.1, 23.2, 23.3, 23.4**
   */
  test("every require_approval value lands on exactly one of reject / execute / restrict-plus-notice", async () => {
    await fc.assert(
      fc.asyncProperty(serverFixtures, async (servers) => {
        const log: CallLog = { listed: [], calls: [] }
        const decisions = decisionsFor()
        const session = await createKiroMcpSession(requestTools(servers), {
          decisions,
          initialize: false,
          createClient: fakeClientFactory(servers, log),
          callId: () => "mcp_pinned",
        })

        const kinds = new Map(servers.map((server) => [server.url, expectedKind(server.approval)]))
        const unrestricted = servers.filter((server) => kinds.get(server.url) === "unrestricted")
        const required = servers.filter((server) => kinds.get(server.url) === "required")
        const selective = servers.filter((server) => kinds.get(server.url) === "selective")

        // The module's own classifier agrees with the rule above on every generated value — the two
        // are written independently, so this is a comparison rather than a restatement.
        for (const spec of kiroMcpToolsets(requestTools(servers))) {
          expect(kiroMcpApprovalKind(spec.require_approval) as string).toBe(String(kinds.get(spec.server_url!)))
        }

        // --- Clause 1 (23.1): `"always"` rejects, and the message names the alternative. ---
        const rejection = decisions.firstRejection()
        expect(Boolean(rejection)).toBe(required.length > 0)
        if (rejection) {
          expect(rejection.feature).toBe("mcpToolset")
          expect(rejection.message).toContain("require_approval")
          expect(rejection.message).toContain('"never"')
        }

        // --- Clause 2 (23.2): `"never"` (and absent) executes normally. ---
        // "Normally" is measured as: its tools were expanded, its server was reachable, and a call
        // to one of them actually reached the transport and came back as the block pair.
        expect(session.tools.length).toBe(unrestricted.length)
        expect([...session.serverUrls].sort()).toEqual(unrestricted.map((server) => server.url).sort())
        expect(log.listed.sort()).toEqual(unrestricted.map((server) => server.url).sort())

        const emitted: Canonical_Event[] = []
        for (const tool of session.tools) {
          const name = String(tool.name)
          expect(session.handles(name)).toBe(true)
          emitted.push(...(await drain(session.handleToolCall({ callId: "call_1", name, arguments: "{}" }))))
        }
        expect(log.calls.length).toBe(unrestricted.length)
        expect(log.calls.map((call) => call.url).sort()).toEqual(unrestricted.map((server) => server.url).sort())
        expect(session.mcpCalls).toBe(unrestricted.length)
        for (const event of emitted) expect(event.type).toBe("server_tool_block")

        // --- Clause 3 (23.3): the object forms restrict maximally and say so. ---
        // Maximally restrictive is checked on both sides: zero tools exposed for that server, and
        // zero contact with it — a server whose tools are withheld but which is still listed would
        // be a weaker interpretation wearing the notice of a stronger one.
        const notices = decisions.notices()
        expect(notices.length).toBe(selective.length)
        for (const server of selective) {
          expect(log.listed).not.toContain(server.url)
          expect(log.calls.map((call) => call.url)).not.toContain(server.url)
          expect(session.serverUrls.has(server.url)).toBe(false)

          const notice = notices.find((entry) => entry.detail.includes(JSON.stringify(server.label)))
          expect(notice, `a notice names ${server.label}`).toBeDefined()
          expect(notice!.feature).toBe("mcpToolset")
          expect(notice!.policy as string).toBe(KIRO_MCP_APPROVAL_SELECTIVE_POLICY as string)
          // The notice states the interpretation, not merely that something happened.
          expect(notice!.detail).toContain("most restrictive")
          expect(notice!.detail).toContain("every tool on that server is treated as needing approval")
        }
        // A `"always"` toolset contributes a rejection and no notice; the count above therefore also
        // says no withheld toolset was reported twice, or through the wrong channel.
        for (const server of required) {
          expect(log.listed).not.toContain(server.url)
          expect(session.serverUrls.has(server.url)).toBe(false)
        }

        // --- Exclusivity: each toolset produced exactly one of the three outcomes. ---
        const { allowed, withheld } = resolveKiroMcpApproval(kiroMcpToolsets(requestTools(servers)))
        expect(allowed.length + withheld.length).toBe(servers.length)
        expect(allowed.map((spec) => spec.server_url).sort()).toEqual(unrestricted.map((server) => server.url).sort())
        expect(withheld.filter((entry) => entry.kind === "required").length).toBe(required.length)
        expect(withheld.filter((entry) => entry.kind === "selective").length).toBe(selective.length)

        // --- Clause 4 (23.4): nothing emitted carries an approval. ---
        // Everything that left the module on this request: the blocks, the notices, and the
        // rejection message. `approval_request_id` is the only field on this wire that expresses a
        // granted approval, and none is written; the only mention of approval anywhere is the
        // client's own field name inside prose, which is text, not a field.
        const surface = [...emitted, ...notices, ...(rejection ? [rejection] : [])]
        expect(approvalKeyPaths(surface)).toEqual([])
      }),
      { numRuns: 200 },
    )
  })

  /**
   * The item producer writes no approval field, for any outcome — the mechanism behind clause 4.
   *
   * `mcpCallItemToBlocks()` forwards `approval_request_id` from the item it is given, so "no
   * approval on a block" holds only because `mcpCallOutputItem()` never puts one on an item. This
   * clause pins that, and the second half proves the scan can see such a field when it exists, so
   * the empty result above is evidence rather than a blind spot.
   *
   * **Validates: Requirements 23.4**
   */
  test("the mcp_call item producer writes no approval field, and the scan detects one that is written", () => {
    fc.assert(
      fc.property(identifier, identifier, fc.boolean(), (label, toolName, isError) => {
        const item = mcpCallOutputItem({
          identity: { serverLabel: label, serverUrl: `https://${label}.example.test/mcp`, toolName },
          exposedName: `mcp__${label}__${toolName}`,
          arguments: { q: 1 },
          content: "payload",
          isError,
        })
        expect(approvalKeyPaths(item)).toEqual([])
      }),
      { numRuns: 100 },
    )

    // Anti-vacuity: the same scan on an item that *does* carry the field reports it.
    expect(approvalKeyPaths({ type: "mcp_call", approval_request_id: "appr_1" })).toEqual(["$.approval_request_id"])
  })

  /**
   * Strict mode escalates the object form to the same rejection the `"always"` form earns.
   *
   * Not a fourth outcome and not part of Property 34: it is `resolveFeature()`'s standing
   * `NATIVE_STRICT` contract (Requirement 11.1) applied to this decision, and it is here because the
   * placement claim — that these branches go through `FeatureDecisions` rather than through a bespoke
   * error return — is only observable as this behaviour. A hand-rolled 400 would not escalate.
   */
  test("under strict mode the object form escalates through the same channel", async () => {
    const server: ServerFixture = {
      label: "shop",
      url: "https://shop.example.test/mcp",
      toolName: "search",
      approval: { read_only: true },
    }
    const log: CallLog = { listed: [], calls: [] }
    const decisions = decisionsFor(true)
    const session = await createKiroMcpSession(requestTools([server]), {
      decisions,
      initialize: false,
      createClient: fakeClientFactory([server], log),
    })

    expect(session.tools).toEqual([])
    expect(decisions.notices()).toEqual([])
    const rejection = decisions.firstRejection()
    expect(rejection?.feature).toBe("mcpToolset")
    expect(rejection?.message).toContain('require_approval: "never"')
    expect(log.listed).toEqual([])
  })

  /**
   * Withholding does not depend on the collector.
   *
   * The collector is optional so a caller can inspect the split without one; if that made the
   * *protection* optional, a call site that forgot to pass it would run approval-gated tools. It does
   * not: the toolset is withheld either way, and what a missing collector costs is the report.
   */
  test("a session built without a collector still withholds every approval-gated toolset", async () => {
    const servers: ServerFixture[] = [
      { label: "a", url: "https://a.example.test/mcp", toolName: "one", approval: "always" },
      { label: "b", url: "https://b.example.test/mcp", toolName: "two", approval: { tool_names: ["two"] } },
      { label: "c", url: "https://c.example.test/mcp", toolName: "three", approval: "never" },
    ]
    const log: CallLog = { listed: [], calls: [] }
    const session = await createKiroMcpSession(requestTools(servers), {
      initialize: false,
      createClient: fakeClientFactory(servers, log),
    })

    expect(session.tools.length).toBe(1)
    expect([...session.serverUrls]).toEqual(["https://c.example.test/mcp"])
    expect(log.listed).toEqual(["https://c.example.test/mcp"])
  })
})
