// Property 28 for the provider-agnostic MCP JSON-RPC client (task 31.4).
//
// The client sits between a caller that speaks canonical shapes and a remote server that speaks
// JSON-RPC 2.0 over HTTP, so everything worth asserting here is a round trip or a classification:
//
//   1. What goes out is a well-formed JSON-RPC 2.0 request — version `"2.0"`, a fresh id per call,
//      and the caller's `method` and `params` unchanged (Requirements 20.1, 20.2).
//   2. What comes back through the text-embedded envelope
//      `{result:{content:[{type:"text",text:"<json>"}]}}` is the *value* the server encoded — any
//      JSON value, not just an object (Requirement 20.3).
//   3. A failure is a throw carrying a category from the closed set, never a quietly empty result.
//      Text that is not JSON and a JSON-RPC `error` object are the two shapes a well-behaved
//      transport can still hand back, and both must classify (Requirements 20.4, 20.5).
//   4. The outgoing `authorization` header derives from the authorization material passed in and
//      from nothing else — no credential file, no ambient default (Requirement 20.2).
//
// Examples cannot carry clauses 1 and 2. "Params survive the envelope" is a claim about every JSON
// value, and the interesting cases are the ones nobody writes by hand: a bare `null` result, a
// number, a string that is itself valid JSON, an empty array. So the generators produce arbitrary
// JSON rather than a fixture, and clause 3's non-JSON generator is filtered by actually running
// `JSON.parse`, so a generated string that happens to parse is excluded rather than mis-asserted.
//
// No network: every case injects a `fetch` that records the outgoing request and replies from the
// generated data. Nothing here reads a credential file, which is also the point of clause 4.
//
// **Validates: Requirements 20.1, 20.2, 20.3, 20.4, 20.5**

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import {
  MCP_ERROR_CATEGORIES,
  McpProtocolError,
  type McpErrorCategory,
} from "../../../src/core/mcp/errors"
import {
  MCP_PROTOCOL_VERSION,
  McpClient,
  buildJsonRpcRequest,
  parseMcpTextEnvelope,
} from "../../../src/core/mcp/client"

const SERVER_URL = "https://mcp.invalid/rpc"

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

/**
 * Arbitrary JSON, hand-rolled rather than `fc.jsonValue()` for one reason: `-0` survives neither
 * `JSON.stringify` nor a deep-equality claim about "the same value", and excluding it at the leaf is
 * clearer than filtering a whole generated tree.
 */
const jsonScalar = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -100000, max: 100000 }),
  fc
    .double({ min: -1e9, max: 1e9, noNaN: true, noDefaultInfinity: true })
    .filter((value) => !Object.is(value, -0)),
  fc.string(),
)

const jsonValue: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    jsonScalar,
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), tie("value"), { maxKeys: 4 }),
  ),
})).value

/** MCP's three methods plus arbitrary names, since `request()` forwards whatever it is handed. */
const methodName = fc.oneof(
  fc.constantFrom("initialize", "tools/list", "tools/call"),
  fc.string({ minLength: 1, maxLength: 24 }).filter((name) => name.trim().length > 0),
)

/**
 * Credential-shaped material: some already carrying a scheme, some bare.
 *
 * At least 12 token characters. The clause below asserts that a *superseded* credential appears
 * nowhere in the request, and a one- or two-character "credential" collides with the random request
 * id by chance, which would make the test report a coincidence as a leak. Real bearer material is
 * never that short, so the floor removes a test artifact rather than weakening the claim.
 */
const credentialToken = fc
  .array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-".split("")), {
    minLength: 12,
    maxLength: 40,
  })
  .map((chars) => chars.join(""))

const bearerMaterial = fc.oneof(
  credentialToken,
  fc.tuple(fc.constantFrom("Bearer", "Basic", "DPoP"), credentialToken).map(([scheme, token]) => `${scheme} ${token}`),
)

