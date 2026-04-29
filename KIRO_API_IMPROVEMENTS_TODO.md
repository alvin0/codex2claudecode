# Kiro API Improvements Todo

Created from the Kiro API analysis pass on 2026-04-29. Use this file as the implementation and audit checklist for the next Kiro provider API improvements.

## Ground Rules

- [ ] Keep existing Kiro `/v1/messages/count_tokens` local-only; do not call upstream Kiro for token counting.
- [ ] Preserve current raw `/usage` and `/wham/usage` compatibility unless an explicit normalized mode is requested.
- [ ] Treat all token counts added for Kiro as approximate/local unless a real upstream token-count endpoint is confirmed.
- [ ] Expose only web-search-specific MCP behavior; do not expose arbitrary `/mcp` passthrough.
- [ ] Do not add Kiro `/environments` support until a real upstream endpoint is confirmed.
- [ ] Do not copy implementation details from AGPL references; use them only as behavioral evidence.
- [ ] Avoid logging access tokens, refresh tokens, profile ARNs, MCP authorization headers, or raw credential payloads.

## Immediate Stability Track: Source Comparison Priorities

Use this track before optional API expansion work. These items came from comparing the current TypeScript Kiro provider against `.temp/kiro-gateway` and from Oracle prioritization. The goal is stability, debuggability, and Claude Code compaction safety, not full feature parity.

### Priority Order

- [x] P0: Add Kiro streaming first-token timeout and retry before any downstream assistant stream event is emitted. `STATUS: DONE`
- [x] P1: Add structured Kiro/network error classification with actionable, credential-safe messages. `STATUS: DONE`
- [x] P1: Add opt-in bounded debug-on-error capture for opaque Kiro failures. `STATUS: DONE`
- [x] P2: Audit Kiro token-count and usage estimates for conservative compaction behavior. `STATUS: DONE`
- [x] P3: Revisit truncation recovery only if the repo can detect real upstream truncation reliably. `STATUS: DONE - DEFERRED`

### Stability Phase A: First-Token Timeout And Retry

`STATUS: DONE`

#### Goal

- [x] Prevent Kiro streaming requests from hanging until the long read timeout when upstream accepts the request but emits no first bytes.
- [x] Retry only before the gateway has emitted any downstream assistant stream event.
- [x] Cap retries tightly to avoid duplicate upstream work.
- [x] Preserve existing Kiro stream parsing, SSE formatting, web_search preflight, payload trimming, and request logging behavior.

#### Target Files And Symbols

- [x] Add a small helper in `src/upstream/kiro/stream-retry.ts` or an equivalent narrowly scoped module.
- [x] Add or export constants near `src/upstream/kiro/constants.ts`:
  - [x] `KIRO_FIRST_TOKEN_TIMEOUT_MS` or `FIRST_TOKEN_TIMEOUT_MS`, default around `2_000` ms.
  - [x] `KIRO_FIRST_TOKEN_MAX_RETRIES` or `FIRST_TOKEN_MAX_RETRIES`, default `1` to `3` attempts.
- [x] Wire the helper into normal Kiro streaming request paths in `src/upstream/kiro/index.ts` before `streamKiroResponse(...)` or equivalent parsing begins.
- [x] Wire the helper into web_search preflight generation with `maxRetries: 0` so first-token stalls fail fast after emitted server-tool events without retrying.
- [x] Ensure the helper works with `Kiro_Client.generateAssistantResponse(...)` in `src/upstream/kiro/client.ts` without changing non-streaming behavior.
- [x] Confirm `withLoggedResponseBody(...)` still sees the full stream, including the first chunk that the retry helper peeks.

#### Implementation Checklist

