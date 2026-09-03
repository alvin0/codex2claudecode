import type { ProviderCapabilities } from "../../core/provider-capabilities"
import { DEFAULT_RETRY_POLICY, DEFAULT_TIMEOUT_POLICY } from "../../core/provider-capabilities"

/**
 * Declared feature policies for the Codex (OpenAI Responses) upstream.
 *
 * Read this matrix the way `.omc/research/kiro-wire-spike.md` §10.6 sets the rule: a cell
 * states the **observed outcome of the gateway** for a client-supplied field, not the
 * theoretical capability of the upstream. Codex honouring a field in a shape the gateway
 * does not emit is not `native`.
 *
 * The evidence bar differs from Kiro's in one useful way. Kiro answers 200 to unknown
 * fields and discards them (spike §4), so "no error" proves nothing there. This endpoint
 * does the opposite: spike §10.2 measured `400 {"detail":"Unsupported parameter:
 * reasoning_effort"}` on a field it does not accept. So a field this endpoint accepts on a
 * 200 run is genuinely accepted, and a field with no known Responses counterpart is a
 * latent 400 rather than a harmless no-op. Every cell below says which of the two kinds of
 * evidence it rests on — live measurement, or the emitted body read out of
 * `canonicalToCodexBody()` in `./parse.ts`.
 */