/** Text that is definitely not JSON — established by running the parser, not by guessing. */
const nonJsonText = fc
  .oneof(
    fc.string({ maxLength: 40 }),
    fc.constantFrom("", "   ", "not json", "{", "[1,", "undefined", "<html>oops</html>", "NaN", "{'a':1}"),
  )
  .filter((text) => {
    try {
      JSON.parse(text)
      return false
    } catch {
      return true
    }
  })

/**
 * JSON-RPC error objects, spanning the reserved protocol range, the auth codes some servers borrow
 * from HTTP, application codes, and a missing code.
 */
const jsonRpcError = fc.record(
  {
    code: fc.oneof(
      fc.constantFrom(-32700, -32600, -32601, -32602, -32603, -32000, -32768, -32001),
      fc.constantFrom(401, 403),
      fc.integer({ min: 1, max: 20000 }),
      fc.constant(undefined),
    ),
    message: fc.oneof(fc.string({ maxLength: 40 }), fc.constant(undefined)),
    data: fc.oneof(jsonValue, fc.constant(undefined)),
  },
  { requiredKeys: [] },
)

// ---------------------------------------------------------------------------------------------
// A recording fetch — the only seam these tests need
// ---------------------------------------------------------------------------------------------

interface Capture {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function recordingFetch(reply: (capture: Capture, attempt: number) => Response) {
  const captures: Capture[] = []
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of new Headers(init?.headers ?? {})) headers[key] = value
    const capture: Capture = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    }
    captures.push(capture)
    return reply(capture, captures.length)
  }) as unknown as typeof fetch
  return { captures, fetchFn }
}

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** A minimal successful JSON-RPC reply, echoing whatever id the request carried. */
function okReply(capture: Capture, result: unknown = {}): Response {
  const id = (JSON.parse(capture.body) as { id?: unknown }).id
  return jsonReply({ jsonrpc: "2.0", id, result })
}

interface JsonRpcRequestBody {
  id?: unknown
  jsonrpc?: unknown
  method?: unknown
  params?: unknown
}

function parseOutgoing(capture: Capture): JsonRpcRequestBody {
  return JSON.parse(capture.body) as JsonRpcRequestBody
}

/** Run `body` and return the {@link McpProtocolError} it threw. Not throwing is itself the failure. */
async function captureMcpError(body: () => Promise<unknown>): Promise<McpProtocolError> {
  let resolved: unknown
  let thrown: unknown
  let didThrow = false
  try {
    resolved = await body()
  } catch (error) {
    didThrow = true
    thrown = error
  }
  if (!didThrow) {
    throw new Error(
      `expected a thrown McpProtocolError, but the call resolved with ${JSON.stringify(resolved) ?? "undefined"} ` +
        `— a failure must never degrade to an empty result (Requirement 20.5)`,
    )
  }
  expect(thrown).toBeInstanceOf(McpProtocolError)
  return thrown as McpProtocolError
}

function isDeclaredCategory(category: unknown): category is McpErrorCategory {
  return MCP_ERROR_CATEGORIES.includes(category as McpErrorCategory)
}

// ---------------------------------------------------------------------------------------------
// Property 28
// ---------------------------------------------------------------------------------------------