- [x] Define a local `FirstTokenTimeoutError` with attempt count and safe message.
- [x] Implement `streamWithFirstTokenRetry(makeResponse, options)` or equivalent.
- [x] On each attempt, request a streaming `Response` from Kiro.
- [x] If `response.body` is absent, return the response unchanged.
- [x] Read exactly the first chunk with a short timeout.
- [x] If the timeout wins before any chunk arrives, cancel the reader/body best-effort and retry.
- [x] If the first chunk arrives, rebuild a `Response`/`ReadableStream` that yields the captured chunk first, then the remaining original body.
- [x] Do not retry after any assistant byte has been handed to `streamKiroResponse`, `collectKiroResponse`, or downstream SSE conversion.
- [x] Map exhausted retries to the existing Kiro upstream timeout/error path, preferably a safe `504`-style response.
- [x] Ensure caller abort signals still cancel pending first-token waits.
- [x] Ensure metrics/logging can distinguish first-token timeout from normal streaming read timeout.

#### Tests

- [x] Add focused helper tests in `test/upstream/kiro/first-token-retry.test.ts`.
- [x] Test immediate first chunk: one upstream call, no retry, first chunk preserved.
- [x] Test first attempt stalls then second attempt succeeds: exactly two upstream calls, final stream contains only successful attempt bytes.
- [x] Test all attempts stall: helper throws/maps `FirstTokenTimeoutError` with attempt count.
- [x] Test caller abort signal cancels the pending first-token wait without retrying indefinitely.
- [x] Test stream body cancellation on timed-out attempts with a controllable `ReadableStream`.
- [x] Add provider-level streaming tests in `test/upstream/kiro/index.test.ts` proving retry happens before assistant canonical/SSE events are emitted, and web_search preflight first-token stalls fail fast after server-tool events without retrying.
- [x] Add regression coverage that non-streaming Kiro requests do not use the first-token retry helper.

#### Audit Evidence

- [x] Record chosen timeout/retry defaults and why they are conservative.
- [x] Record before/after behavior for a stream that never emits first bytes.
- [x] Record tests proving no duplicate downstream events are emitted across retries.
- [x] Record that no AGPL implementation was copied from `.temp/kiro-gateway`.

#### Implementation Notes

- Completed on 2026-04-29.
- Added `src/upstream/kiro/stream-retry.ts` with `FirstTokenTimeoutError` and `streamWithFirstTokenRetry(...)`.
- Added `KIRO_FIRST_TOKEN_TIMEOUT_MS = 2_000` and `KIRO_FIRST_TOKEN_MAX_RETRIES = 1` defaults in `src/upstream/kiro/constants.ts`, plus env override helpers for `KIRO_FIRST_TOKEN_TIMEOUT_MS` and `KIRO_FIRST_TOKEN_MAX_RETRIES`.
- Wired retry into the normal Kiro streaming path in `src/upstream/kiro/index.ts`.
- Wired the first-token helper into the web_search-preflight assistant stream with `maxRetries: 0`; after server-tool use/result events are emitted, a stalled Kiro generation now yields one stream error and does not retry or duplicate downstream tool events.
- Non-streaming Kiro responses continue to use the existing direct `generateAssistantResponse(...)` path without first-token retry.
- The retry helper peeks only the first successful chunk and rebuilds the response stream so `withLoggedResponseBody(...)` and `streamKiroResponse(...)` still receive the full successful stream.
- Exhausted first-token retries map to a safe `504` canonical error in non-preflight stream setup, or a safe stream error message inside an already-open preflight stream.
- No AGPL implementation was copied; the code is a TypeScript implementation against this repo's existing response/logging architecture and tests.

#### Test Evidence

- `bun test test/upstream/kiro/first-token-retry.test.ts test/upstream/kiro/index.test.ts` -> `34 pass`, `0 fail`.
- 2026-04-29 regression update: `bun test test/inbound/claude-edge.test.ts test/upstream/kiro/index.test.ts` -> `105 pass`, `0 fail`.
- `bun test test/upstream/kiro` -> `176 pass`, `0 fail`.
- `bun run typecheck` -> success.
- LSP diagnostics were initially unavailable because `typescript-language-server` was missing; after installing `typescript-language-server` and `basedpyright`, source diagnostics ran successfully with no source errors reported.

