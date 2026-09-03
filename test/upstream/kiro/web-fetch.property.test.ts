// Properties 25 and 26 for the Kiro `web_fetch` emulation module (tasks 28.3 and 28.4).
//
// The module under test is `src/upstream/kiro/web-fetch.ts`, written on the `emulate` branch of
// task 28.1: `.omc/research/kiro-wire-spike.md` §9.2–§9.4 measured that Kiro's `/mcp` `tools/list`
// carries only `web_search` and that `tools/call` for `web_fetch`, `webFetch`, and `fetch` each
// returned `-32602 "Tool not found"`, so there is no server-side fetch tool to call and no `native`
// branch to test. Every fetch here goes through an injected `fetchImpl`, so the suite issues zero
// real network requests.
//
// **Validates: Requirements 18.1, 18.3, 18.4, 18.5, 22.3**

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { JsonObject } from "../../../src/core/types"
import { collectKiroResponse } from "../../../src/upstream/kiro/parse"
import * as webFetchModule from "../../../src/upstream/kiro/web-fetch"
import {
  executeKiroWebFetch,
  isFetchableUrl,
  maybeHandleKiroWebFetch,
  webFetchBlocks,
  webFetchServerToolUse,
} from "../../../src/upstream/kiro/web-fetch"

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

/**
 * URLs assembled from parts, so validity is a property of the construction rather than of a filter
 * over random text. Every value here satisfies the predicate by design.
 */
const arbValidUrl = fc
  .record({
    scheme: fc.constantFrom("http", "https"),
    host: fc.constantFrom("bun.sh", "example.com", "docs.example.org", "localhost", "127.0.0.1"),
    path: fc.constantFrom("", "/", "/docs", "/a/b/c", "/page.html"),
    query: fc.constantFrom("", "?q=1", "?a=1&b=2"),
  })
  .map(({ scheme, host, path, query }) => `${scheme}://${host}${path}${query}`)

/**
 * Inputs that are not URLs.
 *
 * Two halves, both non-circular — neither consults the predicate under test. The hand-written half
 * is the set of shapes that matter: wrong scheme, opaque scheme, host-less authority, relative
 * path, whitespace. The generated half is arbitrary text with any `http`/`https` scheme prefix
 * excluded, which is what makes `new URL()` reject it: without a scheme there is no absolute URL to
 * parse, and with a non-http scheme the protocol check rejects it anyway.
 */
const arbInvalidInput = fc.oneof(
  fc.constantFrom(
    "",
    "   ",
    "not a url",
    "bun.sh/docs",
    "/docs/index.html",
    "//example.com/docs",
    "ftp://example.com/file",
    "javascript:alert(1)",
    "data:text/plain,hello",
    "file:///etc/passwd",
    "mailto:someone@example.com",
    "http://",
    "https://",
    "{\"url\": 42}",
  ),
  fc
    .string({ minLength: 1, maxLength: 60 })
    .filter((value) => value.trim().length > 0 && !/^\s*https?:/i.test(value)),
)

/** Bodies the fake upstream returns: plain text and HTML, both with recoverable text. */
const arbBody = fc.oneof(
  fc.string({ minLength: 1, maxLength: 80 }).filter((text) => text.trim().length > 0).map((text) => ({ body: text, expectTitle: undefined as string | undefined })),
  fc
    .record({ title: fc.constantFrom("Bun Docs", "Example Page", "Guide"), text: fc.constantFrom("first paragraph", "hello world", "content body") })
    .map(({ title, text }) => ({ body: `<html><head><title>${title}</title></head><body><p>${text}</p></body></html>`, expectTitle: title })),
)

/** A document, for exercising the block builder without a fetch. */
const arbDocument = fc.record({
  url: arbValidUrl,
  data: fc.string({ maxLength: 120 }),
  title: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
  retrievedAt: fc.constantFrom("2025-01-01T00:00:00.000Z", "2025-06-30T12:34:56.789Z"),
})

