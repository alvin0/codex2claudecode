import type { FeaturePolicy, ProviderCapabilities } from "../../core/provider-capabilities"
import { DEFAULT_RETRY_POLICY } from "../../core/provider-capabilities"
import { KIRO_FIRST_TOKEN_TIMEOUT_MS } from "./constants"

/**
 * Declared feature policies for the Kiro (CodeWhisperer `generateAssistantResponse`) upstream.
 *
 * Every non-obvious cell cites the measurement behind it in
 * `.omc/research/kiro-wire-spike.md`. A cell asserted without evidence is the
 * defect this matrix exists to eliminate: the API is lenient and answers 200 to
 * unknown fields (spike §4, `totallyUnknownField`), so "no error" proves nothing
 * about whether a field reached the model.
 */
export const KIRO_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  passthrough: false,
  usageSupport: true,
  environmentsSupport: false,
  usageEndpointSupport: false,
  tokenCountingSupport: false,
  modelListingSupport: true,
  retryPolicy: {
    ...DEFAULT_RETRY_POLICY,
    maxRetries: 3,
  },
  timeoutPolicy: {
    requestTimeoutMs: 0,
    streamIdleTimeoutMs: 300_000,
    firstTokenTimeoutMs: KIRO_FIRST_TOKEN_TIMEOUT_MS,
  },
  logBodyDefault: true,
  features: {
    // Covers `temperature` and `topP` only — a requested output-length limit is its own
    // feature, `outputLength` below, because the two behave differently on this endpoint.
    //
    // No wire field for either control exists here, and spike §4 shows unknown fields
    // answering 200 while being silently discarded, so inventing one would look honoured and
    // change nothing. A client asking for these is asking for behavior this endpoint cannot
    // approximate at all, which is `reject` — not the accepted-then-ignored case `degrade`
    // names, which is what the cell below records.
    sampling: "reject",
    // spike §4: `inferenceConfig: {maxTokens: 4}` returned 200 and still streamed a
    // 296-frame essay — the limit is accepted by the endpoint and then ignored. That is
    // changed semantics the client can be told about, not a request that cannot be served,
    // so `degrade` rather than the `sampling` cell's `reject`. Folding it into `sampling`
    // would refuse every Claude request, since `max_tokens` is mandatory in the Claude
    // Messages API (Requirements 3.7, 3.8).
    outputLength: "degrade",
    // spike §4: no stop-sequence field exists on this endpoint, and the same paragraph
    // shows unknown fields answering 200 while being discarded — sending one would look
    // honoured and change nothing.
    //
    // `degrade` rather than `reject`, on the same reading `outputLength` and `promptCache`
    // take: a dropped stop sequence changes *where the reply ends*, never whether the request
    // can be served, so the client can be told and handed a longer reply rather than refused.
    // Read the other way this cell refuses every request that carries `stop_sequences` — 19 of
    // 100 consecutive Claude Code requests in one recorded session — which is the failure mode
    // Requirements 3.7 / 3.8 already rule out for `max_tokens`. Codex and Copilot declare
    // `degrade` on the identical fact (no stop field on the endpoint), so this is the matrix
    // agreeing with itself rather than a Kiro-specific concession.
    stopSequences: "degrade",
    // spike §4 + §6: effort is a per-model enum validated server-side
    // (`REQUEST_BODY_INVALID` outside `[low, medium, high, xhigh, max]`), and §6 records
    // the enum plus default level per model. A token budget has no wire representation,
    // so a requested budget lands on the nearest enum level — changed semantics, declared.
    thinkingBudget: "degrade",
    // spike §4: A/B with a sentinel instruction over 3 runs — `payload.systemPrompt` and
    // `conversationState.systemPrompt` both never reached the model; only text appended to
    // `userInputMessage.content` did. `embedInstructions()` is the emulation.
    systemPrompt: "emulate",
    // spike §7: reusing `conversationId` produced no downward credit trend (0.0416 /
    // 0.0279 / 0.0307) and a brand-new id was the cheapest run (0.0225); no
    // `cacheReadInputTokens` field was ever observed. No cache to address.
    //
    // `degrade` rather than `reject`, on the same reading the `outputLength` cell above takes:
    // a dropped cache hint changes what the request *costs*, never what it answers, so the
    // client can be told rather than refused. Read the other way this cell refuses every
    // request from a client that always sends `cache_control` — Claude Code does — which is
    // the failure mode Requirements 3.7 / 3.8 already rule out for `max_tokens`. Codex and
    // Copilot declare `degrade` on the identical fact (no cache on the endpoint), so this is
    // the matrix agreeing with itself rather than a Kiro-specific concession.
    promptCache: "degrade",
    // `sanitizeToolSchema()` (`./payload.ts`) strips `additionalProperties` from every
    // tool schema, so a client asking for strict validation gets a non-strict schema.
    strictToolSchema: "degrade",
    // No forced-tool field exists on this endpoint; `computeEffectiveTools()`
    // (`./index.ts`) approximates `required`/named `tool_choice` by narrowing the tool
    // list, which is a semantic change the client is not told about today.
    toolChoiceForced: "degrade",
    // `structuredOutputInstruction()` (`./index.ts`) injects the schema as prose. It works
    // for the same reason as `systemPrompt` above: content is the only channel that
    // reaches the model (spike §4).
    structuredOutput: "emulate",
    // spike §9.2: `POST /mcp` `tools/list` advertises exactly one tool, `web_search`. The
    // gateway calls it over JSON-RPC and assembles `web_search_tool_result` itself, so
    // this is gateway emulation over a server tool, not native passthrough (spike §9.4).
    webSearch: "emulate",
    // spike §9.3 + §9.4 (settled by the task 2.2 probe): `tools/list` carries no fetch
    // tool, and `tools/call` for `web_fetch`, `webFetch`, and `fetch` each returned
    // JSON-RPC `-32602 "Tool not found"`. The `WHERE a server-side fetch tool exists`
    // clause of Requirements 4.2 and 18.6 does not hold — this cell is `emulate`, not
    // `native`, and must not be raised without a new Run_Record.
    webFetch: "emulate",
    // spike §9.1: the `/mcp` endpoint is stateless, negotiates `2025-06-18`, reports
    // `capabilities.tools.listChanged = false`, and its whole toolset is `web_search`.
    // There is nothing to forward a client toolset to, so the gateway expands and executes
    // it. Gated by `NATIVE_MCP_EMULATION`; with the flag off the existing 400 stands.
    mcpToolset: "emulate",
  },
  hostedTools: {
    // The ten Responses hosted tool type names are duplicated per upstream on purpose so
    // no Responses type name enters `src/core/` (design, `HostedToolPolicyMap`).
    //
    // One measurement covers all ten: spike §9.2 shows Kiro's server-side toolset is
    // exactly `web_search`, and §9.3 shows unadvertised names answer `-32602 "Tool not
    // found"`. So `web_search` (and its Responses alias) is the only hosted intent Kiro
    // can serve at all, `mcp` follows `features.mcpToolset`, and the rest have neither an
    // upstream tool nor a gateway emulation — a 400 naming an alternative is the honest
    // outcome, and it is what `validateUnsupportedServerTools()` already returns today.
    image_generation: "reject",
    web_search: "emulate",
    web_search_preview: "emulate",
    file_search: "reject",
    computer: "reject",
    computer_use_preview: "reject",
    code_interpreter: "reject",
    mcp: "emulate",
    local_shell: "reject",
    tool_search: "reject",
  },
}