### Stability Phase B: Structured Kiro And Network Error Classification

`STATUS: DONE`

#### Goal

- [x] Replace opaque Kiro/network failures with actionable, credential-safe error messages while preserving status/body information needed for debugging.
- [x] Keep retry semantics unchanged unless a test proves a current retry path is wrong.
- [x] Make user-facing messages distinguish connectivity, DNS, timeout, abort, auth/quota, payload-size, and upstream-service failures.

#### Target Files And Symbols

- [x] Review `KiroNetworkError`, `KiroHttpError`, and `requestOnce()` in `src/upstream/kiro/client.ts`.
- [x] Review `mapKiroError(...)`, `validateUnsupportedServerTools(...)`, and provider error handling in `src/upstream/kiro/index.ts`.
- [x] Consider adding `src/upstream/kiro/errors.ts` for table-driven classifiers and safe messages.
- [x] Reuse existing constants from `src/upstream/kiro/constants.ts` where timeout/retry values are already defined.

#### Implementation Checklist

- [x] Add a Kiro error category type, for example `network_dns`, `network_connect`, `network_timeout`, `caller_abort`, `auth`, `quota`, `payload_too_large`, `upstream_5xx`, `mcp_error`, `unknown`.
- [x] Classify `fetch`/Bun network failures without depending on exact localized error strings.
- [x] Classify caller abort separately from upstream read timeout.
- [x] Preserve raw HTTP status and bounded raw body preview on `KiroHttpError`.
- [x] Add special handling for known opaque Kiro payload-size/body-shape errors when the body mentions malformed request/content length/context limit.
- [x] Preserve existing retry behavior for `403`, `429`, and `5xx` until separately changed.
- [x] Ensure public error bodies never include `Authorization`, `accessToken`, `refreshToken`, `profileArn`, MCP auth headers, or raw credential JSON.
- [x] Keep unsupported `web_fetch` and `mcp` errors distinct and actionable rather than generic.

#### Tests

- [x] Extend `test/upstream/kiro/client.test.ts` for classified fetch failures.
- [x] Extend `test/upstream/kiro/index.test.ts` for mapped public error bodies.
- [x] Test DNS-like failure, connect failure, caller abort, first-token timeout, read timeout, `403`, `429`, `5xx`, and opaque Kiro `400` body.
- [x] Test payload-size/body-shape error enhancement does not change retry count.
- [x] Test redaction for token-like fields in raw body previews and logs.
- [x] Test unsupported `web_fetch` and `mcp` keep returning before any upstream generation/MCP call.

#### Audit Evidence

- [x] Record old vs new public error body examples.
- [x] Record retry counts for each classified error.
- [x] Record any intentionally unclassified messages and why.
- [x] Record redaction test output.

#### Implementation Notes

- Completed on 2026-04-29.
- Added `src/upstream/kiro/errors.ts` with `KiroErrorCategory`, `classifyNetworkError(...)`, `classifyHttpError(...)`, `publicHttpErrorBody(...)`, and redaction helpers.
- Updated `KiroNetworkError` to carry `category` and redacted `detail`, while preserving caller abort pass-through behavior in `Kiro_Client.requestOnce(...)`.
- Updated `KiroHttpError` to carry `category` while preserving raw `status`, `headers`, and `body` internally.
- Updated provider public mapping so auth/quota/payload/upstream/network errors return actionable, credential-safe text.
- Split unsupported server-tool errors so `web_fetch` and generic `mcp` produce distinct remediation guidance before any upstream call.
- Retry behavior for `403`, `429`, and `5xx` remains unchanged.

#### Test Evidence

- `bun test test/upstream/kiro/client.test.ts test/upstream/kiro/index.test.ts` -> `59 pass`, `0 fail`.
- `bun test test/upstream/kiro` -> `174 pass`, `0 fail`.
- `bun run typecheck` -> success.

### Stability Phase C: Opt-In Debug-On-Error Capture

`STATUS: DONE`

#### Goal

