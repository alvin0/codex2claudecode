// Role: the loopback MCP server the `mcp-toolset-kiro` and `mcp-approval-reject` cases point
// at (Requirement 24.10). A live case never talks to an internet-hosted MCP server, so the
// only MCP endpoint a harness run can reach is this one, bound to 127.0.0.1 on an ephemeral
// port and torn down with the case.
//
// Security note: this is a test fixture, not a network-exposed service. It performs no
// authentication of its own — loopback binding is the whole boundary. `requireAuthorization`
// exists so a test can observe how the gateway forwards (or withholds) the client-declared
// `authorization` value; it is an assertion aid, never a security control. Nothing here is
// reachable from outside the machine, and nothing here is imported by `src/`.
//
// Protocol surface: JSON-RPC 2.0 over HTTP for `initialize`, `tools/list`, and `tools/call`,
// the same three methods `src/core/mcp/client.ts` will speak. `tools/call` answers in the
// text-embedded envelope `{result:{content:[{type:"text",text:"<json>"}]}}` that
// Requirement 20.3 names, because that is the shape the client must be proven to parse.
import type { JsonObject } from "../../src/core/types"

import { NATIVE_MCP_SERVER_NAME } from "./cases"

/** JSON-RPC error codes the fixture uses, from the JSON-RPC 2.0 specification. */
export const MCP_FIXTURE_ERROR_CODES = {
  parseError: -32_700,
  invalidRequest: -32_600,
  methodNotFound: -32_601,
  invalidParams: -32_602,
  unauthorized: -32_001,
} as const

export const MCP_FIXTURE_PROTOCOL_VERSION = "2025-06-18"

/** Default endpoint path, matching the `/mcp` path Kiro itself exposes. */
export const MCP_FIXTURE_PATH = "/mcp"

/** One tool the fixture advertises through `tools/list` and dispatches through `tools/call`. */
export interface McpFixtureTool {
  name: string
  description: string
  /** JSON Schema for the tool arguments, returned verbatim by `tools/list`. */
  inputSchema: JsonObject
  /**
   * Produces the payload embedded as JSON text in the `tools/call` result. Throwing marks
   * the result `isError: true` instead of failing the request, which is the shape the
   * gateway turns into an `is_error` result block (Requirement 22.4).
   */
  call: (args: JsonObject) => unknown | Promise<unknown>
}

/** One request the fixture received, in arrival order. */
export interface McpFixtureRequest {
  /** JSON-RPC method, or `undefined` when the body was unparseable or carried no method. */
  method?: string
  id?: string | number | null
  params?: JsonObject
  /** Tool name for a `tools/call`, so a test can assert the call sequence directly. */
  toolName?: string
  /** Raw `authorization` header as received. Present only when the caller sent one. */
  authorization?: string
  headers: Readonly<Record<string, string>>
  /** Raw request body, kept so a transcript can show exactly what arrived. */
  body: string
  at: number
}

export interface NativeMcpFixtureOptions {
  /** Replaces the default single-`echo` tool list. */
  tools?: readonly McpFixtureTool[]
  /** Additional tools alongside the defaults. */
  extraTools?: readonly McpFixtureTool[]
  /**
   * When set, a request whose `authorization` header does not match is answered with a
   * JSON-RPC error. An assertion aid for authorization forwarding, not a security control.
   */
  requireAuthorization?: string
  /** Endpoint path. Requests to any other path get a 404. */
  path?: string
}

export interface NativeMcpFixture {
  /** Loopback endpoint to substitute for `{{MCP_SERVER_URL}}` in a case body. */
  url: string
  port: number
  hostname: string
  /** Server name the case registry declares in `mcp_servers`. */
  serverName: string
  /** Requests received, in arrival order. */
  requests: readonly McpFixtureRequest[]
  /** JSON-RPC methods in arrival order, the call sequence a test asserts on. */
  methodSequence: () => string[]
  /** Tool names passed to `tools/call`, in arrival order. */
  toolCallNames: () => string[]
  /** `authorization` values received, in arrival order; `undefined` for a header-less request. */
  authorizationValues: () => Array<string | undefined>
  reset: () => void
  stop: () => Promise<void>
}

/** The one tool every case needs: it returns its own input so a result is checkable. */
export function mcpFixtureEchoTool(): McpFixtureTool {
  return {
    name: "echo",
    description: "Returns the text it was given.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo back." } },
      required: ["text"],
      additionalProperties: false,
    },
    call: (args) => ({ echo: typeof args.text === "string" ? args.text : "" }),
  }
}

/** A tool that always fails, for exercising the `is_error` result path. */
export function mcpFixtureFailingTool(name = "boom"): McpFixtureTool {
  return {
    name,
    description: "Always fails.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    call: () => {
      throw new Error(`${name} failed on purpose`)
    },
  }
}

/** True when `url` resolves to the loopback interface (Requirement 24.10, Property 37). */
export function isLoopbackMcpUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host.startsWith("127.")
}