/**
 * The policy for a hosted tool type this upstream has **not** declared above.
 *
 * Same role and reasoning as the Codex and Copilot constants of the same shape: a lookup miss in
 * `resolveHostedToolPolicy()` is not a fifth outcome, and Requirement 19.4 fixes what it means —
 * emit a notice and complete the request rather than refuse it or throw. `capabilities.ts` is the
 * one file in this directory allowed to spell a policy literal (design decision D3), so the value
 * is read from here by whatever resolves a hosted tool.
 *
 * `degrade` rather than the outcome the ten declared types mostly get, and the difference is the
 * point: an *undeclared* type is one nobody measured against this endpoint, so refusing it would
 * be asserting knowledge this file does not have. The ten types that were measured say `reject`
 * on their own cells above.
 *
 * Consumer: `validateUnsupportedServerTools()` in `./index.ts`, once the hosted tool path there is
 * routed through `resolveHostedToolPolicy()` and `FeatureDecisions` (task 29.3's Kiro half).
 */
export const KIRO_UNDECLARED_HOSTED_TOOL_POLICY: FeaturePolicy = "degrade"

/**
 * The policy for a toolset that asks the gateway to obtain the user's approval before each call
 * (`require_approval: "always"`), Requirement 23.1.
 *
 * This gateway is one-way: a request arrives, a stream goes back, and there is no channel on which
 * to ask the user anything mid-turn. So an approval can neither be obtained nor faked, and the two
 * remaining options are to run the tool unapproved — the one thing Requirement 23.4 forbids — or to
 * refuse. This cell refuses, which is why the 400 names `require_approval: "never"`: that is the
 * value under which the client itself states the calls need no approval.
 *
 * Lives here rather than at the resolution site because `capabilities.ts` is the one file in this
 * directory allowed to spell a policy literal (design decision D3); `./mcp-toolset.ts` reads it and
 * hands it to `FeatureDecisions`, so the 400 comes out of `resolveFeature()` like every other.
 */
export const KIRO_MCP_APPROVAL_REQUIRED_POLICY: FeaturePolicy = "reject"

/**
 * The policy for the object forms of `require_approval` — `{ read_only }` / `{ tool_names }` —
 * Requirement 23.3.
 *
 * Reporting rather than refusing, because the request *can* be served: the toolset's tools are
 * withheld under the most restrictive reading of the selection and the turn continues. `degrade` is
 * the cell that says "accepted, with changed semantics the client is told about", and it carries the
 * second half of Requirement 23.3 for free — under `NATIVE_STRICT` `resolveFeature()` escalates it
 * to the same 400 the cell above produces, which is what a client asking for strictness about
 * silently changed semantics is asking for.
 */
export const KIRO_MCP_APPROVAL_SELECTIVE_POLICY: FeaturePolicy = "degrade"