- [x] Make opaque Kiro failures diagnosable without enabling unsafe raw logging by default.
- [x] Capture enough bounded context to debug malformed upstream responses, parse failures, MCP failures, and Kiro `400` responses.
- [x] Avoid changing stream consumption behavior.

#### Target Files And Symbols

- [x] Extend request log detail support in `src/core/request-logs.ts`.
- [x] Review runtime log wiring in `src/app/runtime.ts`.
- [x] Reuse Kiro response-body chunk hooks such as `withLoggedResponseBody(...)` in `src/upstream/kiro/index.ts`.
- [x] Review parse/stream error paths in `src/upstream/kiro/parse.ts`.

#### Implementation Checklist

- [x] Add an explicit opt-in flag or mode, for example `KIRO_DEBUG_ON_ERROR=1`, not enabled by default.
- [x] Capture bounded request metadata: provider, route, model, stream flag, retry counts, error category, status code, request id if present.
- [x] Capture bounded upstream response preview with a strict byte/char cap.
- [x] Capture bounded transformed/canonical event preview when stream parsing fails.
- [ ] Capture MCP request/response previews for `web_search` only, with credentials redacted. `STATUS: TODO - NOT IMPLEMENTED IN THIS BATCH`
- [x] Redact `Authorization`, Claude MCP `authorization_token`, `accessToken`, `refreshToken`, `idToken`, `profileArn`, `mcpAuthorization`, and token-looking values recursively.
- [x] Ensure debug capture is written only on error or configured error modes, not for every successful stream.
- [x] Ensure response-body teeing does not consume, reorder, or drop stream chunks.
- [x] Add a retention/size cap so repeated Kiro failures cannot grow logs unbounded.

#### Tests

- [x] Add or extend request log tests in `test/runtime.test.ts` for debug-on-error opt-in behavior.
- [x] Add Kiro provider tests proving HTTP canonical-error raw/transformed previews are capped/redacted.
- [x] Test recursive redaction of nested token-like fields.
- [x] Test successful/default paths do not write debug bundles unless explicitly configured.
- [ ] Test stream parse failure writes a bounded diagnostic bundle while still returning safe public error output. `STATUS: TODO - NOT IMPLEMENTED IN THIS BATCH`
- [ ] Test MCP web_search failure writes only redacted, bounded MCP context. `STATUS: TODO - NOT IMPLEMENTED IN THIS BATCH`

#### Audit Evidence

- [x] Record default-off behavior.
- [x] Record max preview sizes and retention policy.
- [x] Record redaction examples with fake credentials.
- [x] Record that stream output is unchanged when debug capture is enabled.

#### Implementation Notes

- Completed on 2026-04-29.
- Added `src/core/debug-capture.ts` with `KIRO_DEBUG_ON_ERROR=1` opt-in, bounded previews, and recursive redaction helpers.
- Extended `RequestProxyLog` with optional `debug` detail data. Recent-log summaries continue omitting proxy debug details; full detail files preserve them.
- Added Kiro canonical-error debug bundles for both OpenAI-compatible and Claude-compatible Kiro inbound adapters.
- Debug bundles include provider, route, status, model, safe error preview, request preview, upstream request preview, upstream response preview, and transformed response preview when available.
- Stream parse-failure debug bundles and MCP web_search request/response debug previews remain future work; they require additional upstream parse/MCP hooks so logging can capture those paths without changing stream or MCP behavior.
- Debug preview cap is `DEBUG_PREVIEW_LIMIT = 4000` characters per field and the existing request-log retention limit remains `MAX_REQUEST_LOG_ENTRIES = 100`.
- Default behavior remains off unless `KIRO_DEBUG_ON_ERROR=1` is set.

#### Test Evidence

- `bun test test/runtime.test.ts test/upstream/kiro/index.test.ts` -> `57 pass`, `0 fail`.
- `bun test test/upstream/kiro test/runtime.test.ts` -> `197 pass`, `0 fail`.
- `bun run typecheck` -> success.

### Stability Phase D: Count And Usage Safety Audit

