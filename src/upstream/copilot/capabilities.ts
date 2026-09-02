import type { FeatureEvidence, ProviderCapabilities, ProviderFeature } from "../../core/provider-capabilities"
import { DEFAULT_RETRY_POLICY, DEFAULT_TIMEOUT_POLICY } from "../../core/provider-capabilities"

/**
 * Declared feature policies for the GitHub Copilot upstream.
 *
 * ## The evidence standard for this file
 *
 * This upstream has **no connected account in this environment**. Requirement 26.9 makes it
 * declaration-only, verified by unit tests alone, and `NATIVE_MATRIX_UPSTREAMS`
 * (`test/native/verify-matrix.ts`) gives it no row in the matrix walk. So unlike Kiro —
 * where every cell cites a run in `.omc/research/kiro-wire-spike.md` — **not one cell here
 * rests on a live measurement**, and `COPILOT_CAPABILITY_EVIDENCE` below records exactly
 * that, for all 11 features, in a form a test can read.
 *
 * That is the whole point of Requirement 2.7 applying to this provider and no other: a
 * declaration nobody has been able to check must not be readable as one that has been.
 *
 * What each cell therefore rests on is the weaker but still real kind of evidence Codex's
 * matrix calls *code-verified*: the body this repository actually emits, read out of
 * `buildCopilotResponsesBody()` in `./parse.ts`, and the endpoint it is posted to, read out
 * of `Copilot_Client.proxy()` in `./client.ts`. A cell says what the Gateway does with a
 * client-supplied field; it does not claim what GitHub's endpoint does with it. Every cell
 * below names its code site and, where the answer is genuinely open, says what measurement
 * would settle it.
 *
 * ## The wire format, corrected
 *
 * Requirement 14.4 and the design's Copilot sections describe this upstream as speaking
 * **chat-completions**. The code does not. `Copilot_Client.proxy()` posts to `/responses` on
 * `api.githubcopilot.com` (or `api.<accountType>.githubcopilot.com`), and
 * `buildCopilotResponsesBody()` builds an OpenAI **Responses** body — `instructions`,
 * `input`, `tools`, `tool_choice`, `text: { format }`, `reasoning: { effort }`. There is no
 * `/chat/completions` path anywhere under `src/upstream/copilot/`.
 *
 * The correction matters for two cells. `stopSequences` is `degrade` rather than `native`,
 * because Responses has no `stop` field even though chat-completions does. And `hostedTools`
 * below lists all ten Responses type names rather than declaring the concept absent, because
 * a Responses-shaped body is exactly where those type names are meaningful.
 *
 * ## Two structural caveats that are not per-cell defects
 *
 * `buildCopilotResponsesBody()` hardcodes `stream: false`, and `Copilot_Upstream_Provider.proxy()`
 * synthesizes an event stream from the collected response via `streamCopilotResponse()`. So
 * `streaming: true` here describes a Gateway-side reconstruction, not upstream SSE. No
 * `ProviderFeature` covers transport, so this note is the only place it is recorded.
 *
 * `instructions` falls back to `"You are a helpful assistant."` when canonical carries none.
 * That is a substitution only in the absence of client intent, which is not what
 * `features.systemPrompt` measures — see that cell.
 */
