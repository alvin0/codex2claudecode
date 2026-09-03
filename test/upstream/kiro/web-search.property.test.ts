// Property 23 for the web-search heuristics flag (task 27.2).
//
// The claim under test is a *containment* claim, which is why it is a property and not a list of
// examples: with `KIRO_WEB_SEARCH_HEURISTICS` off, the gateway may drop nothing and may invent
// nothing, so the set of tool-call names the client sees has to be a subset of the set the model
// actually emitted — for every prompt, not for the handful of prompts someone thought to write
// down. The old heuristics failed exactly this shape: they read a URL or an intent phrase out of
// the prompt and produced a `WebSearch`, `WebFetch`, or `list_allowed_directories` call that
// appears nowhere in the model's output, plus a `/mcp` search the model never requested.
//
// Prompts are drawn in several languages on purpose. The intent regex in
// `hasExplicitWebSearchIntent()` matches Vietnamese phrases alongside English ones, and the
// allowed-directories regex matches diacritic-stripped Vietnamese too, so a generator that only
// produced English would leave the paths most likely to fire untested. Japanese, Spanish, and
// Russian prompts are included as the negative side of the same coin: they must not start
// synthesizing once the flag comes back on either.
//
// What is deliberately *not* gated, and is asserted here as parity rather than absence: the
// model-emitted interception path through `maybeHandleKiroServerTool()`. A `web_search` the model
// emitted is a real request; suppressing it would be a silent drop. The third test runs one such
// request under both flag states and requires the two event streams to agree.
//
// The fake client counts every upstream call it receives — `generateAssistantResponse` and
// `callMcpWebSearch` together — because "one upstream request" is a claim about the provider's
// traffic, and a preflight search is upstream traffic even though it is not a generate call.
//
// **Validates: Requirements 17.3, 17.4, 17.6, 17.7**
import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_Event, Canonical_Request } from "../../../src/core/canonical"
import { Kiro_Auth_Manager, Kiro_Client, Kiro_Upstream_Provider } from "../../../src/upstream/kiro"
import type { JsonObject } from "../../../src/core/types"
import { path, readFile } from "../../helpers"

/** The three names the heuristics used to fabricate. None may appear unless the model emitted it. */
const SYNTHESIZED_TOOL_NAMES = ["WebSearch", "WebFetch", "mcp__filesystem__list_allowed_directories"] as const

/**
 * Client tools the request always declares, so a synthesizer that fired would have a target to
 * fire at. Without them the property would pass for the uninteresting reason that there was
 * nothing to synthesize.
 */
const CLIENT_WEB_TOOLS: JsonObject[] = [
  { type: "function", name: "WebSearch" },
  { type: "function", name: "WebFetch" },
  { type: "function", name: "mcp__filesystem__list_allowed_directories" },
]

/**
 * Prompts that used to trip a heuristic: URLs, web-search intent in four languages, and
 * allowed-directories phrasing with and without Vietnamese diacritics.
 */
const HEURISTIC_PROMPTS = [
  "su dung websearch https://example.com/article",
  "websearch https://example.com/a?b=c",
  "Please web search for the latest TypeScript release notes",
  "tìm kiếm web về giá vàng hôm nay",
  "tra cứu web https://vnexpress.net/tin-moi",
  "sử dụng web để kiểm tra https://example.com",
  "ウェブ検索して https://example.jp/news をまとめて",
  "búsqueda web sobre https://example.es/noticia",
  "поиск в интернете https://example.ru/statya",
  "Những thư mục nào tôi được phép truy cập?",
  "Nhung thu muc nao toi duoc phep truy cap?",
  "list_allowed_directories please",
  "What are the allowed directories for this session?",
  "Summarize this page: https://example.com/very/long/path",
  "Refactor this function for me",
  "hello",
] as const

/** Intent phrases combined with a generated URL, so the URL branch is not limited to fixed hosts. */
const INTENT_PHRASES = ["websearch", "web search", "tìm kiếm web", "tra cứu web", "sử dụng web", "ウェブ検索", "búsqueda web"] as const

const promptArbitrary = fc.oneof(
  fc.constantFrom(...HEURISTIC_PROMPTS),
  fc.tuple(fc.constantFrom(...INTENT_PHRASES), fc.webUrl()).map(([phrase, url]) => `${phrase} ${url}`),
  fc.webUrl().map((url) => `Tell me what is at ${url}`),
)