`STATUS: DONE`

#### Goal

- [x] Ensure local Kiro token estimates are conservative enough for Claude Code context-management and compaction decisions.
- [x] Avoid promising billing-accurate token counts.
- [x] Keep `/v1/messages/count_tokens` local-only unless an official upstream token-count endpoint is confirmed later.

#### Target Files And Symbols

- [x] Review `countKiroClaudeInputTokens(...)` in `src/inbound/claude/kiro-count.ts`.
- [x] Review Kiro usage/event parsing in `src/upstream/kiro/parse.ts`.
- [x] Review fallback input usage estimation in `src/upstream/kiro/index.ts`.
- [x] Review usage UI parsing in `src/ui/limits.ts` before moving any logic to shared modules.

#### Implementation Checklist

- [x] Add golden fixtures for text-only messages, multi-turn messages, tools, tool results, images, cache-control blocks, and very large payloads.
- [x] Check that tool descriptions and tool schemas are counted in a stable way.
- [x] Check that supplemental Claude request inputs that affect upstream prompt size are counted locally: `mcp_servers`, `output_config.format`, `thinking`, and `tool_choice`.
- [x] Check that image/media blocks are counted conservatively without trying to infer real Kiro billing.
- [x] Check that empty `messages` remains a 400 for Kiro Claude count_tokens.
- [x] Confirm Kiro adapter still skips upstream `inputTokens` for `/v1/messages/count_tokens`.
- [x] Keep `estimated` metadata out of compatibility-sensitive response shapes unless explicitly tested against clients.
- [x] Document expected mismatch between local estimates, Kiro billing, and Kiro `contextUsagePercentage`.

#### Tests

- [x] Extend `test/inbound/claude-edge.test.ts` for Kiro count_tokens golden cases.
- [x] Add tests for tools/tool_result/image/cache-control counting if missing.
- [x] Add large-payload estimate tests proving the count remains deterministic.
- [x] Add regression coverage proving large structured output schemas and supplemental metadata increase Kiro count_tokens estimates instead of leaving them unchanged.
- [x] Add parse/provider tests for usage events with and without concrete input tokens.
- [x] Add tests for context-usage fallback only when concrete token counts are absent.
- [x] Add tests that raw `/usage` remains unchanged if usage normalization is implemented later.

#### Audit Evidence

- [x] Record golden fixture names and expected counts.
- [x] Record estimator limitations in the audit log.
- [x] Record any intentional over-estimation choices made for compaction safety.
- [x] Record exact test command output.

#### Implementation Notes

- Completed on 2026-04-29.
- Added deterministic Kiro `/v1/messages/count_tokens` golden coverage in `test/inbound/claude-edge.test.ts`.
- Kiro `/v1/messages/count_tokens` remains local-only and now adds approximate supplemental counts for `mcp_servers`, `output_config.format`, `thinking`, and `tool_choice` using the same label-plus-stringified-value shape as Claude supplemental input serialization.
- Golden counts currently asserted:
  - text-only: `11`
  - tool definition/schema: `40`
  - cache-control + tool_use + tool_result + image: `148`
  - large 10k-character payload: `1446`
- Existing parse/provider tests already cover concrete Kiro object usage, context-usage fallback, server-tool usage merging, and raw `/usage` compatibility.
- Estimator remains approximate/local and intentionally does not claim Kiro billing accuracy.

#### Test Evidence

- `bun test test/inbound/claude-edge.test.ts test/upstream/kiro/parse.test.ts test/upstream/kiro/index.test.ts` -> `137 pass`, `0 fail`.
- 2026-04-29 regression update: `bun test test/inbound/claude-edge.test.ts test/upstream/kiro/index.test.ts` -> `105 pass`, `0 fail`.
- `bun test test/inbound/claude-edge.test.ts test/upstream/kiro test/runtime.test.ts` -> `268 pass`, `0 fail`.
- `bun run typecheck` -> success.

### Stability Phase E: Defer Truncation Recovery Until Detection Is Reliable

