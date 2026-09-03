import type { ProviderCapabilities } from "../../core/provider-capabilities"
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
    stopSequences: "reject",
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
    promptCache: "reject",
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