/**
 * Names the model may emit. `web_search` is excluded here on purpose: it routes into the
 * interception path, which issues a second upstream call by design, so it would contradict the
 * one-request half of this property. It gets its own test below.
 */
const MODEL_TOOL_NAMES = ["save", "load", "WebSearch", "WebFetch", "mcp__filesystem__list_allowed_directories"] as const

function auth() {
  return new Kiro_Auth_Manager({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: new Date(Date.now() + 700_000).toISOString(),
    region: "us-east-1",
  }, "/tmp/unused")
}

/** One Kiro response body: optional text, then one frame per model-emitted tool call. */
function kiroBody(text: string, toolCalls: readonly { name: string; input?: string }[]) {
  return [
    JSON.stringify({ content: text }),
    ...toolCalls.map((call, index) => JSON.stringify({ name: call.name, toolUseId: `call_${index}`, input: call.input ?? "" })),
  ].join("")
}

interface CallLog {
  generate: number
  mcp: number
  total: () => number
}

/**
 * A provider over a client that records its upstream traffic. `webSearchHeuristics` is passed as a
 * parameter, never through `process.env`: the environment has exactly one reader,
 * `readNativeFlags()`, and these tests do not mutate the process to pick a flag state.
 */
function providerFor(body: string, options: { webSearchHeuristics: boolean }) {
  const log: CallLog = { generate: 0, mcp: 0, total: () => log.generate + log.mcp }
  const client = {
    generateAssistantResponse: () => {
      log.generate += 1
      return Promise.resolve(new Response(body))
    },
    callMcpWebSearch: (query: string, callOptions?: { toolUseId?: string }) => {
      log.mcp += 1
      return Promise.resolve({
        toolUseId: callOptions?.toolUseId ?? "srvtoolu_search",
        results: { results: [{ title: "Article", url: "https://example.com/article", snippet: "Snippet" }] },
        summary: `<web_search>\nSearch results for "${query}"\n</web_search>\n`,
      })
    },
    listAvailableModels: () => Promise.resolve([]),
    checkHealth: () => Promise.resolve({ ok: true }),
  }

  return {
    log,
    provider: new Kiro_Upstream_Provider({ auth: auth(), client: client as unknown as Kiro_Client, webSearchHeuristics: options.webSearchHeuristics }),
  }
}

function request(overrides: Partial<Canonical_Request> = {}): Canonical_Request {
  return {
    model: "claude-sonnet-4-5",
    instructions: "Be helpful",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [],
    stream: false,
    passthrough: false,
    metadata: {},
    ...overrides,
  }
}

/**
 * Every tool name the client would see, from either result shape. A `server_tool` block counts as
 * `web_search`: a fabricated search reaches the client as blocks rather than as a tool call, so
 * reading only `tool_call` names would let the preflight through the property unnoticed.
 */
async function returnedToolNames(result: Awaited<ReturnType<Kiro_Upstream_Provider["proxy"]>>) {
  const names: string[] = []

  if (result.type === "canonical_response") {
    for (const block of result.content) {
      if (block.type === "tool_call" && typeof block.name === "string") names.push(block.name)
      if (block.type === "server_tool") names.push("web_search")
    }
    return names
  }

  if (result.type !== "canonical_stream") return names

  const events: Canonical_Event[] = []
  for await (const event of result.events) events.push(event)
  for (const event of events) {
    if (event.type === "tool_call_done") names.push(event.name)
    if (event.type === "server_tool_block") names.push("web_search")
  }
  return names
}