/** One planned `web_fetch` call: either a good URL, a bad input, or a URL whose fetch fails. */
const arbPlannedCall = fc.oneof(
  arbValidUrl.map((url) => ({ kind: "ok" as const, input: url })),
  arbInvalidInput.map((input) => ({ kind: "invalid" as const, input })),
  arbValidUrl.map((url) => ({ kind: "http_error" as const, input: url })),
)

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** A `fetchImpl` that never touches the network and records how many times it was called. */
function recordingFetch(respond: (url: string) => Response) {
  const urls: string[] = []
  const impl = (async (input: string | URL | Request) => {
    urls.push(String(input))
    return respond(String(input))
  }) as unknown as typeof fetch
  return { impl, urls }
}

function blockTypes(blocks: JsonObject[]) {
  return blocks.map((block) => block.type)
}

async function drain(events: AsyncIterable<{ type: string } & Record<string, unknown>>) {
  const collected: ({ type: string } & Record<string, unknown>)[] = []
  for await (const event of events) collected.push(event)
  return collected
}

/**
 * Feed already-built server-tool blocks through the real Kiro collector.
 *
 * `new Response(null)` has a null body, which is the collector's "no stream" path: it reports usage
 * derived from `initialServerToolBlocks` and stops. That is the reachable seam for observing all
 * three counters at once without a live call.
 */
function collectWithServerToolBlocks(blocks: JsonObject[]) {
  return collectKiroResponse(new Response(null), "claude-sonnet-4-5", [], 11, undefined, blocks)
}

const SERVER_TOOL_COUNTER_KEYS = ["webSearchRequests", "webFetchRequests", "mcpCalls"] as const

// ---------------------------------------------------------------------------------------------
// Property 25
// ---------------------------------------------------------------------------------------------

