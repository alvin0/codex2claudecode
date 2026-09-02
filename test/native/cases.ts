// Role: the single registry of the 14 live cases (Requirement 24.1). Nothing else declares
// a case; the live test, the transcript writer, and the matrix walk all read this table.
//
// Every assertion is structural. Where a requirement leaves the declared policy of a cell
// open (Kiro sampling reads as `reject` in Requirement 2.3 and as degrade-plus-notice in
// Requirement 11.5), the case asserts the fact both readings share: the outcome is declared
// and observable, never a silent 200. That is the defect this feature exists to fix.
import type { JsonObject } from "../../src/core/types"

import {
  expectBlockType,
  expectBytesIdenticalToDirectCall,
  expectDeclaredOutcome,
  expectErrorMentions,
  expectEventType,
  expectNoSynthesizedClientToolCalls,
  expectNoNotice,
  expectNoticeMentions,
  expectServerToolCount,
  expectServerToolResultsArePaired,
  expectStatus,
  expectUpstreamEffortIn,
  expectUpstreamEffortPresent,
  expectUpstreamPayloadOmits,
} from "./assertions"
import type { NativeLiveCase } from "./types"

/** The 14 case ids, in plan order. A rename fails the harness property test loudly. */
export const NATIVE_LIVE_CASE_IDS = [
  "sampling-declared",
  "sampling-native",
  "effort-default",
  "effort-degrade",
  "thinking-budget",
  "passthrough-bytes",
  "passthrough-off",
  "messages-no-passthrough",
  "web-search-native",
  "web-search-no-heuristic",
  "web-fetch-emulate",
  "mcp-toolset-kiro",
  "mcp-approval-reject",
  "no-silent-drop",
] as const

export type NativeLiveCaseId = (typeof NATIVE_LIVE_CASE_IDS)[number]

/**
 * Substituted with the loopback MCP fixture's URL at run time. Kept as a visible token so a
 * transcript shows what the registry declared and what the run actually sent.
 */
export const NATIVE_MCP_SERVER_URL_PLACEHOLDER = "{{MCP_SERVER_URL}}"

export const NATIVE_MCP_SERVER_NAME = "native-fixture"

/** Models are overridable because provider catalogs move; both default to a cheap model. */
export const NATIVE_KIRO_MODEL = process.env.NATIVE_KIRO_MODEL ?? "claude-sonnet-4.5"
export const NATIVE_CODEX_MODEL = process.env.NATIVE_CODEX_MODEL ?? "gpt-5.4-mini_low"

/** Effort levels Kiro's model metadata reports as supported (kiro-models.json). */
export const KIRO_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const

const OK_PROMPT = "Reply with exactly: ok"

function messages(body: JsonObject = {}, prompt = OK_PROMPT): JsonObject {
  return {
    model: NATIVE_KIRO_MODEL,
    max_tokens: 256,
    stream: false,
    messages: [{ role: "user", content: prompt }],
    ...body,
  }
}

/**
 * Codex `/v1/responses` refuses a non-streaming request outright — measured in Run_Record 1 as
 * `400 {"detail":"Stream must be set to true"}` — so the default here is `stream: true`. A case
 * that genuinely needs the non-streaming path must set it explicitly and expect that 400.
 */
function responses(body: JsonObject = {}, prompt = OK_PROMPT): JsonObject {
  return {
    model: NATIVE_CODEX_MODEL,
    stream: true,
    input: prompt,
    ...body,
  }
}