describe("Feature: native-api-mode, Property 28: MCP requests and text envelopes round-trip, and failures are classified", () => {
  /**
   * Clause 1 — the outgoing body parses back to a version-2.0 envelope carrying the same method and
   * the same params. `params` omitted rather than `null` when the caller passed nothing, because a
   * JSON-RPC server may distinguish the two.
   *
   * **Validates: Requirements 20.1, 20.2**
   */
  test("the outgoing body parses back to a 2.0 envelope with the same method and params", async () => {
    await fc.assert(
      fc.asyncProperty(methodName, fc.oneof(fc.constant(undefined), jsonValue), async (method, params) => {
        const { captures, fetchFn } = recordingFetch((capture) => okReply(capture))
        const client = new McpClient(SERVER_URL, {}, { fetch: fetchFn })

        await client.request(method, params)

        expect(captures).toHaveLength(1)
        const capture = captures[0]
        expect(capture.url).toBe(SERVER_URL)
        expect(capture.method).toBe("POST")
        expect(capture.headers["content-type"]).toBe("application/json")

        const body = parseOutgoing(capture)
        expect(body.jsonrpc).toBe("2.0")
        expect(body.method).toBe(method)
        expect(typeof body.id).toBe("string")
        expect((body.id as string).length).toBeGreaterThan(0)

        if (params === undefined) expect("params" in body).toBe(false)
        else expect(body.params).toEqual(params)
      }),
      { numRuns: 150 },
    )
  })

  /**
   * Clause 1, uniqueness — every call on the same client gets its own id, so a server correlating
   * replies by id never sees two live requests share one.
   *
   * **Validates: Requirement 20.1**
   */
  test("each call carries a fresh id", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(methodName, { minLength: 2, maxLength: 8 }), async (methods) => {
        const { captures, fetchFn } = recordingFetch((capture) => okReply(capture))
        const client = new McpClient(SERVER_URL, {}, { fetch: fetchFn })

        for (const method of methods) await client.request(method, {})

        const ids = captures.map((capture) => parseOutgoing(capture).id)
        expect(ids).toHaveLength(methods.length)
        expect(new Set(ids).size).toBe(methods.length)
      }),
      { numRuns: 100 },
    )
  })

  /**
   * Clause 1, envelope builder — the same claim stated against `buildJsonRpcRequest` directly, with
   * the id pinned, so the round trip is proven at the seam and not only through a live client.
   *
   * **Validates: Requirement 20.1**
   */
  test("buildJsonRpcRequest round-trips id, method, and params", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }),
        methodName,
        fc.oneof(fc.constant(undefined), jsonValue),
        (id, method, params) => {
          const body = JSON.parse(buildJsonRpcRequest(id, method, params)) as JsonRpcRequestBody
          expect(body).toEqual(params === undefined ? { id, jsonrpc: "2.0", method } : { id, jsonrpc: "2.0", method, params })
        },
      ),
      { numRuns: 150 },
    )
  })

  /**
   * Clause 2 — any JSON value wrapped in the text envelope parses back to that value. Asserted both
   * at the unwrapping function and end-to-end through `callTool`, because a caller only ever sees
   * the latter.
   *
   * **Validates: Requirement 20.3**
   */
  test("any JSON value wrapped in the text envelope parses back to that value", async () => {
    await fc.assert(
      fc.asyncProperty(jsonValue, fc.string({ minLength: 1, maxLength: 20 }), jsonValue, async (payload, toolName, args) => {
        const envelope = [{ type: "text", text: JSON.stringify(payload) }]
        expect(parseMcpTextEnvelope(envelope)).toEqual(payload)

        const { captures, fetchFn } = recordingFetch((capture) => okReply(capture, { content: envelope }))
        const client = new McpClient(SERVER_URL, {}, { fetch: fetchFn })

        const result = await client.callTool(toolName, args)
        expect(result.content).toEqual(payload)
        expect(result.isError).toBe(false)

        // And the call itself still satisfies clause 1, for the one method that matters most.
        const body = parseOutgoing(captures[0])
        expect(body.method).toBe("tools/call")
        expect(body.params).toEqual({ name: toolName, arguments: args ?? {} })
      }),
      { numRuns: 150 },
    )
  })

  /**
   * Clause 2, non-envelope content passes through — content that is not exactly one text part is
   * returned as received, so a server using the ordinary multi-part content shape is not mangled.
   *
   * **Validates: Requirement 20.3**
   */
  test("content that is not a single text part is returned unchanged", () => {
    const notAnEnvelope = fc.oneof(
      fc.array(jsonValue, { minLength: 2, maxLength: 4 }),
      fc.constant([]),
      fc.constant([{ type: "image", data: "AAAA" }]),
      fc.constant([{ type: "text" }]),
      fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), jsonValue, { maxKeys: 3 }),
      jsonScalar,
    )

    fc.assert(
      fc.property(notAnEnvelope, (content) => {
        // Guard: a generated array could coincidentally *be* a valid text envelope.
        const looksLikeEnvelope =
          Array.isArray(content) &&
          content.length === 1 &&
          typeof content[0] === "object" &&
          content[0] !== null &&
          (content[0] as { type?: unknown }).type === "text" &&
          typeof (content[0] as { text?: unknown }).text === "string"
        fc.pre(!looksLikeEnvelope)

        expect(parseMcpTextEnvelope(content)).toEqual(content)
      }),
      { numRuns: 150 },
    )
  })

  /**
   * Clause 3a — text that is not JSON throws `malformed_payload`, a member of the declared set, and
   * never resolves to an empty result.
   *
   * **Validates: Requirements 20.4, 20.5**
   */
  test("non-JSON envelope text throws a declared category instead of returning empty", async () => {
    await fc.assert(
      fc.asyncProperty(nonJsonText, fc.string({ minLength: 1, maxLength: 20 }), async (text, toolName) => {
        // The direct claim about the unwrapper.
        const direct = await captureMcpError(async () => parseMcpTextEnvelope([{ type: "text", text }]))
        expect(isDeclaredCategory(direct.category)).toBe(true)
        expect(direct.category).toBe("malformed_payload")

        // And the same claim through the client.
        const { fetchFn } = recordingFetch((capture) => okReply(capture, { content: [{ type: "text", text }] }))
        const client = new McpClient(SERVER_URL, {}, { fetch: fetchFn })
        const viaClient = await captureMcpError(() => client.callTool(toolName, {}))
        expect(isDeclaredCategory(viaClient.category)).toBe(true)
        expect(viaClient.category).toBe("malformed_payload")
      }),
      { numRuns: 150 },
    )
  })

  /**
   * Clause 3b — a JSON-RPC `error` object throws with a category from the declared set, and never
   * one of the categories that describe a *transport* or *payload* failure: the transport worked and
   * the payload parsed, so `transport`, `http`, and `malformed_payload` would all be wrong answers.
   * The error's `code` and `data` survive onto the thrown error for the caller to inspect.
   *
   * **Validates: Requirements 20.4, 20.5**
   */
  test("a JSON-RPC error object throws a declared category instead of returning empty", async () => {
    await fc.assert(
      fc.asyncProperty(methodName, jsonRpcError, async (method, error) => {
        const { fetchFn } = recordingFetch((capture) =>
          jsonReply({ jsonrpc: "2.0", id: parseOutgoing(capture).id, error }),
        )
        const client = new McpClient(SERVER_URL, {}, { fetch: fetchFn })

        const thrown = await captureMcpError(() => client.request(method, {}))
        expect(isDeclaredCategory(thrown.category)).toBe(true)
        expect(["protocol", "tool_error", "unauthorized"]).toContain(thrown.category)
        expect(thrown.message).toContain(method)
        if (error.code !== undefined) expect(thrown.code).toBe(error.code)
        if (error.data !== undefined) expect(thrown.data).toEqual(error.data)
      }),
      { numRuns: 150 },
    )
  })

  /**
   * Clause 3c — a reply carrying neither `result` nor `error` is a protocol failure, not an empty
   * success. This is the shape a degraded-to-empty bug would look like from the outside, so it is
   * asserted rather than assumed.
   *
   * **Validates: Requirements 20.4, 20.5**
   */
  test("a reply with neither result nor error throws a declared category", async () => {
    await fc.assert(
      fc.asyncProperty(
        methodName,
        fc.constantFrom<Record<string, unknown>>({}, { result: null }, { error: null }, { result: null, error: null }),
        async (method, reply) => {
          const { fetchFn } = recordingFetch((capture) =>
            jsonReply({ jsonrpc: "2.0", id: parseOutgoing(capture).id, ...reply }),
          )
          const client = new McpClient(SERVER_URL, {}, { fetch: fetchFn })

          const thrown = await captureMcpError(() => client.request(method, {}))
          expect(isDeclaredCategory(thrown.category)).toBe(true)
          expect(thrown.category).toBe("protocol")
        },
      ),
      { numRuns: 100 },
    )
  })

  /**
   * Clause 4 — the outgoing `authorization` header derives only from the authorization material the
   * caller supplied. Three sub-claims, all in one property because they are the same claim seen from
   * three sides:
   *
   *   - with no authorization anywhere, no `authorization` header is sent at all;
   *   - with only client-construction material, the header is that value;
   *   - with per-call material, the header is the *call's* value and the construction value appears
   *     nowhere in the request.
   *
   * The bare-token case is normalized to `Bearer <value>`; material that already carries a scheme is
   * sent verbatim. Both are still "derived only from the parameter" — nothing else contributes.
   *
   * **Validates: Requirement 20.2**
   */
  test("the outgoing authorization header derives only from the call parameter", async () => {
    await fc.assert(
      fc.asyncProperty(bearerMaterial, bearerMaterial, methodName, async (constructed, perCall, method) => {
        fc.pre(constructed !== perCall)
        const expected = (value: string) => (/^\S+\s+\S/.test(value) ? value : `Bearer ${value}`)

        // No material at all.
        const none = recordingFetch((capture) => okReply(capture))
        await new McpClient(SERVER_URL, {}, { fetch: none.fetchFn }).request(method, {})
        expect("authorization" in none.captures[0].headers).toBe(false)

        // Construction material only.
        const client = recordingFetch((capture) => okReply(capture))
        await new McpClient(SERVER_URL, { authorization: constructed }, { fetch: client.fetchFn }).request(method, {})
        expect(client.captures[0].headers.authorization).toBe(expected(constructed))

        // Per-call material wins, and the construction value is nowhere in the request.
        const call = recordingFetch((capture) => okReply(capture))
        await new McpClient(SERVER_URL, { authorization: constructed }, { fetch: call.fetchFn }).request(method, {}, {
          auth: { authorization: perCall },
        })
        const headers = call.captures[0].headers
        expect(headers.authorization).toBe(expected(perCall))
        expect(JSON.stringify(headers)).not.toContain(constructed)
        expect(call.captures[0].body).not.toContain(constructed)
      }),
      { numRuns: 150 },
    )
  })

  /**
   * Clause 4, extra headers — caller-supplied headers are forwarded, and `authorization` is applied
   * after them, so a stray `authorization` in the header bag cannot override the authorization
   * parameter.
   *
   * **Validates: Requirement 20.2**
   */
  test("authorization is not overridable by a caller-supplied header bag", async () => {
    await fc.assert(
      fc.asyncProperty(bearerMaterial, bearerMaterial, async (authorization, stray) => {
        fc.pre(authorization !== stray)
        const { captures, fetchFn } = recordingFetch((capture) => okReply(capture))
        const client = new McpClient(
          SERVER_URL,
          { authorization, headers: { authorization: stray, "x-trace": "t" } },
          { fetch: fetchFn },
        )

        await client.request("tools/list", {})

        const headers = captures[0].headers
        expect(headers["x-trace"]).toBe("t")
        expect(headers.authorization).toBe(/^\S+\s+\S/.test(authorization) ? authorization : `Bearer ${authorization}`)
      }),
      { numRuns: 100 },
    )
  })

  /** The protocol revision the handshake negotiates is fixed, not generated — recorded once. */
  test("initialize negotiates the declared protocol version", async () => {
    const { captures, fetchFn } = recordingFetch((capture) => okReply(capture, { protocolVersion: MCP_PROTOCOL_VERSION }))
    await new McpClient(SERVER_URL, {}, { fetch: fetchFn }).initialize()

    const body = parseOutgoing(captures[0])
    expect(body.method).toBe("initialize")
    expect((body.params as { protocolVersion?: unknown }).protocolVersion).toBe(MCP_PROTOCOL_VERSION)
  })
})