export const CODEX_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  passthrough: true,
  usageSupport: true,
  environmentsSupport: true,
  usageEndpointSupport: true,
  tokenCountingSupport: true,
  modelListingSupport: false,
  retryPolicy: DEFAULT_RETRY_POLICY,
  timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
  logBodyDefault: true,
  features: {
    // `native`, and the one cell in this file whose declaration is NOT what today's
    // measurement shows. Recording the tension here rather than resolving it silently.
    //
    // Measured (Run_Record 3, reaffirmed by Run_Record 5, carried into Checkpoint 4 as
    // item 1): the Codex upstream body carries neither `temperature` nor `top_p`. The live
    // case `sampling-native` is green, but it asserts "status 200, `response.completed`,
    // zero notice for sampling" — that proves *zero notice*, not *value reached the wire*.
    // Grep agrees: no file under `src/upstream/codex/` mentions `temperature` or `top_p`,
    // and `src/core/canonical.ts` has no sampling member at all. Sampling is dropped at
    // the **inbound** boundary, for every upstream — it is not a Codex decision, and the
    // Codex upstream never sees the field to decide anything about it.
    //
    // Why `native` anyway: Requirement 10.6 states that a `temperature` sent to this
    // upstream produces **zero** Feature_Notice events for `sampling`. Requirement 10.2
    // makes `degrade` and `emulate` each emit exactly one notice, and Requirement 10.3
    // makes `reject` a 400. Three of the four values are therefore excluded by a normative
    // criterion, and `native` is what remains. Requirement 14.1 then makes the declaration
    // true rather than aspirational: Codex must emit the corresponding Responses fields
    // once canonical carries them (tasks 14 and 15, via `./sampling.ts`).
    //
    // This is not the §10.6 doctrine being waived — it is the doctrine applied to a cell
    // whose gap lives upstream of the canonical contract. `thinkingBudget` below is the
    // contrasting case: there the Codex upstream *does* receive the client's intent and
    // *does* substitute it, which is a Codex-owned outcome and stays `degrade`.
    //
    // Until tasks 14/15 land, this cell is unmeasured. Requirement 14.6 (mapped field
    // present in the Codex body) and a new Run_Record are what make it measured; do not
    // read the green `sampling-native` case as that evidence.
    sampling: "native",
    // `native`, and carrying exactly the same caveat as the `sampling` cell above rather than
    // a stronger one. The Responses API takes `max_output_tokens` as a first-class parameter,
    // so a requested output-length limit has a wire target here — unlike Kiro, where spike §4
    // measured the limit accepted and then discarded, hence `degrade` there. `./sampling.ts`
    // (task 15.1) is what emits it; `canonicalToCodexBody()` emits nothing for it today,
    // because `Canonical_Request` has no `sampling` member yet.
    //
    // Unmeasured, and the same warning applies: **no probe has sent an output limit to this
    // endpoint**, and the green `sampling-native` live case is not that evidence — it asserts
    // zero notice, which says nothing about a value reaching the wire. Requirement 14.6 plus
    // a new Run_Record is what would make this cell measured.
    outputLength: "native",
    // A `sampling` sub-member (Requirement 12.1) with no counterpart this repository can
    // point at: nothing under `src/upstream/codex/` emits a stop list, and the Responses
    // body `canonicalToCodexBody()` builds has no field for one. Combined with the §10.2
    // measurement that this endpoint answers 400 to a parameter it does not support,
    // guessing a field name is a request-killing risk, so the value is dropped and the
    // client is told. That is the `RESPONSES_REJECTED_FIELDS` denylist the design gives
    // `./sampling.ts`, and it satisfies Requirement 14.2 (omit what the API rejects)
    // without the silent part. Unmeasured: no probe has sent a stop list to this endpoint.
    stopSequences: "degrade",
    // spike §10.6, settled by the task 3.2 probe. This is the cell Requirement 4.4 calls
    // the "Codex effort cell": the matrix has no `effort` member, and `thinkingBudget` is
    // the only one carrying client effort/thinking intent.
    //
    // Measured (§10.2): the flat shape `canonicalToCodexBody()` emits today —
    // `reasoning_effort: <level>` — returns `400 {"detail":"Unsupported parameter:
    // reasoning_effort"}` at both `low` and `xhigh`. Live traffic survives only because
    // `normalizeReasoningBody()` (`src/core/reasoning.ts`) deletes that field inside
    // `CodexStandaloneClient.request()` and re-emits `reasoning: { effort }` — but only for
    // a model matching its `^(gpt-5(?:\.[^_]+)?)(?:_(none|low|medium|high|xhigh|max|
    // ultra))?$` regex. Measured for `gpt-5.4-mini`; inferred from the code for a model
    // outside the regex such as `gpt-5-codex`, where effort is lost at 200 with zero
    // notice (§10.3).
    //
    // Both branches are silent substitution, which is `degrade` by definition — and
    // `degrade` carries a Feature_Notice, so the client learns its body was rewritten.
    // Not `native`: the field does not reach the wire as sent. Not `reject`: effort does
    // reach the model on the regex path, and a 400 would delete working behavior. Not
    // `emulate`: the upstream does the reasoning, the gateway does not fake it.
    //
    // §10.4 proves the upstream honours effort in the nested shape (516 vs 14502 reasoning
    // tokens between `low` and `xhigh`) — that is upstream capability, not gateway
    // outcome, and §10.6 says capability does not set the cell. This cell may rise to
    // `native` only after task 19b makes `canonicalToCodexBody()` emit `reasoning:
    // { effort, summary }` AND a new Run_Record shows the nested shape reaching the wire on
    // a model inside the regex and one outside it. Never on inference (§9.4 sets that rule).
    thinkingBudget: "degrade",
    // `canonicalToCodexBody()` forwards `request.instructions` verbatim as the top-level
    // `instructions` field, which is a first-class Responses parameter — no emulation, no
    // reshaping. Measured indirectly by the §10.1 probe: all five runs sent `instructions`
    // at the top level, and the three 200 runs kept it, while §10.2 shows this endpoint
    // 400s a parameter it does not accept. What the probe did *not* isolate is instruction
    // *adherence* — its 120-word cap lived in the prompt, not in `instructions`. Acceptance
    // plus verbatim forwarding is the claim here; contrast Kiro, where the equivalent field
    // was measured to be accepted and then ignored (spike §4), hence `emulate` there.
    systemPrompt: "native",
    // Unmeasured on this endpoint, and `degrade` rather than `native` on purpose.
    //
    // Responses prompt caching is automatic and server-side; there is no client-supplied
    // cache field, so the `cacheHint` breakpoints and TTL of Requirement 12.3 have no wire
    // target and `canonicalToCodexBody()` emits none. Caching may well happen — the
    // gateway already surfaces OpenAI-shaped `input_tokens_details.cached_tokens` as
    // `cacheReadInputTokens` in `src/core/usage.ts` — but the client's explicit breakpoints
    // are not what produced it, and §9.4/§10.6 forbid raising a cell to `native` on
    // reasoning rather than measurement. So: the field is dropped, the client is told, and
    // nothing is claimed about cache hits. Not `reject` (unlike Kiro, where §7 measured no
    // cache benefit at all) — caching does exist here, it is simply not client-addressable.
    // What would settle this: two identical-prefix requests compared on `cached_tokens`.
    promptCache: "degrade",
    // Unmeasured, code-verified. `claudeFunctionToolToResponsesTool()`
    // (`src/inbound/claude/server-tools.ts`) passes `input_schema` through as `parameters`
    // untouched and forwards the client's `strict` flag, and `canonicalToCodexBody()`
    // forwards `request.tools` with no sanitizer on the path. A client asking for strict
    // validation gets strict validation. This is the exact cell Kiro declares `degrade`,
    // because `sanitizeToolSchema()` there strips `additionalProperties`; the divergence is
    // the point of a per-upstream matrix.
    strictToolSchema: "native",
    // Unmeasured, code-verified. `canonicalToCodexBody()` forwards `request.toolChoice`
    // verbatim into `tool_choice`, and Responses accepts `"required"` and
    // `{ type: "function", name }` as first-class values. Nothing narrows the tool list the
    // way Kiro's `computeEffectiveTools()` does, so there is no substitution to report.
    toolChoiceForced: "native",
    // Unmeasured, code-verified. `canonicalToCodexBody()` forwards `request.textFormat`
    // verbatim as `text: { format }`, the Responses structured-output field, so a
    // `json_schema` format is enforced by the upstream. No prose-injection emulation of the
    // kind Kiro needs.
    structuredOutput: "native",
    // Unmeasured on Codex (the green `web-search-native` live case is a **kiro** case),
    // code-verified. `web_search` is one of the ten hosted tool type names Requirement 19.1
    // has this upstream forward with its original `type`, and `claudeWebToolToResponsesTool()`
    // (`src/inbound/claude/web.ts`) preserves `allowed_domains` as `filters` and
    // `user_location`. The upstream runs the search; the gateway assembles no results of its
    // own, which is what separates this from Kiro's `emulate`.
    webSearch: "native",
    // Silent substitution, code-verified: `claudeWebToolToResponsesTool()`
    // (`src/inbound/claude/web.ts`) maps a client `web_fetch` tool to Responses
    // `{ type: "web_search" }`, because `web_fetch` is **not** among the ten hosted type
    // names in Requirement 19.1 — Responses has no such tool. A fetch does still tend to
    // happen, as the `open_page` action of a `web_search_call`, which
    // `codexWebCallToClaudeBlocks()` renders back as `web_fetch_tool_result`. So the intent
    // survives while the tool the client asked for does not: changed semantics that today go
    // unreported, which is `degrade`. Not `reject` — the substitution works often enough
    // that a 400 would remove behavior clients have. Not `native` — the wire tool is a
    // different tool.
    webFetch: "degrade",
    // Requirement 2.4, preserving current behavior. `canonicalToCodexBody()` forwards a
    // client `mcp` toolset inside `request.tools` untouched and the upstream connects to
    // the MCP server itself, so Requirement 22.8 keeps this upstream on zero emulation
    // paths. `mcp` is also one of the ten hosted type names in Requirement 19.1. This is
    // the cell Kiro declares `emulate`, because Kiro's `/mcp` endpoint serves exactly one
    // tool of its own and cannot be handed a client toolset (spike §9.1, §9.2).
    mcpToolset: "native",
  },
  hostedTools: {
    // The ten Responses hosted tool type names, duplicated per upstream on purpose so no
    // Responses type name enters `src/core/` — core keeps `HostedToolPolicyMap` keys opaque
    // (design, `HostedToolPolicyMap`).
    //
    // All ten are `native` for one reason that covers the whole set: these are the type
    // names of *this upstream's own* wire protocol, and Requirement 19.1 has each forwarded
    // with its original `type` rather than reshaped by
    // `claudeFunctionToolToResponsesTool()`. `canonicalToCodexBody()` already forwards
    // `request.tools` untouched, so `native` is a declaration of existing behavior, not a
    // request for new behavior. Unmeasured per type: the effort probe (§10.1) sent no tools,
    // and Requirement 19.6 covers `code_interpreter` with a unit test rather than a live
    // call. Note `web_fetch` is deliberately absent — it is not a Responses hosted type,
    // which is why `features.webFetch` above is `degrade`.
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