export async function startNativeMcpFixture(options: NativeMcpFixtureOptions = {}): Promise<NativeMcpFixture> {
  const endpointPath = options.path ?? MCP_FIXTURE_PATH
  const tools = [...(options.tools ?? [mcpFixtureEchoTool()]), ...(options.extraTools ?? [])]
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const requests: McpFixtureRequest[] = []

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== endpointPath) return new Response("not found", { status: 404 })
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 })

      const body = await request.text()
      const headers = Object.fromEntries(request.headers.entries())
      const authorization = request.headers.get("authorization") ?? undefined

      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        requests.push({ headers, body, at: Date.now(), ...(authorization ? { authorization } : {}) })
        return jsonRpcError(null, MCP_FIXTURE_ERROR_CODES.parseError, "Parse error")
      }

      const envelope = isObject(parsed) ? parsed : {}
      const method = typeof envelope.method === "string" ? envelope.method : undefined
      const id = jsonRpcId(envelope.id)
      const params = isObject(envelope.params) ? envelope.params : undefined
      const toolName = method === "tools/call" && typeof params?.name === "string" ? params.name : undefined

      requests.push({
        headers,
        body,
        at: Date.now(),
        ...(method ? { method } : {}),
        ...(id === undefined ? {} : { id }),
        ...(params ? { params } : {}),
        ...(toolName ? { toolName } : {}),
        ...(authorization ? { authorization } : {}),
      })

      if (envelope.jsonrpc !== "2.0" || !method) {
        return jsonRpcError(id ?? null, MCP_FIXTURE_ERROR_CODES.invalidRequest, "Invalid Request")
      }

      if (options.requireAuthorization !== undefined && authorization !== options.requireAuthorization) {
        return jsonRpcError(id ?? null, MCP_FIXTURE_ERROR_CODES.unauthorized, "Unauthorized", 401)
      }

      if (method === "initialize") {
        return jsonRpcResult(id ?? null, {
          protocolVersion: MCP_FIXTURE_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: NATIVE_MCP_SERVER_NAME, version: "0.0.0-fixture" },
        })
      }

      if (method === "notifications/initialized") return new Response(null, { status: 202 })

      if (method === "tools/list") {
        return jsonRpcResult(id ?? null, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        })
      }

      if (method === "tools/call") {
        if (!toolName) return jsonRpcError(id ?? null, MCP_FIXTURE_ERROR_CODES.invalidParams, "Missing tool name")
        const tool = byName.get(toolName)
        if (!tool) return jsonRpcToolResult(id ?? null, { error: `Unknown tool: ${toolName}` }, true)
        const args = isObject(params?.arguments) ? params.arguments : {}
        try {
          return jsonRpcToolResult(id ?? null, await tool.call(args), false)
        } catch (error) {
          return jsonRpcToolResult(id ?? null, { error: error instanceof Error ? error.message : String(error) }, true)
        }
      }

      return jsonRpcError(id ?? null, MCP_FIXTURE_ERROR_CODES.methodNotFound, `Method not found: ${method}`)
    },
  })

  const port = server.port
  if (!port) {
    await server.stop(true)
    throw new Error("The MCP fixture started without exposing a port")
  }

  const url = `http://127.0.0.1:${port}${endpointPath}`
  if (!isLoopbackMcpUrl(url)) {
    await server.stop(true)
    throw new Error(`The MCP fixture bound a non-loopback url: ${url}`)
  }

  return {
    url,
    port,
    hostname: "127.0.0.1",
    serverName: NATIVE_MCP_SERVER_NAME,
    requests,
    methodSequence: () => requests.flatMap((entry) => (entry.method ? [entry.method] : [])),
    toolCallNames: () => requests.flatMap((entry) => (entry.toolName ? [entry.toolName] : [])),
    authorizationValues: () => requests.map((entry) => entry.authorization),
    reset() {
      requests.length = 0
    },
    async stop() {
      await server.stop(true)
    },
  }
}

/**
 * Runs `body` with a fixture and stops it afterwards, so a case cannot leak a listening
 * socket into the next case even when it throws.
 */
export async function withNativeMcpFixture<T>(
  options: NativeMcpFixtureOptions,
  body: (fixture: NativeMcpFixture) => Promise<T>,
): Promise<T> {
  const fixture = await startNativeMcpFixture(options)
  try {
    return await body(fixture)
  } finally {
    await fixture.stop()
  }
}

function jsonRpcResult(id: string | number | null, result: JsonObject) {
  return Response.json({ jsonrpc: "2.0", id, result })
}

/** The text-embedded envelope of Requirement 20.3. */
function jsonRpcToolResult(id: string | number | null, payload: unknown, isError: boolean) {
  return Response.json({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError },
  })
}

function jsonRpcError(id: string | number | null, code: number, message: string, status = 200) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status })
}

function jsonRpcId(value: unknown): string | number | null | undefined {
  if (value === null) return null
  if (typeof value === "string" || typeof value === "number") return value
  return undefined
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