export const COPILOT_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  // No code path returns `canonical_passthrough`: `Copilot_Upstream_Provider.proxy()`
  // (`./index.ts`) returns `canonical_response`, `canonical_stream`, or `canonical_error`
  // only. Requirement 15 also scopes byte passthrough to Codex alone.
  passthrough: false,
  // `responseBodyToCanonicalResponse()` (`./parse.ts`) runs the wire `usage` object through
  // `canonicalUsageFromWireUsage()` (`src/core/usage.ts`), so token counts and the cache
  // and reasoning sub-counts do reach canonical usage.
  usageSupport: true,
  environmentsSupport: false,
  // `Copilot_Client.usage()` (`./client.ts`) reads `GET /copilot_internal/user` on
  // `api.github.com` for quota and plan state.
  usageEndpointSupport: true,
  // No count-tokens path exists under `src/upstream/copilot/`.
  tokenCountingSupport: false,
  // `Copilot_Upstream_Provider.listModels()` (`./index.ts`) reads `GET /models` and filters
  // on `model_picker_enabled`, with a TTL cache on disk.
  modelListingSupport: true,
  retryPolicy: DEFAULT_RETRY_POLICY,
  timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
  logBodyDefault: true,
  features: {
    // `native`, and — as on Codex — not what today's code shows, for a reason that lives
    // outside this provider. `Canonical_Request` (`src/core/canonical.ts`) has no `sampling`
    // member at all, so `buildCopilotResponsesBody()` emits neither `temperature` nor
    // `top_p` nor `max_output_tokens`; sampling is dropped at the **inbound** boundary for
    // every upstream, and this upstream never sees the field to decide anything about it.
    //
    // `native` is what Requirement 14.4 asks for once canonical carries sampling (tasks 14
    // and 15, via `./sampling.ts`), and it is the correct target either way: Responses
    // accepts `temperature`, `top_p`, and `max_output_tokens` as first-class parameters.
    //
    // One warning for whoever writes `./sampling.ts`: Requirement 14.4 says
    // "chat-completions fields", but this client posts to `/responses`. Emitting the
    // chat-completions spelling — `max_tokens` rather than `max_output_tokens` — would be an
    // unknown parameter on a Responses endpoint, which is a latent 400, not a harmless
    // no-op. Map to the Responses names.
    //
    // Unmeasured, and it stays unmeasured until an account exists: nothing here has been
    // sent to GitHub's endpoint.
    sampling: "native",
    // A `sampling` sub-member with no target in this wire format. The Responses API has no
    // `stop` field — this is the one cell where the chat-completions premise in the design
    // would have given the wrong answer, since `stop` *is* a chat-completions parameter.
    // `buildCopilotResponsesBody()` emits no stop list and has nowhere to put one, so the
    // value is dropped and the client is told. Same policy and same reasoning as Codex,
    // which shares the wire format. Unmeasured.
    stopSequences: "degrade",
    // `native`, and the one cell where this upstream is cleaner than Codex.
    // `buildCopilotResponsesBody()` emits `reasoning: { effort: request.reasoningEffort }` —
    // the nested first-class Responses shape, forwarded verbatim from canonical. Nothing
    // rewrites it on the way out: `Copilot_Client.proxy()` does not call
    // `normalizeReasoningBody()` (`src/core/reasoning.ts`), which is what makes the Codex
    // cell `degrade`, and no per-model enum narrows it, which is what makes Kiro's `degrade`.
    //
    // The honest boundary: a client-supplied token *budget* still has no wire
    // representation. `claudeToCanonicalRequest()` (`src/inbound/claude/convert.ts`) reads
    // only `output_config.effort` and never `thinking.budget_tokens`, so a budget is lost at
    // the inbound boundary for every upstream. That is the same class of gap as `sampling`
    // above — upstream of the canonical contract, not a Copilot decision — so it does not
    // pull this cell down to `degrade`. What this cell claims is narrow and checkable: the
    // effort level canonical carries reaches the wire unchanged.
    //
    // Unmeasured. What would settle it: a run comparing `outputReasoningTokens` across two
    // effort levels, the way spike §10.4 settled it for Codex.
    thinkingBudget: "native",
    // `buildCopilotResponsesBody()` forwards `request.instructions` as the top-level
    // Responses `instructions` field, verbatim, with no reshaping and no emulation. This is
    // the cell Kiro declares `emulate`, because spike §4 measured Kiro's equivalent field
    // accepted-then-ignored and only `userInputMessage.content` reaching the model.
    //
    // The `?? "You are a helpful assistant."` fallback in the same expression substitutes a
    // default only when canonical carries no instructions — there is no client intent to
    // degrade in that case, so it does not change this cell. Note the inbound side already
    // supplies the same default (`src/inbound/claude/convert.ts`), so the fallback is
    // near-unreachable from the Claude route.
    //
    // Unmeasured, and adherence is a separate question from acceptance: nothing here proves
    // GitHub's endpoint weights `instructions` the way OpenAI's does.
    systemPrompt: "native",
    // No client-addressable cache field exists in this wire format, so the `cacheHint`
    // breakpoints and TTL of Requirement 12.3 have nowhere to land and
    // `buildCopilotResponsesBody()` emits nothing for them. Caching may still happen
    // server-side — `canonicalUsageFromWireUsage()` would surface `cached_tokens` as
    // `cacheReadInputTokens` if the response carried it — but the client's explicit
    // breakpoints are not what produced it, and nothing here has been observed. So: dropped,
    // and reported. Same as Codex, and deliberately not Kiro's `reject`, which rests on
    // spike §7 measuring no cache benefit at all — that measurement is Kiro's, not this
    // upstream's, and cannot be borrowed.
    //
    // One flag for a later measurement: `buildCopilotResponsesBody()` also hardcodes
    // `store: false`. That governs response persistence rather than prompt caching, but it
    // is worth ruling out before reading a zero `cached_tokens` as proof of no caching. What
    // would settle this cell: two identical-prefix requests compared on `cached_tokens`.
    promptCache: "degrade",
    // `buildCopilotResponsesBody()` forwards `request.tools` untouched — there is no
    // sanitizer on the path, unlike Kiro's `sanitizeToolSchema()` (`../kiro/payload.ts`),
    // which strips `additionalProperties`. The `strict` flag
    // `claudeFunctionToolToResponsesTool()` (`src/inbound/claude/server-tools.ts`) sets
    // arrives at the wire as the client set it. Unmeasured; code-verified end to end.
    strictToolSchema: "native",
    // `buildCopilotResponsesBody()` forwards `request.toolChoice` verbatim into
    // `tool_choice`, and Responses accepts `"required"` and `{ type: "function", name }` as
    // first-class values. Nothing narrows the tool list the way Kiro's
    // `computeEffectiveTools()` does, so there is no substitution to report. Unmeasured;
    // code-verified.
    toolChoiceForced: "native",
    // `buildCopilotResponsesBody()` forwards `request.textFormat` as `text: { format }`, the
    // Responses structured-output field, so a `json_schema` format is enforced upstream
    // rather than injected as prose the way Kiro's `structuredOutputInstruction()` must.
    // Unmeasured; code-verified.
    structuredOutput: "native",
    // `web_search` is a Responses hosted tool type and `request.tools` is forwarded
    // untouched, so a client web-search tool reaches this endpoint with its original `type`
    // and the upstream — not the Gateway — would run the search. That is `native` by the
    // same argument as Codex, and it is not Kiro's `emulate`: the Gateway assembles no
    // results of its own on this path.
    //
    // This is the least certain `native` in the file, and worth stating plainly. GitHub's
    // `/responses` is a curated proxy, not OpenAI's endpoint — its model list is filtered by
    // `model_picker_enabled` — and whether it exposes OpenAI's server-side tooling has never
    // been checked here. If it does not, the client sees the upstream's own 4xx rather than a
    // Gateway policy, which is a worse outcome than a declared `reject`. What would settle
    // it: one request carrying `{ type: "web_search" }`. Until then: unmeasured.
    webSearch: "native",
    // Silent substitution owned by the inbound layer and inherited here.
    // `claudeWebToolToResponsesTool()` (`src/inbound/claude/web.ts`) maps a client
    // `web_fetch` tool to `{ type: "web_search" }`, because `web_fetch` is not a Responses
    // hosted type — the ten that exist are listed under `hostedTools` below, and it is not
    // among them. A fetch does still tend to happen, as the `open_page` action of a
    // `web_search_call`, which the same module renders back as `web_fetch_tool_result`
    // (`./web.ts`, `action.type === "open_page"`). The intent survives; the tool the client
    // asked for does not. Changed semantics, so `degrade` — matching Codex, since the
    // substitution happens before either upstream sees the request. Unmeasured.
    webFetch: "degrade",
    // `mcp` is a Responses hosted tool type and `request.tools` is forwarded untouched, so a
    // client MCP toolset reaches the upstream intact and the upstream connects to the server
    // itself. Zero emulation paths, matching Codex. This is the cell Kiro declares
    // `emulate`, because Kiro's `/mcp` endpoint serves exactly one tool of its own and
    // cannot be handed a client toolset (spike §9.1, §9.2) — a Kiro-specific finding that
    // says nothing about this upstream.
    //
    // Carries the same open question as `webSearch` above: whether GitHub's proxy honours
    // hosted tools at all is unmeasured. What would settle it: one request carrying an `mcp`
    // tool with a reachable `server_url`.
    mcpToolset: "native",
  },
  hostedTools: {
    // The ten Responses hosted tool type names, duplicated per upstream on purpose so no
    // Responses type name enters `src/core/` — core keeps `HostedToolPolicyMap` keys opaque
    // (design, `HostedToolPolicyMap`).
    //
    // All ten are listed, and all ten are `native`, for the reason the file header gives:
    // `Copilot_Client.proxy()` posts a Responses body, so these are the type names of *this
    // upstream's own* wire protocol, and `buildCopilotResponsesBody()` forwards
    // `request.tools` with no reshaping. Requirement 19.1 has each forwarded with its
    // original `type`, and that is already what the code does — so `native` here declares
    // existing behavior rather than requesting new behavior. Had the design's
    // chat-completions premise been correct, the honest answer would have been the opposite:
    // chat-completions has no hosted-tool concept, and every one of these would have been
    // `reject`.
    //
    // Every one is unmeasured, and more speculative than the Codex equivalents, which at
    // least talk to OpenAI directly. See `features.webSearch` above for the risk this
    // carries; the per-type follow-up is the same single question — does GitHub's proxy
    // serve hosted tools — and one measurement answers it for the whole set. `web_fetch` is
    // deliberately absent: it is not a Responses hosted type, which is why
    // `features.webFetch` is `degrade`.
    image_generation: "native",
    web_search: "native",
    web_search_preview: "native",
    file_search: "native",
    computer: "native",
    computer_use_preview: "native",
    code_interpreter: "native",
    mcp: "native",
    local_shell: "native",
    tool_search: "native",
  },
}

/**
 * Which Copilot cells rest on a live measurement (Requirement 2.7).
 *
 * Total over `ProviderFeature` by construction — the `Record` type makes the compiler
 * locate a missing key, and Property 3 asserts the same totality at run time — so an
 * unmeasured cell cannot be read as measured through a missing entry.
 *
 * Every value is `unmeasured`, and that is the accurate state rather than a placeholder.
 * Requirement 26.9 makes this upstream declaration-only and there is no connected account
 * here, so no policy above has ever been checked against GitHub's endpoint. The map is
 * uniform today and is expected to stop being uniform: raise a cell to `measured` only
 * alongside a Run_Record, and only for the specific claim that run tested.
 */
export const COPILOT_CAPABILITY_EVIDENCE: Record<ProviderFeature, FeatureEvidence> = {
  sampling: "unmeasured",
  stopSequences: "unmeasured",
  thinkingBudget: "unmeasured",
  systemPrompt: "unmeasured",
  promptCache: "unmeasured",
  strictToolSchema: "unmeasured",
  toolChoiceForced: "unmeasured",
  structuredOutput: "unmeasured",
  webSearch: "unmeasured",
  webFetch: "unmeasured",
  mcpToolset: "unmeasured",
}