`STATUS: DONE - DEFERRED`

#### Goal

- [x] Avoid synthetic recovery messages unless the repo can reliably detect real upstream truncation.
- [x] Preserve current payload trimming/context-error behavior as the primary safety mechanism.

#### Checklist

- [x] Audit current stream stop-reason handling in `src/upstream/kiro/parse.ts` before adding recovery state.
- [x] Confirm existing `payloadOverflowMode` behavior in `src/upstream/kiro/payload.ts` covers common oversized request cases.
- [x] Add tests for known truncation indicators before generating synthetic tool results or recovery messages.
- [x] Do not add reference-style truncation recovery state unless the detection tests are deterministic.

#### Audit Evidence

- [x] Record why truncation recovery remains deferred.
- [x] Record which truncation signals are reliable vs ambiguous.
- [x] Record existing payload trimming/context-error coverage.

#### Decision Notes

- Completed as an explicit deferral on 2026-04-29.
- No synthetic truncation recovery was added because current deterministic coverage supports payload trimming/context-error and stop-reason handling, but does not prove a reliable upstream truncation signal suitable for injecting synthetic tool results or recovery messages.
- Existing safety remains in `src/upstream/kiro/payload.ts` via `payloadOverflowMode: "trim" | "context_error"` and in `src/upstream/kiro/parse.ts` via current stop-reason handling.
- Future work should add deterministic truncation-signal tests before adding recovery state.

## Phase 1: Normalize Kiro Usage Without Breaking Raw Compatibility

### Design

- [ ] Decide normalized access shape, preferably `GET /usage?format=normalized`.
- [ ] Keep `GET /usage` and `GET /wham/usage` raw by default.
- [ ] Define a stable normalized response shape with a `raw` field for unknown upstream fields.
- [ ] Include defensive optional fields for known Kiro/Amazon Q usage shapes:
  - [ ] `limits`
  - [ ] `daysUntilReset`
  - [ ] `nextDateReset`
  - [ ] `subscriptionInfo`
  - [ ] `usageBreakdownList`
  - [ ] `featureType` / `resourceType`
  - [ ] `currentUsageLimit`, `totalUsageLimit`, `percentUsed`
- [ ] Confirm whether normalized output should be UI-oriented, API-oriented, or both.

### Implementation

- [ ] Move reusable Kiro usage parsing from `src/ui/limits.ts` into a non-UI module.
- [ ] Keep UI code importing the shared parser instead of duplicating logic.
- [ ] Add normalized-mode handling in `src/app/runtime.ts` or in `Kiro_Upstream_Provider.usage()` with a clear compatibility boundary.
- [ ] Ensure `/wham/usage` remains a raw compatibility alias unless explicitly documented otherwise.
- [ ] Keep upstream error behavior compatible with current runtime proxy behavior.

### Tests

- [ ] Add tests for raw `/usage` unchanged behavior.
- [ ] Add tests for `/usage?format=normalized` response shape.
- [ ] Add tests for `Output.message` JSON wrapper if the shared parser supports it.
- [ ] Add tests for missing/partial usage fields.
- [ ] Add tests that auth/credential-like fields are not introduced into normalized output.

### Audit Evidence

- [ ] Capture before/after response examples for raw and normalized modes.
- [ ] Record which fields are guaranteed vs best-effort.
- [ ] Note any pre-existing upstream shape uncertainty.

## Phase 2: Add Kiro OpenAI Input Token Estimation

### Design

- [ ] Add Kiro support for `POST /v1/responses/input_tokens` only as local approximate estimation.
- [ ] Response should match OpenAI-style shape:

```json
{ "object": "response.input_tokens", "input_tokens": 123 }
```

- [ ] Decide whether to estimate original canonical input or post-conversion Kiro payload.
- [ ] Recommended default: estimate original canonical request and document it as approximate.
- [ ] Decide whether to expose an `estimated: true` marker. If added, verify client compatibility first.

### Implementation