function clientWebTools(): JsonObject[] {
  return [
    {
      name: "WebSearch",
      description: "Search the web for a query.",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    {
      name: "WebFetch",
      description: "Fetch a URL and summarize it.",
      input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  ]
}

function mcpToolsetBody(requireApproval: "always" | "never"): JsonObject {
  return messages(
    {
      mcp_servers: [{ name: NATIVE_MCP_SERVER_NAME, type: "url", url: NATIVE_MCP_SERVER_URL_PLACEHOLDER }],
      tools: [
        {
          type: "mcp_toolset",
          mcp_server_name: NATIVE_MCP_SERVER_NAME,
          require_approval: requireApproval,
        },
      ],
    },
    "Call the fixture echo tool with the text ping, then reply with its result.",
  )
}

export const NATIVE_LIVE_CASES: readonly NativeLiveCase[] = [
  {
    id: "sampling-declared",
    title: "Kiro sampling resolves to its declared policy instead of being dropped",
    upstream: "kiro",
    route: "/v1/messages",
    body: messages({ temperature: 0.2, top_p: 0.9 }),
    flags: {},
    baseline: "red",
    assertions: [
      expectDeclaredOutcome("sampling", ["temperature", "top_p"]),
      // Measured: Kiro ignores inferenceConfig, so the payload must not carry it (Requirement 3.5).
      expectUpstreamPayloadOmits("inferenceConfig", "maxTokens"),
    ],
  },
  {
    id: "sampling-native",
    title: "Codex sampling is native and produces no notice",
    upstream: "codex",
    route: "/v1/responses",
    // `stream: true` because the upstream requires it (see `responses()`); the case's claim is
    // about sampling fidelity, not about the non-streaming path.
    body: responses({ stream: true, temperature: 0.2, top_p: 0.9 }),
    flags: {},
    baseline: "green",
    // The completion event makes the notice-free check meaningful: an empty or aborted stream
    // would otherwise satisfy `no-notice-sampling` trivially.
    assertions: [expectStatus(200), expectEventType("response.completed"), expectNoNotice("sampling")],
  },
  {
    id: "effort-default",
    title: "Kiro sends the model's default effort level when the client states none",
    upstream: "kiro",
    route: "/v1/messages",
    body: messages(),
    flags: {},
    baseline: "red",
    assertions: [expectStatus(200), expectUpstreamEffortPresent(), expectUpstreamEffortIn(KIRO_EFFORT_LEVELS)],
  },
  {
    id: "effort-degrade",
    title: "An out-of-enum effort value degrades to the nearest level with a notice",
    upstream: "kiro",
    route: "/v1/messages",
    // `max` is reported unsupported for every Kiro model in kiro-models.json.
    body: messages({ output_config: { effort: "max" } }),
    flags: {},
    baseline: "red",
    assertions: [expectStatus(200), expectUpstreamEffortIn(KIRO_EFFORT_LEVELS), expectNoticeMentions("max")],
  },
  {
    id: "thinking-budget",
    title: "A thinking budget maps to an effort level and says so",
    upstream: "kiro",
    route: "/v1/messages",
    body: messages({ thinking: { type: "enabled", budget_tokens: 12_000 } }),
    flags: {},
    baseline: "red",
    assertions: [expectStatus(200), expectUpstreamEffortIn(KIRO_EFFORT_LEVELS), expectNoticeMentions("12000")],
  },
  {
    id: "passthrough-bytes",
    title: "Streaming /v1/responses to Codex returns bytes identical to a direct call",
    upstream: "codex",
    route: "/v1/responses",
    body: responses({ stream: true }),
    flags: { NATIVE_PASSTHROUGH: "1" },
    baseline: "red",
    requiresDirectUpstreamCall: true,
    assertions: [expectStatus(200), expectBytesIdenticalToDirectCall()],
  },
  {
    id: "passthrough-off",
    title: "With the flag unset the same request takes the canonical path",
    upstream: "codex",
    route: "/v1/responses",
    body: responses({ stream: true }),
    flags: {},
    baseline: "green",
    assertions: [expectStatus(200), expectEventType("response.completed")],
  },
  {
    id: "messages-no-passthrough",
    title: "/v1/messages never takes the passthrough path even with the flag on",
    upstream: "codex",
    route: "/v1/messages",
    body: messages({ model: NATIVE_CODEX_MODEL, stream: true }),
    flags: { NATIVE_PASSTHROUGH: "1" },
    baseline: "green",
    assertions: [expectStatus(200), expectEventType("message_start"), expectEventType("message_stop")],
  },
  {
    id: "web-search-native",
    title: "Model-emitted web search flows through untouched",
    upstream: "kiro",
    route: "/v1/messages",
    // No client web tool and no search phrase, so a synthesized call is structurally impossible.
    body: messages({}, "Find the current stable Bun release version and reply with just the version number."),
    flags: {},
    baseline: "green",
    assertions: [expectStatus(200), expectNoSynthesizedClientToolCalls(), expectServerToolResultsArePaired()],
  },
  {
    id: "web-search-no-heuristic",
    title: "Intent heuristics stay inactive: no tool call the model did not emit",
    upstream: "kiro",
    route: "/v1/messages",
    // The prompt names web search on purpose — that phrase is what trips the preflight today.
    body: messages({ tools: clientWebTools() }, "Do not use web search. Reply with exactly: ok"),
    flags: {},
    baseline: "red",
    assertions: [expectStatus(200), expectNoSynthesizedClientToolCalls()],
  },
  {
    id: "web-fetch-emulate",
    title: "Kiro emulates web_fetch instead of rejecting it",
    upstream: "kiro",
    route: "/v1/messages",
    body: messages(
      { tools: [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 1 }] },
      "Fetch https://bun.sh/docs and reply with the page title only.",
    ),
    flags: {},
    baseline: "red",
    assertions: [expectStatus(200), expectBlockType("web_fetch_tool_result"), expectServerToolCount("web_fetch_requests", 1)],
  },
  {
    id: "mcp-toolset-kiro",
    title: "Kiro executes an MCP toolset against the loopback fixture",
    upstream: "kiro",
    route: "/v1/messages",
    body: mcpToolsetBody("never"),
    flags: { NATIVE_MCP_EMULATION: "1" },
    baseline: "red",
    requiresMcpFixture: true,
    assertions: [expectStatus(200), expectBlockType("mcp_tool_result"), expectServerToolCount("mcp_calls", 1)],
  },
  {
    id: "mcp-approval-reject",
    title: "require_approval: always is rejected and names the alternative",
    upstream: "kiro",
    route: "/v1/messages",
    body: mcpToolsetBody("always"),
    flags: { NATIVE_MCP_EMULATION: "1" },
    baseline: "red",
    requiresMcpFixture: true,
    assertions: [expectStatus(400), expectErrorMentions("require_approval", "never")],
  },
  {
    id: "no-silent-drop",
    title: "Every field covered by the matrix ends in a declared outcome",
    upstream: "kiro",
    route: "/v1/messages",
    body: messages({
      temperature: 0.3,
      top_p: 0.8,
      stop_sequences: ["STOP"],
      thinking: { type: "enabled", budget_tokens: 4000 },
      tool_choice: { type: "any" },
      tools: [{ name: "noop", description: "Does nothing.", input_schema: { type: "object", properties: {} } }],
    }),
    flags: {},
    baseline: "red",
    assertions: [
      expectDeclaredOutcome("sampling", ["temperature", "top_p"]),
      expectDeclaredOutcome("stopSequences", ["stop_sequences", "stop sequences"]),
      expectDeclaredOutcome("toolChoiceForced", ["tool_choice", "tool choice"]),
      expectDeclaredOutcome("thinkingBudget", ["budget_tokens", "thinking budget"]),
    ],
  },
]

export function nativeLiveCase(id: NativeLiveCaseId): NativeLiveCase {
  const found = NATIVE_LIVE_CASES.find((liveCase) => liveCase.id === id)
  if (!found) throw new Error(`Unknown native live case: ${id}`)
  return found
}

export function nativeLiveCasesFor(upstream: NativeLiveCase["upstream"]) {
  return NATIVE_LIVE_CASES.filter((liveCase) => liveCase.upstream === upstream)
}

/** Case ids whose recorded pre-implementation state is `state` (Requirements 24.5, 24.6). */
export function nativeBaselineCaseIds(state: NativeLiveCase["baseline"]) {
  return NATIVE_LIVE_CASES.filter((liveCase) => liveCase.baseline === state).map((liveCase) => liveCase.id)
}

/**
 * Fills the MCP fixture URL into a case body. Returns a deep copy, so a run can never
 * mutate the registry and leak state into the next case.
 */
export function resolveNativeCaseBody(liveCase: NativeLiveCase, context: { mcpServerUrl?: string } = {}): JsonObject {
  const serialized = JSON.stringify(liveCase.body)
  if (!serialized.includes(NATIVE_MCP_SERVER_URL_PLACEHOLDER)) return JSON.parse(serialized) as JsonObject
  if (!context.mcpServerUrl) throw new Error(`Case ${liveCase.id} needs an MCP fixture URL`)
  return JSON.parse(serialized.split(NATIVE_MCP_SERVER_URL_PLACEHOLDER).join(context.mcpServerUrl)) as JsonObject
}
