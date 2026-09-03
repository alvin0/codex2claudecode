// Properties 29 and 31 for MCP toolset expansion (tasks 33.3, 33.4).
//
// Scope note: Property 31 has two halves, and this file owns the **`tools/list`** half only — a
// failure during expansion drops one toolset, produces exactly one notice, and lets the request
// continue. The `tools/call` half (a failing call surfacing as a contained tool-error result inside a
// live upstream stream) belongs to task 35.6, where the stream that must still reach its terminal
// event actually exists. The executor-level containment this file does assert is the part core owns.
//
// Both properties run against an injected client, not HTTP: what is under test is the filtering rule,
// the emitted tool shape, and the failure containment — none of which is a network fact. The
// generators manufacture the cases that make the claims non-trivial: allowlists that name tools the
// server does not advertise, servers advertising the same tool name, the same tool name selected on
// two servers, and every failure category the protocol layer can raise.
//
// **Validates: Requirements 21.1, 21.2, 21.3, 21.6**

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_FeatureNotice } from "../../../src/core/canonical"
import { MCP_ERROR_CATEGORIES, McpProtocolError } from "../../../src/core/mcp/errors"
import { MCP_EXPOSED_NAME_MIN_LENGTH } from "../../../src/core/mcp/naming"
import type { McpClientLike, McpExpansionDeps } from "../../../src/core/mcp/toolset"
import { executeMcpToolCall, expandMcpToolsets } from "../../../src/core/mcp/toolset"
import type { McpRemoteTool, McpToolsetSpec } from "../../../src/core/mcp/types"

// ---------------------------------------------------------------------------------------------
// Fixtures: an in-memory MCP server
// ---------------------------------------------------------------------------------------------

/** How a generated server behaves: it lists tools, or it fails in a named way. */
type ServerBehaviour =
  | { kind: "ok"; tools: McpRemoteTool[] }
  | { kind: "fail"; at: "initialize" | "listTools"; error: unknown }

/**
 * A client that answers from a table keyed by server URL. Also records every call it received, so a
 * test can assert a dropped toolset produced no further traffic.
 */
function fakeClientFactory(behaviour: ReadonlyMap<string, ServerBehaviour>) {
  const listed: string[] = []
  const called: Array<{ serverUrl: string; toolName: string; args: unknown }> = []

  const createClient = (spec: McpToolsetSpec): McpClientLike => {
    const url = spec.server_url?.trim() ?? ""
    const entry = behaviour.get(url) ?? { kind: "ok" as const, tools: [] }
    return {
      async initialize() {
        if (entry.kind === "fail" && entry.at === "initialize") throw entry.error
      },
      async listTools() {
        if (entry.kind === "fail" && entry.at === "listTools") throw entry.error
        listed.push(url)
        return entry.kind === "ok" ? entry.tools : []
      },
      async callTool(toolName: string, args: unknown) {
        called.push({ serverUrl: url, toolName, args })
        return { content: { server: url, tool: toolName }, isError: false }
      },
    }
  }

  return { createClient, listed, called }
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

/** A small shared vocabulary, so the same tool name really does recur across servers. */
const TOOL_NAMES = ["search", "read_file", "list", "ask question", "a", "very_long_tool_name_here"]
const SERVER_LABELS = ["deepwiki", "internal", "dup", "srv a", "同名"]

const remoteTool: fc.Arbitrary<McpRemoteTool> = fc.record(
  {
    name: fc.constantFrom(...TOOL_NAMES),
    description: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
    inputSchema: fc.option(
      fc.constantFrom<Record<string, unknown>>(
        { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        { type: "object", properties: {}, additionalProperties: false },
        // A partial schema: the expansion must still yield a valid function tool.
        { properties: { x: { type: "number" } } },
      ),
      { nil: undefined },
    ),
  },
  { requiredKeys: ["name"] },
)

/** Distinct tools for one server — a `tools/list` never advertises one name twice. */
const remoteToolList = fc
  .array(remoteTool, { minLength: 0, maxLength: 5 })
  .map((tools) => dedupeBy(tools, (tool) => tool.name))

const serverUrl = fc.constantFrom(
  "https://one.example/mcp",
  "https://two.example/mcp",
  "https://three.example/mcp",
)

/**
 * A toolset plus the tools its server advertises, generated together so the expected expansion is
 * computable. `selection` chooses which naming field carries the restriction, including the case
 * where it names tools the server never advertises.
 */
const toolsetCase = fc
  .record({
    server_label: fc.constantFrom(...SERVER_LABELS),
    server_url: serverUrl,
    advertised: remoteToolList,
    field: fc.constantFrom("none", "allowed_tools", "tool_names"),
    selected: fc.array(fc.constantFrom(...TOOL_NAMES, "not_advertised"), { maxLength: 4 }),
    authorization: fc.option(fc.constant("secret-token-value-1234"), { nil: undefined }),
  })
  .map(({ server_label, server_url, advertised, field, selected, authorization }) => {
    const names = dedupeBy(selected, (name) => name)
    const spec: McpToolsetSpec = {
      type: "mcp",
      server_label,
      server_url,
      ...(field === "allowed_tools" && names.length ? { allowed_tools: names } : {}),
      ...(field === "tool_names" && names.length ? { tool_names: names } : {}),
      ...(authorization ? { authorization } : {}),
    }
    return { spec, advertised }
  })

const toolsetCases = fc.array(toolsetCase, { minLength: 1, maxLength: 4 })

const maxNameLength = fc.oneof(
  fc.constant(64),
  fc.integer({ min: MCP_EXPOSED_NAME_MIN_LENGTH, max: MCP_EXPOSED_NAME_MIN_LENGTH + 4 }),
  fc.integer({ min: MCP_EXPOSED_NAME_MIN_LENGTH, max: 100 }),
)

function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const item of items) {
    const id = key(item)
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(item)
  }
  return unique
}