- [ ] Add `{ path: "/v1/responses/input_tokens", method: "POST" }` to `OpenAI_Kiro_Inbound_Adapter`.
- [ ] Special-case the input-token route in `src/inbound/openai/index.ts` before normal proxy generation.
- [ ] Add `Kiro_Upstream_Provider.inputTokens()` returning a local `Response.json(...)`.
- [ ] Reuse `normalizeCanonicalRequest()` for Responses-style input.
- [ ] Refactor or export Kiro input estimation logic instead of duplicating private estimation code.
- [ ] Ensure invalid JSON and invalid request shapes return OpenAI-style 400 errors.
- [ ] Ensure this route never calls `generateAssistantResponse`.

### Tests

- [ ] Add Kiro route registration coverage in `test/app/bootstrap-kiro.test.ts`.
- [ ] Add OpenAI Kiro input-token route tests in `test/inbound/openai.test.ts` or an edge test.
- [ ] Verify `/v1/responses/input_tokens` returns `object: "response.input_tokens"`.
- [ ] Verify invalid/missing `model` and invalid/missing `input` return 400.
- [ ] Verify no upstream generation call is made.
- [ ] Verify count is stable for repeated calls.

### Audit Evidence

- [ ] Document that no official Kiro token-count endpoint was found.
- [ ] Document estimator limitations and expected mismatch from real billing/usage.
- [ ] Record exact test command output.

## Phase 3: Add Web Search Helper Or Narrow Endpoint

### Design

- [ ] Prefer an internal provider helper before adding an HTTP endpoint.
- [ ] If an HTTP endpoint is needed, use a Kiro-only narrow route such as `POST /v1/kiro/web_search`.
- [ ] Accept only `{ "query": string }`.
- [ ] Reject blank queries with 400 before any upstream call.
- [ ] Return parsed search results and optional summary; never return auth metadata.
- [ ] Do not expose raw `/mcp`, arbitrary `tools/call`, `tools/list`, or connector management.

### Implementation

- [ ] Add `Kiro_Upstream_Provider.webSearch(query, options?)` delegating to `Kiro_Client.callMcpWebSearch()`.
- [ ] Reuse existing helpers from `src/upstream/kiro/mcp.ts`:
  - [ ] `extractWebSearchQuery`
  - [ ] `parseMcpWebSearchResults`
  - [ ] `webSearchSummary`
  - [ ] `webSearchBlocks`
  - [ ] `maybeHandleKiroServerTool`
- [ ] If adding an endpoint, create a small Kiro-only inbound provider instead of putting raw Kiro-specific routes into generic OpenAI/Claude handlers.
- [ ] Register the endpoint only in Kiro mode.
- [ ] Ensure request/response logging redacts token-like fields and does not include authorization headers.

### Tests

- [ ] Extend `test/upstream/kiro/client.test.ts` for JSON-RPC body shape.
- [ ] Add helper delegation tests in `test/upstream/kiro/index.test.ts`.
- [ ] If endpoint exists, test it is available only in Kiro mode.
- [ ] Test missing/non-string/blank `query` returns 400.
- [ ] Test upstream MCP errors map to safe 502-style responses.
- [ ] Test response does not include `Authorization`, `accessToken`, `refreshToken`, or `profileArn`.

### Audit Evidence

- [ ] Record why generic MCP was not exposed.
- [ ] Record endpoint/helper contract and redaction behavior.
- [ ] Record exact request and response examples with fake data.

## Phase 4: Improve Unsupported Server Tool Errors

### Design

- [ ] Keep blocking generic server-side `mcp` and server-side `web_fetch` by default.
- [ ] Split current generic 400 into precise messages:
  - [ ] `web_fetch`: Kiro upstream does not support server-side web_fetch. Use client WebFetch function tools or web_search URL query.
  - [ ] `mcp`: Kiro upstream does not support generic server-side MCP toolsets. Use normal client function tools or the gateway web_search helper.
- [ ] Do not silently map `web_fetch` to `web_search` unless explicitly approved later.
- [ ] Do not allow generic MCP via env flag without a separate security review.

