// Offline tests for the loopback MCP fixture. Nothing here reaches the network beyond
// 127.0.0.1, which is the property Requirement 24.10 asks the harness to guarantee.
import { afterEach, describe, expect, test } from "bun:test"
import fc from "fast-check"

import { NATIVE_MCP_SERVER_NAME, nativeLiveCase, resolveNativeCaseBody } from "./cases"
import {
  isLoopbackMcpUrl,
  MCP_FIXTURE_ERROR_CODES,
  MCP_FIXTURE_PROTOCOL_VERSION,
  mcpFixtureEchoTool,
  mcpFixtureFailingTool,
  startNativeMcpFixture,
  withNativeMcpFixture,
  type NativeMcpFixture,
} from "./mcp-fixture"

const running: NativeMcpFixture[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((fixture) => fixture.stop().catch(() => {})))
})

async function fixture(options: Parameters<typeof startNativeMcpFixture>[0] = {}) {
  const started = await startNativeMcpFixture(options)
  running.push(started)
  return started
}

/** One JSON-RPC round trip against the fixture. */
async function rpc(target: NativeMcpFixture, body: unknown, init: RequestInit = {}) {
  const response = await fetch(target.url, {
    method: "POST",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as any }
}

describe("native MCP fixture", () => {
  test("binds loopback on an ephemeral port and exposes the endpoint url", async () => {
    const target = await fixture()
    expect(target.hostname).toBe("127.0.0.1")
    expect(target.port).toBeGreaterThan(0)
    expect(target.url).toBe(`http://127.0.0.1:${target.port}/mcp`)
    expect(isLoopbackMcpUrl(target.url)).toBe(true)
    expect(target.serverName).toBe(NATIVE_MCP_SERVER_NAME)
  })

  test("the loopback check rejects an internet-hosted server url", () => {
    for (const url of ["http://127.0.0.1:9/mcp", "http://localhost:9/mcp", "http://[::1]:9/mcp"]) {
      expect(isLoopbackMcpUrl(url)).toBe(true)
    }
    for (const url of ["https://mcp.example.com/mcp", "http://10.0.0.5/mcp", "http://169.254.169.254/", "not a url"]) {
      expect(isLoopbackMcpUrl(url)).toBe(false)
    }
  })

  test("a case body resolves to the fixture's loopback url", async () => {
    const target = await fixture()
    const body = resolveNativeCaseBody(nativeLiveCase("mcp-toolset-kiro"), { mcpServerUrl: target.url })
    const servers = body.mcp_servers as Array<{ url: string }>
    expect(servers[0].url).toBe(target.url)
    expect(isLoopbackMcpUrl(servers[0].url)).toBe(true)
  })

  test("round-trips initialize, tools/list, and tools/call and records the call sequence", async () => {
    const target = await fixture()

    const initialize = await rpc(target, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    expect(initialize.status).toBe(200)
    expect(initialize.json).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: MCP_FIXTURE_PROTOCOL_VERSION, serverInfo: { name: NATIVE_MCP_SERVER_NAME } },
    })

    const list = await rpc(target, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    const tools = list.json.result.tools as Array<{ name: string; inputSchema: any }>
    const echo = tools.find((tool) => tool.name === "echo")
    expect(echo).toBeDefined()
    expect(echo!.inputSchema.type).toBe("object")
    expect(echo!.inputSchema.properties.text.type).toBe("string")

    const call = await rpc(
      target,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "ping" } } },
      { headers: { authorization: "Bearer fixture-token" } },
    )
    // The text-embedded envelope of Requirement 20.3.
    expect(call.json.result.isError).toBe(false)
    expect(call.json.result.content[0].type).toBe("text")
    expect(JSON.parse(call.json.result.content[0].text)).toEqual({ echo: "ping" })

    expect(target.methodSequence()).toEqual(["initialize", "tools/list", "tools/call"])
    expect(target.toolCallNames()).toEqual(["echo"])
    expect(target.authorizationValues()).toEqual([undefined, undefined, "Bearer fixture-token"])
    expect(target.requests[2].params).toMatchObject({ name: "echo", arguments: { text: "ping" } })
    expect(target.requests[2].body).toContain("ping")

    target.reset()
    expect(target.requests).toHaveLength(0)
  })

  test("an unknown method returns a JSON-RPC error", async () => {
    const target = await fixture()
    const response = await rpc(target, { jsonrpc: "2.0", id: 7, method: "resources/list" })
    expect(response.json).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: MCP_FIXTURE_ERROR_CODES.methodNotFound, message: "Method not found: resources/list" },
    })
    expect(target.methodSequence()).toEqual(["resources/list"])
  })

  test("malformed bodies and non-JSON-RPC envelopes return errors instead of results", async () => {
    const target = await fixture()
    const parseError = await rpc(target, "{ not json")
    expect(parseError.json.error.code).toBe(MCP_FIXTURE_ERROR_CODES.parseError)

    const invalid = await rpc(target, { id: 1, method: "tools/list" })
    expect(invalid.json.error.code).toBe(MCP_FIXTURE_ERROR_CODES.invalidRequest)
  })

  test("an unknown tool and a failing tool both answer with is_error rather than dropping the call", async () => {
    const target = await fixture({ extraTools: [mcpFixtureFailingTool()] })

    const unknown = await rpc(target, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } })
    expect(unknown.json.result.isError).toBe(true)
    expect(JSON.parse(unknown.json.result.content[0].text).error).toContain("nope")

    const failing = await rpc(target, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "boom" } })
    expect(failing.json.result.isError).toBe(true)
    expect(JSON.parse(failing.json.result.content[0].text).error).toContain("on purpose")
  })

  test("records the authorization header and can require it, so forwarding is observable", async () => {
    const target = await fixture({ requireAuthorization: "Bearer expected" })

    const missing = await rpc(target, { jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(missing.status).toBe(401)
    expect(missing.json.error.code).toBe(MCP_FIXTURE_ERROR_CODES.unauthorized)

    const supplied = await rpc(target, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { headers: { authorization: "Bearer expected" } })
    expect(supplied.status).toBe(200)
    expect(supplied.json.result.tools).toHaveLength(1)
    expect(target.authorizationValues()).toEqual([undefined, "Bearer expected"])
  })

  test("serves only its endpoint path and only POST", async () => {
    const target = await fixture()
    expect((await fetch(`http://127.0.0.1:${target.port}/other`, { method: "POST", body: "{}" })).status).toBe(404)
    expect((await fetch(target.url)).status).toBe(405)
  })

  test("stop closes the server", async () => {
    const target = await startNativeMcpFixture()
    expect((await rpc(target, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200)
    await target.stop()
    await expect(fetch(target.url, { method: "POST", body: "{}" })).rejects.toThrow()
  })

  test("withNativeMcpFixture stops the server even when the body throws", async () => {
    let url = ""
    await expect(
      withNativeMcpFixture({}, async (target) => {
        url = target.url
        throw new Error("case failed")
      }),
    ).rejects.toThrow("case failed")
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow()
  })
})

describe("native MCP fixture properties", () => {
  test("echo returns whatever text it was handed, for any text", async () => {
    const target = await fixture({ tools: [mcpFixtureEchoTool()] })
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.integer({ min: 1, max: 10_000 }), async (text, id) => {
        const response = await rpc(target, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "echo", arguments: { text } } })
        expect(response.json.id).toBe(id)
        expect(JSON.parse(response.json.result.content[0].text)).toEqual({ echo: text })
      }),
      { numRuns: 25 },
    )
  })

  test("every method name outside the supported three answers with an error, never a result", async () => {
    const target = await fixture()
    const supported = new Set(["initialize", "tools/list", "tools/call", "notifications/initialized"])
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((method) => !supported.has(method) && method.trim().length > 0),
        async (method) => {
          const response = await rpc(target, { jsonrpc: "2.0", id: 1, method })
          expect(response.json.result).toBeUndefined()
          expect(response.json.error.code).toBe(MCP_FIXTURE_ERROR_CODES.methodNotFound)
        },
      ),
      { numRuns: 25 },
    )
  })
})