/** The behaviour table implied by a set of generated cases, all servers healthy. */
function healthyBehaviour(
  cases: ReadonlyArray<{ spec: McpToolsetSpec; advertised: McpRemoteTool[] }>,
): Map<string, ServerBehaviour> {
  const table = new Map<string, ServerBehaviour>()
  for (const entry of cases) {
    // A generated pair may reuse a URL; the last writer wins, and `expectedTriples` below reads the
    // same table, so the expectation matches whatever the server actually answers.
    table.set(entry.spec.server_url!, { kind: "ok", tools: entry.advertised })
  }
  return table
}

/**
 * The `(serverLabel, serverUrl, toolName)` triples the expansion must contain: every advertised tool
 * of every toolset, filtered by that toolset's selection when it has one, deduplicated.
 */
function expectedTriples(
  cases: ReadonlyArray<{ spec: McpToolsetSpec }>,
  behaviour: ReadonlyMap<string, ServerBehaviour>,
): string[] {
  const triples: string[] = []
  for (const { spec } of cases) {
    const entry = behaviour.get(spec.server_url!)
    if (!entry || entry.kind !== "ok") continue
    const named = [...(spec.allowed_tools ?? []), ...(spec.tool_names ?? [])]
    const selection = named.length > 0 ? new Set(named) : undefined
    for (const tool of entry.tools) {
      if (selection && !selection.has(tool.name)) continue
      triples.push(`${spec.server_label}\u0000${spec.server_url}\u0000${tool.name}`)
    }
  }
  return [...new Set(triples)].sort()
}

// ---------------------------------------------------------------------------------------------
// Property 29
// ---------------------------------------------------------------------------------------------

