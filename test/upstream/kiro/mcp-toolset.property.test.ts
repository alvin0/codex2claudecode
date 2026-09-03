// Properties 32, 33, 26 and 31 for the Kiro-side MCP toolset bridge (tasks 35.4, 35.5, 35.6).
//
// Two layers, on purpose:
//
//  - **Module level**, against `src/upstream/kiro/mcp-toolset.ts` — expansion, interception, the
//    block pair, the counter, the egress allowlist, the redaction. Generated widely, no HTTP, so a
//    failure names the algorithm rather than the wiring.
//  - **Provider level**, against `src/upstream/kiro/index.ts` and `src/upstream/codex/index.ts` —
//    the three clauses of Property 32 that are claims about a *request*, not about this module:
//    the flag gate, a model-emitted call travelling through `./parse.ts` into the session, and
//    Codex taking zero emulation paths. These were deferred while task 35.2 was in flight and are
//    closed here now that it has landed.
//
// The only MCP endpoint any test in this file reaches is the loopback fixture from
// `test/native/mcp-fixture.ts` (Requirement 24.10): it binds 127.0.0.1 on an ephemeral port and is
// torn down with the file. Nothing here can leave the machine, and the fixture doubles as the
// *observer* for the negative clauses — "no MCP request was made" is `fixture.requests.length === 0`
// against a server that would have recorded one.
//
// **Validates: Requirements 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7, 22.8, 22.9**
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fc from "fast-check"

import { codexMcpToClaudeBlocks } from "../../../src/inbound/claude/mcp"
import { MCP_ERROR_CATEGORIES, McpProtocolError } from "../../../src/core/mcp/errors"
import type { McpClientLike } from "../../../src/core/mcp/toolset"
import type { McpRemoteTool, McpToolsetSpec } from "../../../src/core/mcp/types"
import type { Canonical_Event, Canonical_Request } from "../../../src/core/canonical"
import type { JsonObject } from "../../../src/core/types"
import { Codex_Upstream_Provider } from "../../../src/upstream/codex"
import { Kiro_Auth_Manager, Kiro_Client, Kiro_Upstream_Provider } from "../../../src/upstream/kiro"
import {
  confineFetch,
  createKiroMcpSession,
  kiroMcpBlocks,
  kiroMcpServerUrls,
  kiroMcpToolsets,
  mcpCallItemToBlocks,
  mcpCallOutputItem,
  requestDeclaresMcpToolsets,
} from "../../../src/upstream/kiro/mcp-toolset"
import {
  mcpFixtureEchoTool,
  mcpFixtureFailingTool,
  startNativeMcpFixture,
  type NativeMcpFixture,
} from "../../native/mcp-fixture"

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** How a generated server answers a `tools/call`. */
type CallBehaviour =
  | { kind: "ok"; content: unknown }
  | { kind: "isError"; content: unknown }
  | { kind: "throw"; error: unknown }

interface ServerFixture {
  label: string
  url: string
  tools: McRemoteToolLike[]
  call: CallBehaviour
  authorization?: string
}

type McRemoteToolLike = McpRemoteTool

/** Every `tools/call` the fake transport saw, so a test can count completed calls. */
interface CallLog {
  urls: string[]
  calls: Array<{ url: string; tool: string; args: unknown }>
}

function fakeClientFactory(servers: readonly ServerFixture[], log: CallLog) {
  const byUrl = new Map(servers.map((server) => [server.url, server]))
  return (spec: McpToolsetSpec): McpClientLike => {
    const url = spec.server_url ?? ""
    const server = byUrl.get(url)
    return {
      async initialize() {
        log.urls.push(url)
      },
      async listTools() {
        log.urls.push(url)
        return server?.tools ?? []
      },
      async callTool(name: string, args: unknown) {
        log.urls.push(url)
        log.calls.push({ url, tool: name, args })
        const behaviour = server?.call ?? { kind: "throw" as const, error: new Error("no server") }
        if (behaviour.kind === "throw") throw behaviour.error
        return { content: behaviour.content, isError: behaviour.kind === "isError" }
      },
    }
  }
}

/** The `mcp` tool entries a canonical request would carry for these servers. */
function requestTools(servers: readonly ServerFixture[]): JsonObject[] {
  return servers.map((server) => ({
    type: "mcp",
    server_label: server.label,
    server_url: server.url,
    ...(server.authorization ? { authorization: server.authorization } : {}),
  }))
}