### Implementation

- [ ] Update `validateUnsupportedServerTools()` in `src/upstream/kiro/index.ts`.
- [ ] Preserve the invariant that unsupported tools return before `generateAssistantResponse`.
- [ ] Ensure error bodies do not include credentials or raw tool authorization tokens.
- [ ] Consider including a documentation URL or short remediation hint in the error body.

### Tests

- [ ] Update `test/upstream/kiro/index.test.ts` for distinct `web_fetch` and `mcp` errors.
- [ ] Add assertions that no upstream generation or MCP call occurs for unsupported tools.
- [ ] Extend property tests if they currently assert the old shared message.
- [ ] Add log/redaction-oriented test if unsupported MCP toolsets can contain authorization values.

### Audit Evidence

- [ ] Record old vs new error bodies.
- [ ] Record tests proving no upstream call is made.
- [ ] Record any known client behavior changes.

## Non-Goals For This Batch

- [ ] Do not implement standalone Kiro `/environments`.
- [ ] Do not expose raw Kiro debug passthrough by default.
- [ ] Do not implement `UpdateUsageLimits` or any write/admin quota API.
- [ ] Do not add generic MCP connector management.
- [ ] Do not claim local token estimates are billing-accurate.
- [ ] Do not implement automatic multi-account failover, circuit breakers, or sticky account rotation unless users report concrete multi-account failures.
- [ ] Do not add proxy/VPN-specific HTTP transport support unless there is concrete connectivity evidence and an explicit config design.
- [ ] Do not add synthetic truncation recovery messages without deterministic truncation detection tests.
- [ ] Do not broaden Kiro MCP support beyond web_search without a separate security and API-shape review.

## Validation Checklist

- [x] Run targeted tests for changed areas first.
  - `bun test test/upstream/kiro` -> `176 pass`, `0 fail`.
  - `bun test test/inbound/claude-edge.test.ts test/upstream/kiro test/runtime.test.ts` -> `268 pass`, `0 fail`.
- [x] Run `bun run typecheck`.
  - `tsc --noEmit && tsc -p tsconfig.test.json --noEmit` -> success.
- [x] Run `bun run build` if `dist/index.js` is expected to be updated.
  - `bun build index.ts --target=bun --outfile=dist/index.js` -> success; `dist/index.js` rebuilt.
- [x] Run full deterministic test suite with `bun run test`.
  - `128 pass`, `1 filtered out`, `0 fail`.
- [x] If LSP is available, run diagnostics on changed TypeScript files.
  - Installed `typescript-language-server` `5.1.3` and `basedpyright`/`basedpyright-langserver` `1.39.3` into the environment.
  - `src` TypeScript diagnostics ran with `0` errors; only one unrelated existing hint was reported in `src/app/runtime.ts`.
  - Changed test files were checked; `test/upstream/kiro/first-token-retry.test.ts` had no diagnostics, while other test files reported LSP-only project-config noise around `bun:test`, implicit mock parameters, and ES2022 `.at(...)`. `bun run typecheck` remains the authoritative test TypeScript check and passed.
- [x] If LSP is unavailable, record the exact missing-server message in the audit notes.
  - Historical pre-install message: `typescript-language-server` command not found for TypeScript files; workspace diagnostics also reported `basedpyright-langserver` command not found.
- [x] Review request logging output for sensitive-data leaks.
  - Debug-on-error tests cover opt-in behavior, preview bounds, and redaction for authorization/token/profile fields, including Claude MCP `mcp_servers[].authorization_token` in debug bundles and persisted request-log details.
- [x] Verify generated/build artifact policy before committing `dist/index.js` changes.
  - `dist/index.js` is already tracked and was rebuilt after source changes.

## Audit Log Template

Use this section when implementing each phase.

```text
Phase:
Date:
Implementer:
Files changed:
API behavior changed:
Backward compatibility notes:
Security/redaction notes:
Tests run:
Test result:
Known limitations:
Follow-up tasks:
```