describe("Property 25: Web fetch emits its own result shape and validates its input", () => {
  test("Feature: native-api-mode, Property 25: every fetch result carries exactly one web_fetch_tool_result and zero web_search_tool_result", async () => {
    await fc.assert(
      fc.asyncProperty(arbValidUrl, arbBody, async (url, { body, expectTitle }) => {
        const { impl, urls } = recordingFetch(() => new Response(body, { status: 200 }))
        const result = await executeKiroWebFetch(url, { fetchImpl: impl, timeoutMs: 0, toolUseId: "srvtoolu_fixed", now: () => new Date(0) })

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(urls).toEqual([url])

        const blocks = webFetchBlocks(result.execution.toolUseId, result.execution.document)
        // Requirement 18.4 — its own result shape, not the web-search one.
        expect(blocks.filter((block) => block.type === "web_fetch_tool_result")).toHaveLength(1)
        expect(blocks.filter((block) => block.type === "web_search_tool_result")).toHaveLength(0)
        expect(blockTypes(blocks)).toEqual(["server_tool_use", "web_fetch_tool_result"])

        const [use, fetched] = blocks as [JsonObject, JsonObject]
        expect(use).toEqual({ type: "server_tool_use", id: "srvtoolu_fixed", name: "web_fetch", input: { url } })
        const content = fetched.content as JsonObject
        expect(content.type).toBe("web_fetch_result")
        expect(content.url).toBe(url)
        const document = content.content as JsonObject
        if (expectTitle) expect(document.title).toBe(expectTitle)
      }),
      { numRuns: 200 },
    )
  })

  test("Feature: native-api-mode, Property 25: the block builder never emits a web_search_tool_result for any document", () => {
    fc.assert(
      fc.property(arbDocument, (document) => {
        const blocks = webFetchBlocks("srvtoolu_fixed", document)
        expect(blocks.filter((block) => block.type === "web_fetch_tool_result")).toHaveLength(1)
        expect(blocks.filter((block) => block.type === "web_search_tool_result")).toHaveLength(0)
      }),
      { numRuns: 200 },
    )
  })

  test("Feature: native-api-mode, Property 25: an input failing the URL predicate is an error naming that input, with zero upstream requests", async () => {
    await fc.assert(
      fc.asyncProperty(arbInvalidInput, async (input) => {
        expect(isFetchableUrl(input)).toBe(false)

        const { impl, urls } = recordingFetch(() => new Response("unreachable", { status: 200 }))
        const result = await executeKiroWebFetch(input, { fetchImpl: impl, timeoutMs: 0 })

        expect(result.ok).toBe(false)
        if (result.ok) return
        // Requirement 18.5 — names the invalid input, verbatim and untruncated.
        expect(result.message).toContain(JSON.stringify(input))
        // Requirement 18.5 — zero upstream requests. Not "no result": no call at all.
        expect(urls).toEqual([])
      }),
      { numRuns: 200 },
    )
  })

  test("Feature: native-api-mode, Property 25: the interceptor turns an invalid input into an error event and calls no handler", async () => {
    await fc.assert(
      fc.asyncProperty(arbInvalidInput, async (input) => {
        let handlerCalls = 0
        const events = await drain(
          maybeHandleKiroWebFetch(
            { callId: "call_1", name: "web_fetch", arguments: JSON.stringify({ url: input }) },
            {
              webFetch: async () => {
                handlerCalls += 1
                return undefined
              },
            },
          ),
        )

        expect(events).toHaveLength(1)
        expect(events[0]!.type).toBe("error")
        expect(String(events[0]!.message)).toContain(JSON.stringify(input.trim() || JSON.stringify({ url: input })))
        expect(handlerCalls).toBe(0)
      }),
      { numRuns: 200 },
    )
  })

  test("Feature: native-api-mode, Property 25: a call this module does not own passes through unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }).filter((name) => name !== "web_fetch"),
        arbValidUrl,
        async (name, url) => {
          const events = await drain(
            maybeHandleKiroWebFetch({ callId: "call_1", name, arguments: JSON.stringify({ url }) }, { webFetch: async () => undefined }),
          )
          expect(events).toEqual([{ type: "tool_call_done", callId: "call_1", name, arguments: JSON.stringify({ url }) }])
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Property 26
// ---------------------------------------------------------------------------------------------

describe("Property 26: Server-tool counters equal the number of completed calls", () => {
  test("Feature: native-api-mode, Property 26: webFetchRequests equals the number of completed fetches", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbPlannedCall, { minLength: 1, maxLength: 6 }), async (plan) => {
        const { impl, urls } = recordingFetch((url) => (url.includes("fail=1") ? new Response("boom", { status: 503 }) : new Response("body text", { status: 200 })))

        const emitted: JsonObject[] = []
        let completed = 0
        for (const [index, planned] of plan.entries()) {
          // `http_error` is expressed by routing the URL at the fake upstream, not by a second
          // handler: the point is that a request which was issued but failed is still not counted.
          const input = planned.kind === "http_error" ? withFailingQuery(planned.input) : planned.input
          const events = await drain(
            maybeHandleKiroWebFetch(
              { callId: `call_${index}`, name: "web_fetch", arguments: JSON.stringify({ url: input }) },
              { webFetch: (target) => executeKiroWebFetch(target, { fetchImpl: impl, timeoutMs: 0, toolUseId: `srvtoolu_${index}`, now: () => new Date(0) }) },
            ),
          )
          for (const event of events) {
            if (event.type !== "server_tool_block") continue
            completed += 1
            emitted.push(...(event.blocks as JsonObject[]))
          }
        }

        const expectedCompleted = plan.filter((planned) => planned.kind === "ok").length
        const expectedRequests = plan.filter((planned) => planned.kind !== "invalid").length

        expect(completed).toBe(expectedCompleted)
        // The existing field, and only it (Requirement 18.3, Requirement 22.3).
        if (expectedCompleted) expect(webFetchServerToolUse(emitted)).toEqual({ webFetchRequests: expectedCompleted })
        else expect(webFetchServerToolUse(emitted)).toBeUndefined()
        // Invalid inputs issue zero upstream requests; failed ones issue theirs and still count zero.
        expect(urls).toHaveLength(expectedRequests)
      }),
      { numRuns: 150 },
    )
  })

  test("Feature: native-api-mode, Property 26: each of the three counters equals the number of completed calls of its kind", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("web_search_tool_result", "web_fetch_tool_result", "mcp_tool_result"), { maxLength: 9 }),
        async (kinds) => {
          const blocks: JsonObject[] = kinds.map((type, index) => ({ type, tool_use_id: `srvtoolu_${index}`, content: [] }))
          const response = await collectWithServerToolBlocks(blocks)

          const searches = kinds.filter((kind) => kind === "web_search_tool_result").length
          const fetches = kinds.filter((kind) => kind === "web_fetch_tool_result").length
          const mcp = kinds.filter((kind) => kind === "mcp_tool_result").length

          if (!searches && !fetches && !mcp) {
            expect(response.usage.serverToolUse).toBeUndefined()
            return
          }

          expect(response.usage.serverToolUse).toEqual({
            ...(searches ? { webSearchRequests: searches } : {}),
            ...(fetches ? { webFetchRequests: fetches } : {}),
            ...(mcp ? { mcpCalls: mcp } : {}),
          })
          // No parallel counter: the reported keys are drawn from the three canonical ones.
          for (const key of Object.keys(response.usage.serverToolUse!)) {
            expect(SERVER_TOOL_COUNTER_KEYS).toContain(key as (typeof SERVER_TOOL_COUNTER_KEYS)[number])
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  test("Feature: native-api-mode, Property 26: the web-fetch module introduces no counter beyond the canonical three", () => {
    fc.assert(
      fc.property(fc.array(arbDocument, { minLength: 1, maxLength: 4 }), (documents) => {
        const blocks = documents.flatMap((document, index) => webFetchBlocks(`srvtoolu_${index}`, document))
        const usage = webFetchServerToolUse(blocks)
        expect(Object.keys(usage!)).toEqual(["webFetchRequests"])

        // A parallel counter would have to reach the wire through some other export of this module.
        // Nothing exported here reports a count except the two documented helpers.
        const countingExports = Object.keys(webFetchModule).filter((name) => /count|calls|requests|servertooluse/i.test(name))
        expect(countingExports.sort()).toEqual(["webFetchRequestsFromBlocks", "webFetchServerToolUse"])
      }),
      { numRuns: 100 },
    )
  })
})

/**
 * The `mcpCalls` half of Property 26, restated for what is and is not reachable today.
 *
 * Reachable now, and asserted above: the counting and reporting layer. `mcp_tool_result` blocks
 * presented to `collectKiroResponse` produce `usage.serverToolUse.mcpCalls` equal to their number,
 * with no other key. That is a real assertion over a real code path, not a placeholder.
 *
 * Deferred to task 35.6: the *execution* half — that an MCP tool call the Kiro upstream actually
 * intercepted and ran produces exactly one counted `mcp_tool_result`. Nothing in `src/upstream/kiro/`
 * executes an MCP tool yet (task 35 wires `mcp-toolset.ts`), and today an MCP toolset is still a 400
 * from `validateUnsupportedServerTools()`, so a "one execution, one count" clause written here would
 * have nothing to execute and would pass vacuously. It is intentionally absent rather than stubbed.
 */
const MCP_HALF_DEFERRED_TO = "35.6"
void MCP_HALF_DEFERRED_TO

/**
 * Turn a valid URL into one the fake upstream answers with 503, without changing its validity.
 *
 * The marker is a query key `arbValidUrl` never generates, so an `ok` plan entry can never
 * accidentally land on the failing route.
 */
function withFailingQuery(url: string) {
  return url.includes("?") ? `${url}&fail=1` : `${url}?fail=1`
}