async function drain(events: AsyncIterable<Canonical_Event>): Promise<Canonical_Event[]> {
  const collected: Canonical_Event[] = []
  for await (const event of events) collected.push(event)
  return collected
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

const identifier = fc
  .stringMatching(/^[a-z][a-z0-9_]{0,10}$/)
  .filter((value) => value.length > 0)

const host = identifier.map((name) => `${name}.example.test`)

const remoteTool: fc.Arbitrary<McpRemoteTool> = fc.record({
  name: identifier,
  description: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
})

const callBehaviour: fc.Arbitrary<CallBehaviour> = fc.oneof(
  fc.record({ kind: fc.constant("ok" as const), content: fc.oneof(fc.string(), fc.constant([{ type: "text", text: "ok" }]), fc.constant({ a: 1 })) }),
  fc.record({ kind: fc.constant("isError" as const), content: fc.string() }),
  fc.record({
    kind: fc.constant("throw" as const),
    error: fc.constantFrom(...MCP_ERROR_CATEGORIES).map((category) => new McpProtocolError(category, `${category} failed`)),
  }),
)

const serverFixture: fc.Arbitrary<ServerFixture> = fc
  .tuple(identifier, host, fc.uniqueArray(remoteTool, { minLength: 1, maxLength: 3, selector: (tool) => tool.name }), callBehaviour)
  .map(([label, hostname, tools, call]) => ({ label, url: `https://${hostname}/mcp`, tools, call }))

/** Distinct servers: two toolsets sharing a URL would resolve to one identity and blur the counts. */
const serverFixtures = fc.uniqueArray(serverFixture, { minLength: 1, maxLength: 3, selector: (server) => server.url })

/** Names a client tool might use — deliberately including `mcp__`-looking ones this map never made. */
const foreignName = fc.oneof(identifier, identifier.map((name) => `mcp__ghost__${name}`), fc.constant("web_search"))

// ---------------------------------------------------------------------------------------------
// Property 32 — orchestration is faithful
// ---------------------------------------------------------------------------------------------

describe("Feature: native-api-mode, Property 32: MCP emulation orchestration is faithful and flag-gated", () => {
  /**
   * The interception clause. For any sequence of model-emitted calls, a name this session exposed is
   * executed and replaced by exactly the `mcp_tool_use` / `mcp_tool_result` pair the existing
   * converter produces, and a name it did not expose passes through byte-for-byte.
   *
   * "Exactly the pair the existing converter produces" is asserted against
   * `codexMcpToClaudeBlocks()` itself, not against a hand-written expectation — that is what makes
   * the Kiro-side writer a reuse of the shared algorithm rather than a lookalike. The import is
   * legal here: the layer rules govern `src/`, and `test/` files are outside them.
   *
   * **Validates: Requirements 22.1, 22.2**
   */
  test("matching calls become the converter's block pair and non-matching calls pass through", async () => {
    await fc.assert(
      fc.asyncProperty(serverFixtures, fc.array(foreignName, { maxLength: 3 }), fc.string({ maxLength: 12 }), async (servers, foreign, rawArgs) => {
        const log: CallLog = { urls: [], calls: [] }
        const session = await createKiroMcpSession(requestTools(servers), {
          createClient: fakeClientFactory(servers, log),
          callId: () => "mcp_pinned",
        })

        const exposed = session.tools.map((tool) => String(tool.name))
        // Expansion order is toolset order, then server-advertised order — so the exposed list pairs
        // positionally with this flattening. Pairing by *name* would be ambiguous, because two
        // servers may advertise the same remote tool name and each still resolves to its own server.
        const origins = servers.flatMap((server) => server.tools.map((tool) => ({ server, tool: tool.name })))
        expect(exposed.length).toBe(origins.length)
        expect(session.active).toBe(true)

        // Every exposed name is intercepted, and the emitted pair names the remote tool and the
        // server it came from rather than the mangled exposed name.
        for (const [index, name] of exposed.entries()) {
          expect(session.handles(name)).toBe(true)
          const events = await drain(session.handleToolCall({ callId: `call_${name}`, name, arguments: "{}" }))
          expect(events.length).toBe(1)
          const event = events[0]
          expect(event.type).toBe("server_tool_block")
          const blocks = (event as { blocks: JsonObject[] }).blocks
          expect(blocks.map((block) => block.type)).toEqual(["mcp_tool_use", "mcp_tool_result"])
          expect(blocks[0].id).toBe("mcp_pinned")
          expect(blocks[1].tool_use_id).toBe("mcp_pinned")
          expect(String(blocks[0].name)).toBe(origins[index].tool)
          expect(String(blocks[0].server_name)).toBe(origins[index].server.label)
          // The call reached that server and no other.
          expect(log.calls.at(-1)).toEqual({ url: origins[index].server.url, tool: origins[index].tool, args: {} })
          // Equality with the shared converter is asserted over generated outcomes in the next
          // clause; here the claim is that the emitted pair is that converter's output shape.
          expect(typeof blocks[1].is_error).toBe("boolean")
        }

        // Foreign names are never intercepted and never reach the transport.
        const callsBefore = log.calls.length
        for (const name of foreign) {
          if (exposed.includes(name)) continue
          expect(session.handles(name)).toBe(false)
          const events = await drain(session.handleToolCall({ callId: "call_x", name, arguments: rawArgs }))
          expect(events).toEqual([{ type: "tool_call_done", callId: "call_x", name, arguments: rawArgs }])
        }
        expect(log.calls.length).toBe(callsBefore)
      }),
      { numRuns: 100 },
    )
  })

  /**
   * The `mcp_call` item this module builds and the block pair it emits agree with the shared
   * converter for **any** outcome, including failures and non-string payloads. Generated over
   * outcomes rather than over sessions, so it covers item shapes a live server may not produce.
   *
   * **Validates: Requirement 22.2**
   */
  test("kiroMcpBlocks equals codexMcpToClaudeBlocks on the same mcp_call item", () => {
    fc.assert(
      fc.property(
        identifier,
        identifier,
        fc.oneof(fc.string(), fc.constant([{ type: "text", text: "t" }]), fc.constant({ k: "v" }), fc.constant(null)),
        fc.boolean(),
        fc.dictionary(identifier, fc.oneof(fc.string(), fc.integer()), { maxKeys: 3 }),
        (serverLabel, toolName, content, isError, args) => {
          const outcome = {
            identity: { serverLabel, serverUrl: `https://${serverLabel}.example.test/mcp`, toolName },
            exposedName: `mcp__${serverLabel}__${toolName}`,
            arguments: args,
            content,
            isError,
          }
          const item = mcpCallOutputItem(outcome, { id: "mcp_fixed" })
          expect(kiroMcpBlocks(outcome, { id: "mcp_fixed" })).toEqual(codexMcpToClaudeBlocks(item))
          expect(mcpCallItemToBlocks(item)).toEqual(codexMcpToClaudeBlocks(item))
          // `is_error` tracks the outcome, which is Requirement 22.4's observable half.
          expect(mcpCallItemToBlocks(item)[1].is_error).toBe(isError)
        },
      ),
      { numRuns: 200 },
    )
  })

  /** A request with no `mcp` tool yields an inert session — no tools, no interception, no traffic. */
  test("a request declaring no MCP toolset produces an inert session", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ type: fc.constantFrom("function", "web_search", "web_fetch"), name: identifier }), { maxLength: 4 }), async (tools) => {
        const log: CallLog = { urls: [], calls: [] }
        const session = await createKiroMcpSession(tools as JsonObject[], { createClient: fakeClientFactory([], log) })
        expect(requestDeclaresMcpToolsets(tools as JsonObject[])).toBe(false)
        expect(session.tools).toEqual([])
        expect(session.active).toBe(false)
        expect(session.notices).toEqual([])
        expect(session.serverToolUseDelta()).toBeUndefined()
        expect(log.urls).toEqual([])
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Property 33 — egress confinement
// ---------------------------------------------------------------------------------------------

describe("Feature: native-api-mode, Property 33: MCP egress is confined to client-declared servers", () => {
  /**
   * For any request, every URL the MCP path hands to the HTTP layer is one the client declared in
   * its `mcp` tools. Run through the **real** core client so the assertion covers the transport
   * this module actually installs, with a recording `fetch` standing in for the network.
   *
   * Non-vacuity comes from the generated undeclared hosts in the next clause: without them, a
   * subset claim over a set that happens to contain everything proves nothing.
   *
   * **Validates: Requirement 22.6**
   */
  test("every URL reaching the HTTP layer was declared in mcp_servers", async () => {
    await fc.assert(
      fc.asyncProperty(serverFixtures, async (servers) => {
        const seen: string[] = []
        const tools = requestTools(servers)
        const declared = kiroMcpServerUrls(kiroMcpToolsets(tools))

        const session = await createKiroMcpSession(tools, {
          initialize: false,
          fetch: (async (input: Parameters<typeof fetch>[0]) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
            seen.push(url)
            const server = servers.find((candidate) => candidate.url === url)
            return Response.json({
              jsonrpc: "2.0",
              id: "1",
              result: { tools: server?.tools ?? [], content: [{ type: "text", text: "ok" }], isError: false },
            })
          }) as typeof fetch,
        })

        for (const tool of session.tools) {
          await drain(session.handleToolCall({ callId: "c", name: String(tool.name), arguments: "{}" }))
        }

        // Non-vacuity: one `tools/list` per declared server plus one `tools/call` per exposed tool
        // really did reach the transport, so the subset claim is made about observed traffic.
        expect(seen.length).toBe(declared.size + session.tools.length)
        for (const url of seen) expect(declared.has(new URL(url).toString())).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  /**
   * The confinement is a real refusal, not an accident of construction: a URL outside the declared
   * set is rejected before the wrapped `fetch` runs, and the declared ones still pass.
   *
   * **Validates: Requirement 22.6**
   */
  test("confineFetch refuses any undeclared URL and passes every declared one", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(host, { minLength: 1, maxLength: 3 }), host, async (declaredHosts, otherHost) => {
        const declaredUrls = declaredHosts.map((name) => `https://${name}/mcp`)
        const allowed = kiroMcpServerUrls(declaredUrls.map((url, index) => ({ server_label: `s${index}`, server_url: url })))
        let reached = 0
        const guarded = confineFetch((async () => {
          reached += 1
          return new Response("{}")
        }) as unknown as typeof fetch, allowed)

        for (const url of declaredUrls) {
          await guarded(url)
        }
        expect(reached).toBe(declaredUrls.length)

        const undeclared = `https://${otherHost}/other`
        if (allowed.has(new URL(undeclared).toString())) return
        await expect(guarded(undeclared)).rejects.toThrow(/MCP egress refused/)
        expect(reached).toBe(declaredUrls.length)
      }),
      { numRuns: 100 },
    )
  })

  /**
   * The boundary holds against a redirect, which the URL check alone cannot cover: a declared server
   * answering 3xx would otherwise have the transport repeat the request — credential included —
   * against a host that was never declared. So every confined request goes out with redirects
   * disabled, and the 3xx is answered as an ordinary non-OK response instead of being followed.
   *
   * **Validates: Requirement 22.6**
   */
  test("a confined request never follows a redirect out of the declared set", async () => {
    await fc.assert(
      fc.asyncProperty(host, host, fc.constantFrom(301, 302, 303, 307, 308), async (declaredHost, otherHost, status) => {
        const declared = `https://${declaredHost}/mcp`
        const elsewhere = `https://${otherHost}/moved`
        if (new URL(declared).toString() === new URL(elsewhere).toString()) return
        const allowed = kiroMcpServerUrls([{ server_label: "s", server_url: declared }])

        const seen: Array<{ url: string; redirect?: string }> = []
        const guarded = confineFetch((async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
          seen.push({ url, ...(init?.redirect ? { redirect: init.redirect } : {}) })
          // What a real `fetch` would hand back only *because* redirects were not followed.
          return new Response(null, { status, headers: { location: elsewhere } })
        }) as unknown as typeof fetch, allowed)

        const response = await guarded(declared, { method: "POST", body: "{}" })
        expect(response.status).toBe(status)
        expect(seen).toEqual([{ url: declared, redirect: "manual" }])
        // The undeclared target is still refused if anything tries to reach it directly.
        await expect(guarded(elsewhere)).rejects.toThrow(/MCP egress refused/)
        expect(seen.length).toBe(1)
      }),
      { numRuns: 100 },
    )
  })

  /**
   * Requirement 22.7's redaction half at the point where text leaves this module: a toolset's
   * `authorization` value never appears in a notice, and neither does the header value it was sent
   * with. The failing `tools/list` is what makes a notice exist to inspect.
   *
   * **Validates: Requirement 22.7**
   */
  test("no notice or contained failure carries an authorization value", async () => {
    const secret = fc.stringMatching(/^[A-Za-z0-9]{24,40}$/)
    await fc.assert(
      fc.asyncProperty(identifier, host, secret, async (label, hostname, token) => {
        const url = `https://${hostname}/mcp`
        const session = await createKiroMcpSession(
          [{ type: "mcp", server_label: label, server_url: url, authorization: token }],
          {
            // Fails `tools/list` with a body that echoes the credential back both ways a server can:
            // as an `authorization`-keyed field and as a bare value.
            createClient: () => ({
              async initialize() {},
              async listTools(): Promise<McpRemoteTool[]> {
                throw new McpProtocolError("http", `502 from server: {"authorization":"${token}"} raw=${token}`)
              },
              async callTool() {
                return { content: null, isError: false }
              },
            }),
          },
        )

        expect(session.notices.length).toBe(1)
        expect(session.tools).toEqual([])
        const detail = session.notices[0].detail
        expect(detail).not.toContain(token)
        expect(detail.length).toBeGreaterThan(0)
      }),
      { numRuns: 100 },
    )
  })

  /**
   * The `tools/call` half of the same claim. A failure during execution is contained into a result
   * block whose content the model — and every log downstream of it — reads, so the credential has to
   * be gone from *that* payload too, not only from a notice. Both echo shapes again: keyed, which
   * `SECRET_KEYS` catches, and bare, which only the literal pass can.
   *
   * **Validates: Requirement 22.7**
   */
  test("no contained tools/call failure block carries an authorization value", async () => {
    const secret = fc.stringMatching(/^[A-Za-z0-9]{24,40}$/)
    await fc.assert(
      fc.asyncProperty(identifier, identifier, host, secret, async (label, toolName, hostname, token) => {
        const session = await createKiroMcpSession(
          [{ type: "mcp", server_label: label, server_url: `https://${hostname}/mcp`, authorization: token }],
          {
            createClient: () => ({
              async initialize() {},
              async listTools(): Promise<McpRemoteTool[]> {
                return [{ name: toolName }]
              },
              async callTool(): Promise<{ content: unknown; isError: boolean }> {
                throw new McpProtocolError("http", `500 from server: {"authorization":"${token}"} raw=${token}`)
              },
            }),
          },
        )

        const exposed = String(session.tools[0].name)
        const events = await drain(session.handleToolCall({ callId: "c1", name: exposed, arguments: "{}" }))
        const blocks = (events[0] as { blocks: JsonObject[] }).blocks
        expect(blocks[1].is_error).toBe(true)
        expect(JSON.stringify(blocks)).not.toContain(token)
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Properties 26 and 31
// ---------------------------------------------------------------------------------------------

describe("Feature: native-api-mode, Property 26: Server-tool counters equal the number of completed calls", () => {
  /**
   * The `mcpCalls` half. For any sequence of calls — matching and not, succeeding and failing — the
   * session's counter equals the number of calls that completed, which is also the number of
   * `mcp_tool_result` blocks it emitted. A failed call still *completed*: it produced a result the
   * model can read, and Requirement 22.3 counts calls, not successes.
   *
   * **Validates: Requirement 22.3**
   */
  test("mcpCalls equals the number of completed MCP calls and of emitted result blocks", async () => {
    await fc.assert(
      fc.asyncProperty(serverFixtures, fc.array(foreignName, { maxLength: 4 }), async (servers, foreign) => {
        const log: CallLog = { urls: [], calls: [] }
        const session = await createKiroMcpSession(requestTools(servers), { createClient: fakeClientFactory(servers, log) })

        const exposed = session.tools.map((tool) => String(tool.name))
        const names = [...exposed, ...foreign.filter((name) => !exposed.includes(name))]
        let resultBlocks = 0
        for (const name of names) {
          for (const event of await drain(session.handleToolCall({ callId: "c", name, arguments: "{}" }))) {
            if (event.type !== "server_tool_block") continue
            resultBlocks += event.blocks.filter((block) => block.type === "mcp_tool_result").length
          }
        }

        expect(session.mcpCalls).toBe(exposed.length)
        expect(resultBlocks).toBe(exposed.length)
        expect(session.serverToolUseDelta()).toEqual(exposed.length ? { mcpCalls: exposed.length } : undefined)
        // A pass-through never counts, and never reaches the transport.
        expect(log.calls.length).toBe(exposed.length)
      }),
      { numRuns: 100 },
    )
  })
})

describe("Feature: native-api-mode, Property 31: MCP failures are contained and the request still completes", () => {
  /**
   * The `tools/call` half. For every failure category the protocol layer can raise, and for a
   * server-flagged `isError` result, the emitted result block carries `is_error: true`, the handler
   * yields exactly one event, and the surrounding stream reaches its terminal event.
   *
   * The terminal event is modelled explicitly: the harness interleaves the handler's output into a
   * stream that ends with `message_stop`, so "reaches its terminal event" is observed rather than
   * assumed from the handler returning. That the *live* Kiro stream does the same interleaving is
   * clause 2 of the deferred list — `./parse.ts` owns that call site.
   *
   * **Validates: Requirement 22.4**
   */
  test("a failing tools/call yields is_error and the stream still reaches message_stop", async () => {
    const failure = fc.oneof(
      fc.constantFrom(...MCP_ERROR_CATEGORIES).map((category) => ({ kind: "throw" as const, error: new McpProtocolError(category, `${category} boom`) })),
      fc.constant({ kind: "throw" as const, error: new Error("plain transport failure") }),
      fc.string({ maxLength: 20 }).map((text) => ({ kind: "isError" as const, content: text })),
    )

    await fc.assert(
      fc.asyncProperty(identifier, identifier, host, failure, async (label, toolName, hostname, call) => {
        const server: ServerFixture = { label, url: `https://${hostname}/mcp`, tools: [{ name: toolName }], call }
        const log: CallLog = { urls: [], calls: [] }
        const session = await createKiroMcpSession(requestTools([server]), { createClient: fakeClientFactory([server], log) })
        const exposed = String(session.tools[0].name)

        async function* stream(): AsyncIterable<Canonical_Event> {
          yield { type: "text_delta", delta: "before" }
          yield* session.handleToolCall({ callId: "c1", name: exposed, arguments: "{}" })
          yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, ...(session.serverToolUseDelta() ? { serverToolUse: session.serverToolUseDelta()! } : {}) } }
          yield { type: "message_stop", stopReason: "tool_use" }
        }

        const events = await drain(stream())
        expect(events.at(-1)).toEqual({ type: "message_stop", stopReason: "tool_use" })

        const blockEvents = events.filter((event) => event.type === "server_tool_block")
        expect(blockEvents.length).toBe(1)
        const blocks = (blockEvents[0] as { blocks: JsonObject[] }).blocks
        expect(blocks.map((block) => block.type)).toEqual(["mcp_tool_use", "mcp_tool_result"])
        expect(blocks[1].is_error).toBe(true)
        // The failure is visible to the model rather than swallowed.
        expect(Array.isArray(blocks[1].content)).toBe(true)

        // And it is counted: a contained failure is a completed call.
        expect(session.mcpCalls).toBe(1)
        const usage = events.find((event) => event.type === "usage") as { usage: { serverToolUse?: { mcpCalls?: number } } }
        expect(usage.usage.serverToolUse?.mcpCalls).toBe(1)
      }),
      { numRuns: 100 },
    )
  })
})
// ---------------------------------------------------------------------------------------------
// Property 32, the provider-level clauses
// ---------------------------------------------------------------------------------------------
//
// One loopback fixture for the whole section. It is both the MCP server the gateway is allowed to
// reach and the witness for the clauses that assert nothing was reached: a request the gateway
// never makes is a request this fixture never records.

let fixture: NativeMcpFixture

beforeAll(async () => {
  fixture = await startNativeMcpFixture({ tools: [mcpFixtureEchoTool(), mcpFixtureFailingTool("boom")] })
})

afterAll(async () => {
  await fixture?.stop()
})

/**
 * The 400 body an MCP-bearing request earns while `NATIVE_MCP_EMULATION` is off.
 *
 * Spelled out rather than imported, because the claim is precisely that this text did not change:
 * `MCP_TOOLSET_UNSUPPORTED_MESSAGE` is private to `./index.ts` and importing it would make the
 * assertion agree with whatever that constant becomes. Requirement 22.5 asks for the *existing*
 * 400, so the expectation has to be independent of the constant.
 */
const MCP_FLAG_OFF_400 = "Kiro upstream does not support generic server-side MCP toolsets. Use normal client function tools or the gateway web_search helper instead."

function kiroAuth() {
  return new Kiro_Auth_Manager(
    {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: new Date(Date.now() + 700_000).toISOString(),
      region: "us-east-1",
    },
    "/tmp/unused",
  )
}

function canonicalRequest(tools: JsonObject[], stream: boolean): Canonical_Request {
  return {
    model: "claude-sonnet-4-5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    tools,
    stream,
    passthrough: false,
    metadata: {},
  }
}

/** The `mcp` tool a client declares for the fixture, carrying a credential worth not leaking. */
function fixtureMcpTool(label: string, authorization?: string): JsonObject {
  return {
    type: "mcp",
    server_label: label,
    server_url: fixture.url,
    ...(authorization ? { authorization } : {}),
  }
}

/** Kiro's own response framing: the parser reads bare concatenated JSON events. */
function kiroBody(events: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(new TextEncoder().encode(event))
      controller.close()
    },
  })
}

/** Expanded MCP tool names as they appear in the built Kiro payload. */
function expandedNamesIn(payloadJson: string): string[] {
  return [...payloadJson.matchAll(/"name":"(mcp__[^"]+)"/g)].map((match) => match[1])
}

async function collect(events: AsyncIterable<Canonical_Event>) {
  const collected: Canonical_Event[] = []
  for await (const event of events) collected.push(event)
  return collected
}

describe("Feature: native-api-mode, Property 32: MCP emulation orchestration is faithful and flag-gated", () => {
  /**
   * The flag-gate clause. With `NATIVE_MCP_EMULATION` off, every MCP-bearing request gets the same
   * 400 it got before the emulation path existed — byte for byte, since the alternative it names is
   * what the client acts on — and neither the Kiro endpoint nor the declared MCP server is touched.
   *
   * Generated over the label, over whether other tools ride along, and over `require_approval`,
   * because the gate has to win *before* any of those are interpreted: a withheld-by-approval
   * toolset and an unrestricted one both owe the client this one 400 while the flag is off.
   *
   * **Validates: Requirements 22.5, 22.9**
   */
  test("with the flag disabled every MCP-bearing request returns the existing 400 and reaches no server", async () => {
    await fc.assert(
      fc.asyncProperty(
        identifier,
        fc.boolean(),
        fc.constantFrom<unknown>(undefined, "never", "always", { read_only: true }),
        fc.boolean(),
        async (label, withFunctionTool, approval, stream) => {
          fixture.reset()
          let upstreamCalls = 0
          const manager = kiroAuth()
          const client = new Kiro_Client(manager, {
            fetch: (() => {
              upstreamCalls += 1
              return Promise.resolve(new Response("{}"))
            }) as unknown as typeof fetch,
          })
          const provider = new Kiro_Upstream_Provider({ auth: manager, client, mcpEmulation: false })

          const tools: JsonObject[] = [
            { ...fixtureMcpTool(label), ...(approval === undefined ? {} : { require_approval: approval as JsonObject }) },
            ...(withFunctionTool ? [{ type: "function", name: "save" }] : []),
          ]
          const result = await provider.proxy(canonicalRequest(tools, stream))

          expect(result).toMatchObject({ type: "canonical_error", status: 400 })
          expect((result as { body: string }).body).toContain(MCP_FLAG_OFF_400)
          // No upstream call, and — the part that matters for Requirement 22.6 — no MCP call either:
          // a refused request opens no connection to the client's server.
          expect(upstreamCalls).toBe(0)
          expect(fixture.requests.length).toBe(0)
        },
      ),
      { numRuns: 40 },
    )
  })

  /**
   * The end-to-end interception clause. With the flag on, a model-emitted call naming an expanded
   * MCP tool travels `./parse.ts` → `KiroMcpSession.handleToolCall()` → the declared server, comes
   * back as the `mcp_tool_use` / `mcp_tool_result` pair, and is counted in the terminal `usage`
   * event; a call naming a client function tool in the same stream passes through untouched.
   *
   * Deliberately driven through `Kiro_Upstream_Provider.proxy()` rather than through the session
   * directly, because what is being asserted is the wiring: the expanded tool reaching the payload,
   * the interception point in the parser, and the `mcpCalls` merge into `serverToolUse`. The Kiro
   * endpoint is faked at the `fetch` seam; the MCP server is real, on loopback.
   *
   * The credential assertion is Requirement 22.7's other half at the boundary where a log is taken:
   * `onRequestBody` is the exact string the request log records, and the client's `authorization`
   * must not be in it. It cannot be — `computeEffectiveTools()` forwards only `function` tools, so
   * the declared `mcp` tool never reaches the payload — and this pins that.
   *
   * **Validates: Requirements 22.1, 22.2, 22.3, 22.7**
   */
  test("with the flag enabled a matching call is executed through the stream and counted in usage", async () => {
    await fc.assert(
      fc.asyncProperty(
        identifier,
        fc.stringMatching(/^[a-z ]{1,12}$/),
        fc.stringMatching(/^[A-Za-z0-9]{24,40}$/),
        async (label, echoText, token) => {
          fixture.reset()
          let payloadJson = ""
          const manager = kiroAuth()
          const client = new Kiro_Client(manager, {
            fetch: ((_url: unknown, init?: { body?: unknown }) => {
              // The model calls whatever the payload offered it, so the expanded name is read back
              // out of the payload rather than reconstructed from the mangling rule.
              const expanded = expandedNamesIn(String(init?.body ?? ""))[0] ?? "missing"
              return Promise.resolve(
                new Response(
                  kiroBody([
                    '{"content":"working"}',
                    JSON.stringify({ name: expanded, toolUseId: "call_1", input: JSON.stringify({ text: echoText }) }),
                    JSON.stringify({ name: "save", toolUseId: "call_2", input: "{}" }),
                    '{"stop":true}',
                  ]),
                ),
              )
            }) as unknown as typeof fetch,
          })
          const provider = new Kiro_Upstream_Provider({ auth: manager, client, mcpEmulation: true })

          const result = await provider.proxy(
            canonicalRequest([fixtureMcpTool(label, token), { type: "function", name: "save" }], true),
            { onRequestBody: (body) => { payloadJson = body } },
          )
          expect(result.type).toBe("canonical_stream")
          if (result.type !== "canonical_stream") return

          const events = await collect(result.events)

          // The toolset was expanded before the payload was built (Requirement 22.1).
          const expanded = expandedNamesIn(payloadJson)
          expect(expanded.length).toBe(2)
          expect(payloadJson).not.toContain(token)

          // The matching call was executed against the declared server and nothing else was.
          expect(fixture.toolCallNames()).toEqual(["echo"])
          expect(fixture.authorizationValues().every((value) => value === `Bearer ${token}`)).toBe(true)

          // …and replaced by the converter's pair (Requirement 22.2).
          const blockEvents = events.filter((event) => event.type === "server_tool_block")
          expect(blockEvents.length).toBe(1)
          const blocks = (blockEvents[0] as { blocks: JsonObject[] }).blocks
          expect(blocks.map((block) => block.type)).toEqual(["mcp_tool_use", "mcp_tool_result"])
          expect(blocks[0].name).toBe("echo")
          expect(blocks[0].server_name).toBe(label)
          expect(blocks[1].is_error).toBe(false)
          expect(JSON.stringify(blocks[1].content)).toContain(echoText)

          // The non-matching call passed through unchanged.
          const passThrough = events.filter((event) => event.type === "tool_call_done")
          expect(passThrough).toEqual([{ type: "tool_call_done", callId: "call_2", name: "save", arguments: "{}" }])

          // And the terminal usage event carries exactly one MCP call (Requirement 22.3).
          const usage = events.find((event) => event.type === "usage") as { usage: { serverToolUse?: { mcpCalls?: number } } }
          expect(usage.usage.serverToolUse?.mcpCalls).toBe(1)
          expect(events.at(-1)?.type).toBe("message_stop")
        },
      ),
      { numRuns: 15 },
    )
  })

  /**
   * The Codex clause. Codex declares `mcpToolset: "native"`, so an MCP toolset sent to it is
   * forwarded verbatim in the upstream body and no emulation path runs: no expansion, no executor,
   * no connection to the client's server.
   *
   * "The executor is never invoked" is observed three ways, because the interesting failure is a
   * silent one: the declared toolset is still in the body (it was forwarded, not consumed), no
   * `mcp__`-prefixed function tool appears (nothing was expanded into one), and the loopback server
   * recorded nothing (nothing was called).
   *
   * **Validates: Requirement 22.8**
   */
  test("an MCP toolset sent to Codex is forwarded natively and invokes no executor", async () => {
    await fc.assert(
      fc.asyncProperty(identifier, fc.stringMatching(/^[A-Za-z0-9]{24,40}$/), fc.boolean(), async (label, token, stream) => {
        fixture.reset()
        let bodyJson = ""
        const toolset = fixtureMcpTool(label, token)
        const provider = new Codex_Upstream_Provider({
          client: {
            proxy: async () =>
              new Response(
                `data: ${JSON.stringify({ type: "response.output_text.done", text: "ok" })}\n\n` +
                  `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
                { headers: { "content-type": "text/event-stream" } },
              ),
          } as never,
        })

        const result = await provider.proxy(
          canonicalRequest([toolset, { type: "function", name: "save" }], stream),
          { onRequestBody: (body) => { bodyJson = body } },
        )
        expect(result.type).toBe(stream ? "canonical_stream" : "canonical_response")

        const body = JSON.parse(bodyJson) as { tools?: JsonObject[] }
        expect(body.tools).toContainEqual(toolset)
        expect(expandedNamesIn(bodyJson)).toEqual([])
        expect(fixture.requests.length).toBe(0)
      }),
      { numRuns: 25 },
    )
  })
})

describe("Feature: native-api-mode, Property 31: MCP failures are contained and the request still completes", () => {
  /**
   * The same containment claim, observed on a real request instead of on a modelled stream: the
   * fixture's always-failing tool is called through `proxy()`, and the client still receives a
   * result block marked `is_error` followed by the stream's own terminal event.
   *
   * This is the clause the module-level test could only model while the parser had no interception
   * point: "the stream reaches its terminal event" is now `message_stop` from `./parse.ts`, after a
   * failure, with the failure visible to the model rather than swallowed.
   *
   * **Validates: Requirements 22.3, 22.4**
   */
  test("a failing MCP call still lets the Kiro stream reach message_stop, and is still counted", async () => {
    await fc.assert(
      fc.asyncProperty(identifier, async (label) => {
        fixture.reset()
        const manager = kiroAuth()
        const client = new Kiro_Client(manager, {
          fetch: ((_url: unknown, init?: { body?: unknown }) => {
            const failing = expandedNamesIn(String(init?.body ?? "")).find((name) => name.endsWith("boom")) ?? "missing"
            return Promise.resolve(
              new Response(
                kiroBody([
                  JSON.stringify({ name: failing, toolUseId: "call_1", input: "{}" }),
                  '{"stop":true}',
                ]),
              ),
            )
          }) as unknown as typeof fetch,
        })
        const provider = new Kiro_Upstream_Provider({ auth: manager, client, mcpEmulation: true })

        const result = await provider.proxy(canonicalRequest([fixtureMcpTool(label)], true), {})
        expect(result.type).toBe("canonical_stream")
        if (result.type !== "canonical_stream") return

        const events = await collect(result.events)
        expect(fixture.toolCallNames()).toEqual(["boom"])

        const blocks = (events.find((event) => event.type === "server_tool_block") as { blocks: JsonObject[] }).blocks
        expect(blocks.map((block) => block.type)).toEqual(["mcp_tool_use", "mcp_tool_result"])
        expect(blocks[1].is_error).toBe(true)
        // A contained failure is a completed call: the model got an answer it can act on.
        const usage = events.find((event) => event.type === "usage") as { usage: { serverToolUse?: { mcpCalls?: number } } }
        expect(usage.usage.serverToolUse?.mcpCalls).toBe(1)
        expect(events.at(-1)?.type).toBe("message_stop")
      }),
      { numRuns: 15 },
    )
  })
})