describe("MCP toolset expansion", () => {
  /**
   * **Property 29: Toolset expansion filters correctly and yields valid function tools** — the
   * expansion contains exactly the tools named by `allowed_tools` or `tool_names` when either is
   * set and all remote tools otherwise, and every expanded tool satisfies the canonical function
   * tool schema.
   *
   * "Exactly" is checked through the reverse map rather than by parsing names: the exposed name is
   * mangled, so the identity behind it is the only faithful statement of which remote tool got
   * expanded — and it also proves each name routes back to its own server (Requirement 21.5).
   *
   * **Validates: Requirements 21.1, 21.2, 21.6**
   */
  test("Feature: native-api-mode, Property 29: expansion filters to the named tools and emits valid function tools", async () => {
    await fc.assert(
      fc.asyncProperty(toolsetCases, maxNameLength, async (cases, limit) => {
        const behaviour = healthyBehaviour(cases)
        const fake = fakeClientFactory(behaviour)
        const deps: McpExpansionDeps = { maxNameLength: limit, createClient: fake.createClient }

        const { tools, map, notices } = await expandMcpToolsets(
          cases.map((entry) => entry.spec),
          deps,
        )

        // Clause 1 — exactly the expected tools, no more and no fewer.
        const actual = tools
          .map((tool) => map.resolve(String(tool.name))!)
          .map((identity) => `${identity.serverLabel}\u0000${identity.serverUrl}\u0000${identity.toolName}`)
          .sort()
        expect(actual).toEqual(expectedTriples(cases, behaviour))

        // Clause 2 — every expanded tool is a canonical function tool, and its name is within the
        // caller-supplied ceiling.
        for (const tool of tools) {
          expect(tool.type).toBe("function")
          expect(typeof tool.name).toBe("string")
          expect(String(tool.name).length).toBeGreaterThan(0)
          expect(String(tool.name).length).toBeLessThanOrEqual(limit)
          expect(String(tool.name)).toMatch(/^[A-Za-z0-9_-]+$/)
          expect(tool.strict).toBe(false)
          const parameters = tool.parameters as Record<string, unknown>
          expect(typeof parameters).toBe("object")
          expect(Array.isArray(parameters)).toBe(false)
          expect(parameters.type).toBe("object")
          expect(typeof parameters.properties).toBe("object")
          if ("description" in tool) expect(typeof tool.description).toBe("string")
        }

        // Exposed names are unique, so the upstream never receives two tools of one name.
        expect(new Set(tools.map((tool) => String(tool.name))).size).toBe(tools.length)
        // A healthy expansion reports nothing.
        expect(notices).toEqual([])
      }),
      { numRuns: 150 },
    )
  })

  /**
   * The filtering rule as examples, so a Property 29 failure can be read against a concrete
   * expectation: an allowlist restricts, an unset allowlist does not, and a name the server does not
   * advertise contributes nothing rather than a phantom tool.
   */
  test("allowed_tools restricts the expansion and an unlisted name yields nothing", async () => {
    const advertised: McpRemoteTool[] = [{ name: "search" }, { name: "read_file" }, { name: "list" }]
    const behaviour = new Map<string, ServerBehaviour>([
      ["https://one.example/mcp", { kind: "ok", tools: advertised }],
    ])
    const fake = fakeClientFactory(behaviour)

    const restricted = await expandMcpToolsets(
      [
        {
          type: "mcp",
          server_label: "srv",
          server_url: "https://one.example/mcp",
          allowed_tools: ["search", "absent"],
        },
      ],
      { maxNameLength: 64, createClient: fake.createClient },
    )
    expect(restricted.tools.map((tool) => tool.name)).toEqual(["mcp__srv__search"])

    const unrestricted = await expandMcpToolsets(
      [{ type: "mcp", server_label: "srv", server_url: "https://one.example/mcp" }],
      { maxNameLength: 64, createClient: fake.createClient },
    )
    expect(unrestricted.tools.map((tool) => tool.name)).toEqual([
      "mcp__srv__search",
      "mcp__srv__read_file",
      "mcp__srv__list",
    ])
  })

  /**
   * Requirement 21.5 end to end at the executor level: the same remote tool name on two servers
   * expands to two names, and each call reaches its own server. A name the map never exposed
   * resolves to `undefined`, which is how an ordinary client tool call passes through.
   */
  test("same-named tools on two servers route to their own server, and a foreign name passes through", async () => {
    const behaviour = new Map<string, ServerBehaviour>([
      ["https://one.example/mcp", { kind: "ok", tools: [{ name: "search" }] }],
      ["https://two.example/mcp", { kind: "ok", tools: [{ name: "search" }] }],
    ])
    const fake = fakeClientFactory(behaviour)
    const specs: McpToolsetSpec[] = [
      { type: "mcp", server_label: "dup", server_url: "https://one.example/mcp" },
      { type: "mcp", server_label: "dup", server_url: "https://two.example/mcp" },
    ]

    const { tools, map } = await expandMcpToolsets(specs, {
      maxNameLength: 64,
      createClient: fake.createClient,
    })
    expect(tools).toHaveLength(2)

    for (const tool of tools) {
      const outcome = await executeMcpToolCall(
        map,
        { name: String(tool.name), arguments: '{"q":"x"}' },
        { specs, createClient: fake.createClient },
      )
      expect(outcome?.isError).toBe(false)
      expect(outcome?.arguments).toEqual({ q: "x" })
      expect(outcome?.content).toEqual({ server: outcome!.identity.serverUrl, tool: "search" })
    }
    expect(fake.called.map((entry) => entry.serverUrl).sort()).toEqual([
      "https://one.example/mcp",
      "https://two.example/mcp",
    ])

    // Not an MCP call: the caller forwards it as an ordinary client tool call.
    expect(
      await executeMcpToolCall(map, { name: "Bash" }, { specs, createClient: fake.createClient }),
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------
// Property 31 — the tools/list half
// ---------------------------------------------------------------------------------------------

/** Every way expansion can fail to obtain a tool list, including the non-`Error` throw. */
const failureKind = fc.oneof(
  fc.record({
    at: fc.constantFrom<"initialize" | "listTools">("initialize", "listTools"),
    error: fc
      .constantFrom(...MCP_ERROR_CATEGORIES)
      .map((category) => new McpProtocolError(category, `MCP failed with ${category}`)),
  }),
  fc.record({
    at: fc.constant<"listTools">("listTools"),
    error: fc.constantFrom(
      new Error("connection reset"),
      new TypeError("fetch failed"),
      // A non-Error throw must be contained too, not crash the containment path.
      "raw string failure" as unknown,
      { status: 500 } as unknown,
    ),
  }),
)

describe("MCP failure containment", () => {
  /**
   * **Property 31 (`tools/list` half): MCP failures are contained and the request still completes**
   * — for any `tools/list` failure kind the affected toolset is absent from the expansion, exactly
   * one feature notice is produced, and no error escapes.
   *
   * Generated with one failing toolset among healthy ones, so "the affected toolset" is a real
   * distinction: the healthy toolsets must still expand in full. That is what "the request
   * continues" means at this layer.
   *
   * **Validates: Requirement 21.3**
   */
  test("Feature: native-api-mode, Property 31: a tools/list failure drops one toolset, notices once, and throws nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        toolsetCases,
        fc.nat(),
        failureKind,
        maxNameLength,
        async (cases, pick, failure, limit) => {
          // One distinct URL per toolset, so exactly one toolset owns the failing server.
          const distinct = dedupeBy(cases, (entry) => entry.spec.server_url!)
          const failingIndex = pick % distinct.length
          const failingUrl = distinct[failingIndex].spec.server_url!

          const behaviour = healthyBehaviour(distinct)
          behaviour.set(failingUrl, { kind: "fail", at: failure.at, error: failure.error })

          const fake = fakeClientFactory(behaviour)
          const specs = distinct.map((entry) => entry.spec)

          // Nothing escapes: the call resolves.
          const { tools, map, notices } = await expandMcpToolsets(specs, {
            maxNameLength: limit,
            createClient: fake.createClient,
          })

          // Clause 1 — the affected toolset contributes no tool.
          for (const tool of tools) {
            expect(map.resolve(String(tool.name))!.serverUrl).not.toBe(failingUrl)
          }
          // …and every healthy toolset still expanded in full.
          const healthyOnly = distinct.filter((entry) => entry.spec.server_url !== failingUrl)
          const actual = tools
            .map((tool) => map.resolve(String(tool.name))!)
            .map((id) => `${id.serverLabel}\u0000${id.serverUrl}\u0000${id.toolName}`)
            .sort()
          expect(actual).toEqual(expectedTriples(healthyOnly, behaviour))

          // Clause 2 — exactly one notice, and it is a well-formed canonical notice.
          expect(notices).toHaveLength(1)
          assertCanonicalNotice(notices[0])
          expect(notices[0].detail).toContain(JSON.stringify(distinct[failingIndex].spec.server_label))

          // No credential ever reaches a notice, whatever the server echoed back.
          for (const { spec } of distinct) {
            if (spec.authorization) expect(notices[0].detail).not.toContain(spec.authorization)
          }
        },
      ),
      { numRuns: 150 },
    )
  })

  /**
   * A toolset with no endpoint is the same containment case reached without any network attempt:
   * the gateway cannot reach a hosted connector, so the toolset drops with one notice.
   *
   * **Validates: Requirement 21.3**
   */
  test("Feature: native-api-mode, Property 31: a toolset with no server_url drops with exactly one notice", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<string | undefined>(undefined, "", "   "),
        fc.constantFrom(...SERVER_LABELS),
        async (url, label) => {
          const fake = fakeClientFactory(
            new Map([["https://one.example/mcp", { kind: "ok", tools: [{ name: "search" }] }]]),
          )
          const { tools, notices } = await expandMcpToolsets(
            [
              { type: "mcp", server_label: label, connector_id: "connector_abc", ...(url === undefined ? {} : { server_url: url }) },
              { type: "mcp", server_label: "healthy", server_url: "https://one.example/mcp" },
            ],
            { maxNameLength: 64, createClient: fake.createClient },
          )

          expect(tools.map((tool) => tool.name)).toEqual(["mcp__healthy__search"])
          expect(notices).toHaveLength(1)
          assertCanonicalNotice(notices[0])
          // Never attempted a connection for the endpoint-less toolset.
          expect(fake.listed).toEqual(["https://one.example/mcp"])
        },
      ),
      { numRuns: 100 },
    )
  })

  /**
   * Containment for the executor's own failure path — the layer-local counterpart to task 35.6's
   * in-stream assertion. A failing `tools/call` becomes an error *outcome*, carrying the category,
   * rather than a thrown error, which is what lets the caller emit a result block and finish.
   *
   * **Validates: Requirement 21.3**
   */
  test("Feature: native-api-mode, Property 31: a failing tools/call becomes an error outcome, not a throw", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...MCP_ERROR_CATEGORIES),
        fc.constantFrom(...SERVER_LABELS),
        async (category, label) => {
          const specs: McpToolsetSpec[] = [
            {
              type: "mcp",
              server_label: label,
              server_url: "https://one.example/mcp",
              authorization: "secret-token-value-1234",
            },
          ]
          const createClient = (): McpClientLike => ({
            async initialize() {},
            async listTools() {
              return [{ name: "search" }]
            },
            async callTool() {
              throw new McpProtocolError(
                category,
                "rejected, echoing header secret-token-value-1234",
              )
            },
          })

          const { tools, map } = await expandMcpToolsets(specs, { maxNameLength: 64, createClient })
          const outcome = await executeMcpToolCall(
            map,
            { name: String(tools[0].name), arguments: "not json" },
            { specs, createClient },
          )

          expect(outcome).toBeDefined()
          expect(outcome!.isError).toBe(true)
          expect(outcome!.errorCategory).toBe(category)
          expect(outcome!.identity.toolName).toBe("search")
          // Unparseable arguments are forwarded as text rather than rejected here.
          expect(outcome!.arguments).toBe("not json")
          expect(String(outcome!.content)).not.toContain("secret-token-value-1234")
          expect(String(outcome!.content)).toContain("[REDACTED]")
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * A notice must be the canonical shape and nothing more: the `mcpToolset` feature, a notice-legal
 * policy, and a non-empty detail written in protocol terms. No inbound wire vocabulary appears in
 * it — rendering is the inbound provider's job (Requirement 9.5).
 */
function assertCanonicalNotice(notice: Canonical_FeatureNotice): void {
  expect(Object.keys(notice).sort()).toEqual(["detail", "feature", "policy"])
  expect(notice.feature).toBe("mcpToolset")
  expect(["degrade", "emulate"]).toContain(notice.policy)
  expect(notice.detail.length).toBeGreaterThan(0)
  // Inbound-shaped prose and inbound wire names have no business in a core notice.
  for (const forbidden of ["system-reminder", "anthropic", "claude", "openai", "codex", "kiro"]) {
    expect(notice.detail.toLowerCase()).not.toContain(forbidden)
  }
}