describe("Kiro web-search heuristics flag", () => {
  test("Feature: native-api-mode, Property 23: With heuristics disabled, returned tool calls are a subset of what the model emitted", async () => {
    await fc.assert(fc.asyncProperty(
      promptArbitrary,
      fc.uniqueArray(fc.constantFrom(...MODEL_TOOL_NAMES), { maxLength: 3 }),
      fc.boolean(),
      fc.boolean(),
      async (prompt, modelToolNames, stream, declareClientWebSearchMetadata) => {
        const body = kiroBody("answer", modelToolNames.map((name) => ({ name })))
        const { log, provider } = providerFor(body, { webSearchHeuristics: false })

        const result = await provider.proxy(request({
          stream,
          input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
          tools: CLIENT_WEB_TOOLS,
          metadata: declareClientWebSearchMetadata ? { claudeClientWebSearchToolName: "WebSearch" } : {},
        }))

        const returned = new Set(await returnedToolNames(result))
        const emitted = new Set<string>(modelToolNames)

        // Subset: nothing reaches the client that the model did not produce.
        for (const name of returned) expect(emitted.has(name)).toBe(true)
        // None of the three fabricated names, unless the model emitted it.
        for (const name of SYNTHESIZED_TOOL_NAMES) {
          if (!emitted.has(name)) expect(returned.has(name)).toBe(false)
        }
        // Exactly one upstream request: the generate call, and no preflight search.
        expect(log.total()).toBe(1)
        expect(log.mcp).toBe(0)
      },
    ), { numRuns: 200 })
  })

  test("a prompt containing a URL with heuristics disabled synthesizes zero WebSearch, WebFetch, or list_allowed_directories tool calls", async () => {
    const { log, provider } = providerFor(kiroBody("answer", []), { webSearchHeuristics: false })

    const result = await provider.proxy(request({
      input: [{ role: "user", content: [{ type: "input_text", text: "su dung websearch https://example.com/article" }] }],
      tools: CLIENT_WEB_TOOLS,
      metadata: { claudeClientWebSearchToolName: "WebSearch" },
    }))

    expect(result.type).toBe("canonical_response")
    expect(await returnedToolNames(result)).toEqual([])
    expect(log.generate).toBe(1)
    expect(log.mcp).toBe(0)
  })

  test("Feature: native-api-mode, Property 23: the model-emitted interception path behaves identically in both flag states", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("current release notes", "the changelog for this library", "what changed in v2"),
      fc.boolean(),
      async (topic, stream) => {
        // No URL and no intent phrase in the prompt, so heuristics-on has nothing to guess at and
        // the only web search in play is the one the model emitted. That isolation is what makes
        // this a statement about the interception path rather than about the heuristics.
        const body = kiroBody("answer", [{ name: "web_search", input: JSON.stringify({ query: topic }) }])
        const shapes: { names: string[]; generate: number; mcp: number; type: string }[] = []

        for (const webSearchHeuristics of [false, true]) {
          const { log, provider } = providerFor(body, { webSearchHeuristics })
          const result = await provider.proxy(request({
            stream,
            input: [{ role: "user", content: [{ type: "input_text", text: `Summarize ${topic}` }] }],
            tools: [{ type: "web_search" }],
          }))

          shapes.push({ names: await returnedToolNames(result), generate: log.generate, mcp: log.mcp, type: result.type })
        }

        expect(shapes[0]).toEqual(shapes[1]!)
        // The interception ran in both states: the model's `web_search` was executed, not dropped.
        expect(shapes[0]!.names).toContain("web_search")
        expect(shapes[0]!.mcp).toBe(1)
      },
    ), { numRuns: 100 })
  })
})

describe("KIRO_WEB_SEARCH_HEURISTICS has exactly one reader", () => {
  // The sibling of the `NATIVE_PASSTHROUGH` assertion in
  // `test/app/native-passthrough-wiring.test.ts`, and the reason the `webSearchHeuristics`
  // constructor parameter means anything: a provider could accept the parameter and then read the
  // environment anyway, in which case the flag would have two readers and one of them would win by
  // accident (design decision D3).
  //
  // `KIRO_WEB_SEARCH_ENABLED` — the older, unrelated toggle that decides whether the `web_search`
  // declaration is auto-injected — is a different variable and is deliberately not covered here.
  test("only src/app/native-flags.ts names the variable", async () => {
    const readers: string[] = []
    for await (const file of new Bun.Glob("src/**/*.{ts,tsx}").scan({ cwd: process.cwd(), onlyFiles: true })) {
      const normalized = file.replace(/\\/g, "/")
      const source = await readFile(path.join(process.cwd(), normalized), "utf8")
      // Comments legitimately name the flag when documenting where it is read and what it gates;
      // only executable text counts as a reader.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      if (code.includes("KIRO_WEB_SEARCH_HEURISTICS")) readers.push(normalized)
    }

    expect(readers).toEqual(["src/app/native-flags.ts"])
  })
})
