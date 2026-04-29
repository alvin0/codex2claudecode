# Claude Messages Response Optimization Todo

Created from the `/v1/messages` response-handling research pass on 2026-04-29. Use this as the implementation checklist for optimizing Claude-compatible response processing in this repository.

## Research Sources

- Current implementation:
  - `src/inbound/claude/index.ts`
  - `src/inbound/claude/response.ts`
  - `src/inbound/claude/codex-response.ts`
  - `src/inbound/claude/handlers.ts`
  - `src/core/canonical.ts`
  - `src/core/sse.ts`
  - `src/core/usage.ts`
  - `src/upstream/codex/parse.ts`
  - `src/upstream/kiro/parse.ts`
  - `src/upstream/kiro/stream-retry.ts`
- Reference implementation:
  - `.temp/free-claude-code/api/routes.py`
  - `.temp/free-claude-code/api/services.py`
  - `.temp/free-claude-code/core/anthropic/sse.py`
  - `.temp/free-claude-code/core/anthropic/emitted_sse_tracker.py`
  - `.temp/free-claude-code/providers/anthropic_messages.py`
  - `.temp/free-claude-code/messaging/event_parser.py`
  - `.temp/free-claude-code/messaging/transcript.py`
  - `.temp/free-claude-code/messaging/node_event_pipeline.py`
  - `.temp/free-claude-code/messaging/ui_updates.py`
- External references:
  - Anthropic Messages streaming contract and error model.
  - `anthropic-sdk-typescript` `MessageStream`/`BetaMessageStream` accumulation patterns.
  - Open-source gateway patterns for Anthropic SSE assembly and tool input buffering.

## Ground Rules

- [ ] Preserve existing `/v1/messages`, `/v1/message`, `/v1/messages/count_tokens`, `/v1/responses`, and `/v1/chat/completions` compatibility.
- [ ] Keep `claudeCanonicalStreamResponse(...)` as the primary Claude wire contract unless a replacement is introduced behind equivalent tests.
- [ ] Treat Anthropic streaming as event-sourced message assembly, not as raw text chunks.
- [ ] Keep `input_json_delta.partial_json` as streaming-only data; parse final tool input only after the content block is complete.
- [ ] Treat `message_delta.usage` and provider usage snapshots as cumulative unless a provider explicitly documents incremental counts.
- [ ] Preserve safe diagnostics: do not log raw prompts, tool arguments, credentials, request bodies, or response bodies unless an explicit debug flag is enabled.
- [ ] Do not copy implementation from `.temp/free-claude-code`; port only design ideas into this TypeScript architecture.

## Current Architecture Summary

The current TypeScript flow is already partly canonicalized:

1. `Claude_Inbound_Provider.handle(...)` receives Claude `/v1/messages` requests.
2. `claudeToCanonicalRequest(...)` converts Claude request bodies into the internal canonical request shape.
3. Upstream providers return `canonical_response`, `canonical_stream`, `canonical_error`, or passthrough results.
4. `claudeCanonicalStreamResponse(...)` converts canonical streams back into Claude SSE wire events.
5. Kiro and Codex have separate parser paths that normalize their upstream event formats into canonical events or direct Claude wire events.

The main optimization opportunity is not basic feature support. The system already handles text, thinking, tool use, server tools, usage, Kiro first-token retry, cancellation, and stream errors. The opportunity is to reduce duplicated response-state logic and make event assembly more robust.

## Key Findings

- [ ] `src/inbound/claude/response.ts` is the best central renderer for Claude SSE wire events.
- [ ] `src/inbound/claude/codex-response.ts` still contains a second direct Codex-to-Claude renderer, duplicating thinking/text/tool/usage lifecycle logic.
- [ ] `src/upstream/codex/parse.ts` and `src/upstream/kiro/parse.ts` both contain provider-specific event accumulation, content-block ordering, usage merging, and tool-call handling.
- [ ] `src/upstream/kiro/parse.ts` uses manual JSON start/end detection for AWS-style event payloads; this is practical but brittle under format drift and malformed chunks.
- [ ] `.temp/free-claude-code/core/anthropic/sse.py` shows a useful separation: one SSE builder owns block indices, open/close behavior, tool-state buffering, and usage emission.
- [ ] `.temp/free-claude-code/core/anthropic/emitted_sse_tracker.py` shows a useful mid-stream error recovery pattern: track emitted block starts/stops so errors can close dangling blocks before emitting a tail.
- [ ] `.temp/free-claude-code/messaging` is not the HTTP `/v1/messages` implementation, but it has a strong event-normalization pipeline: parse raw events once, apply them to a stateful buffer, then render through a separate consumer.

## Priority Order

- [ ] P0: Add a canonical stream accumulator and contract tests for Anthropic event assembly.
- [ ] P0: Route direct Codex `/v1/messages` streaming through canonical events before Claude wire rendering.
- [ ] P1: Add a reusable Claude SSE block writer/tracker to centralize block state, mid-stream errors, and tool input deltas.
- [ ] P1: Harden Kiro event framing and malformed-buffer diagnostics.
- [ ] P1: Centralize tool-call/server-tool lifecycle coordination.
- [ ] P2: Introduce provider-specific usage/token estimator interfaces.
- [ ] P2: Add stream telemetry for first-token delay, idle timeout, usage source, tool count, and stream cancellation.

## Phase A: Canonical Stream Accumulator

`STATUS: TODO`

### Goal

- [ ] Build one internal accumulator that can consume `Canonical_Event` and produce a final `Canonical_Response`-like snapshot.
- [ ] Use the accumulator as the reference model for both streaming and non-streaming behavior.
- [ ] Make content block order, thinking signatures, tool input, server-tool blocks, stop reason, and usage deterministic.

### Target Files And Symbols

- [ ] Add `src/core/canonical-accumulator.ts` or equivalent.
- [ ] Reuse `Canonical_Event`, `Canonical_Response`, `Canonical_ContentBlock`, and `Canonical_Usage` from `src/core/canonical.ts`.
- [ ] Use `mergeCanonicalUsage(...)` from `src/core/usage.ts`.
- [ ] Add tests under `test/core/` or `test/inbound/claude-*`.

### Implementation Checklist

- [ ] Track open text blocks by stream position and close them on text/tool/thinking transitions.
- [ ] Track open thinking blocks and attach `thinking_signature` before finalizing a thinking block.
- [ ] Track tool calls by `callId`; accumulate streamed argument fragments separately from completed arguments.
- [ ] Track server-tool blocks in content order.
- [ ] Treat `usage` and `completion.usage` snapshots as replacement/merge snapshots, not increments.
- [ ] Preserve `message_stop.stopReason` and `completion.stopReason`, with `tool_use` winning when final content includes client tool calls.
- [ ] Tolerate unknown canonical event types by ignoring them, not throwing.

### Tests

- [ ] Text-only stream: deltas accumulate into one text block.
- [ ] Thinking then text: thinking block closes before text starts and includes signature.
- [ ] Tool call after text: text closes, tool call is appended, stop reason becomes `tool_use`.
- [ ] Server tool use/result before answer text preserves block order.
- [ ] Usage events before and after completion produce the latest cumulative usage snapshot.
- [ ] Error event finalizes state safely without inventing successful content.

## Phase B: Direct Codex Stream Consolidation

`STATUS: TODO`

### Goal

- [ ] Remove the second direct Codex-to-Claude stream renderer path where possible.
- [ ] Prefer: Codex Responses SSE -> canonical events -> `claudeCanonicalStreamResponse(...)`.
- [ ] Keep existing Claude Code visible behavior unchanged.

### Target Files And Symbols

- [ ] Review `src/inbound/claude/handlers.ts` `handleClaudeMessages(...)`.
- [ ] Review `src/inbound/claude/codex-response.ts` `claudeStreamResponse(...)` and `collectClaudeMessage(...)`.
- [ ] Review `src/upstream/codex/parse.ts` canonical event generation.
- [ ] Review `src/inbound/claude/codex.ts` adapter wiring.

### Implementation Checklist

- [ ] Identify which runtime path still calls `claudeStreamResponse(...)` directly.
- [ ] Add or expose a Codex parser helper that returns `Canonical_StreamResponse` from raw Responses SSE.
- [ ] Update direct Codex handler path to call `claudeCanonicalStreamResponse(...)`.
- [ ] Keep non-streaming behavior by accumulating canonical events into a final Claude message.
- [ ] Preserve current synthetic thinking lifecycle labels used to keep Claude Code streams alive.
- [ ] Preserve stream cancellation behavior: downstream client cancel must abort upstream body reading.
- [ ] Remove duplicated direct SSE writer code only after behavior is covered by tests.

### Tests

- [ ] Existing `test/claude.test.ts` cases for `claudeStreamResponse(...)` still pass through the new path or are replaced with equivalent canonical-stream tests.
- [ ] Existing lifecycle-label tests from `test/inbound/claude-edge.test.ts` still pass.
- [ ] Direct Codex function-call arguments still emit `tool_use` with `input_json_delta` and `stop_reason: tool_use`.
- [ ] Direct Codex web/MCP/server-tool output keeps current block order.
- [ ] Stream error inside upstream 200 still emits Claude `event: error` safely.

## Phase C: Claude SSE Block Writer And Emitted-State Tracker

`STATUS: TODO`

### Goal

- [ ] Encapsulate Claude SSE event formatting, content block index allocation, open block tracking, and mid-stream error recovery.
- [ ] Make stream output valid even when an upstream exception occurs after content blocks have started.

### Target Files And Symbols

- [ ] Add `src/inbound/claude/sse-writer.ts` or equivalent.
- [ ] Refactor `claudeCanonicalStreamResponse(...)` in `src/inbound/claude/response.ts` to use it.
- [ ] Reuse `claudeStreamErrorEvent(...)` from `src/inbound/claude/errors.ts` or replace it with typed writer methods.

### Implementation Checklist

- [ ] Provide `messageStart(...)`, `contentBlockStart(...)`, `contentBlockDelta(...)`, `contentBlockStop(...)`, `messageDelta(...)`, `messageStop(...)`, `ping(...)`, and `error(...)` helpers.
- [ ] Track open block indices in a stack or set.
- [ ] Provide `closeOpenBlocks()` for exception and cancellation paths.
- [ ] Provide `nextContentIndex()` to avoid index collisions after mid-stream errors.
- [ ] Support top-level `event: error` and optional assistant text error block without mixing the two accidentally.
- [ ] Add `X-Accel-Buffering: no`, `Cache-Control: no-cache`, and `Connection: keep-alive` if compatible with Bun response behavior.
- [ ] Avoid raw event logging by default; if logging is enabled, log event type and serialized byte length.

### Tests

- [ ] Error after an open thinking block closes the block before terminal event/error tail.
- [ ] Error after an open text block closes the block before terminal event/error tail.
- [ ] Error after a server tool block does not reuse an already emitted index.
- [ ] Unknown canonical events do not break SSE framing.
- [ ] Writer emits exact `event: <type>\ndata: <json>\n\n` framing.

## Phase D: Kiro Event Framing Hardening

`STATUS: TODO`

### Goal

- [ ] Reduce silent data loss and brittleness in Kiro event parsing.
- [ ] Preserve current working heuristics unless a safer framed parser is proven by tests.

### Target Files And Symbols

- [ ] `src/upstream/kiro/parse.ts` `AwsEventStreamParser`.
- [ ] `findEventStart(...)`, `findJsonEnd(...)`, `MAX_PENDING_EVENT_CHARS`, and `STREAM_NO_EVENT_KEEP_CHARS`.
- [ ] Existing tests in `test/upstream/kiro/parse.test.ts` and `test/upstream/kiro/sse-compat.test.ts`.

### Implementation Checklist

- [ ] Add explicit parser telemetry fields: skipped malformed events, oversized buffer trims, duplicate content skips.
- [ ] Include safe diagnostics with lengths and hashes only, not raw prompt/output content.
- [ ] Add a parser option to expose diagnostics to request logs in debug mode.
- [ ] Audit whether upstream framing has a reliable delimiter or AWS event-stream structure that can replace substring scanning.
- [ ] If no reliable delimiter exists, make the current brace-depth scanner stricter around known top-level event shapes.
- [ ] Ensure nested JSON strings containing `{"content":`, `{"name":`, or `{"usage":` do not reset parser state incorrectly.

### Tests

- [ ] Chunk split in the middle of a JSON string.
- [ ] Nested JSON in tool input containing strings that look like top-level event starts.
- [ ] Malformed event followed by valid event recovers without dropping the valid event.
- [ ] Oversized pending buffer logs safe metadata and continues parsing later valid events.
- [ ] Duplicate content suppression does not drop intentional repeated model output in separate semantic events.

## Phase E: Tool-Call And Server-Tool Coordinator

`STATUS: TODO`

### Goal

- [ ] Move pending server calls, deferred text, streamed tool arguments, and tool-result ordering into one reusable coordinator.
- [ ] Make Codex and Kiro tool behavior consistent.

### Target Files And Symbols

- [ ] Add `src/core/tool-call-coordinator.ts` or provider-neutral equivalent.
- [ ] Refactor `pendingServerCalls` and `deferredText` in `src/inbound/claude/codex-response.ts`.
- [ ] Refactor `emitToolCall(...)`, `emittedToolCalls`, and bracket-call extraction flow in `src/upstream/kiro/parse.ts` if practical.
- [ ] Keep server-tool adapters in `src/inbound/claude/server-tool-adapter.ts` and `src/inbound/claude/web.ts` provider-neutral.

### Implementation Checklist

- [ ] Track `tool_use_id -> tool name` for tool result mapping.
- [ ] Accumulate `input_json_delta` fragments per block/tool index and parse only when complete.
- [ ] Represent tool execution failure as `tool_result` with `is_error: true` where supported.
- [ ] Preserve ordering when tool use/result and answer text interleave.
- [ ] Support server tools (`server_tool_use`, `web_search_tool_result`, `web_fetch_tool_result`, `mcp_tool_use`, `mcp_tool_result`) without hardcoding web-only behavior in the core stream renderer.
- [ ] Tolerate missing, duplicate, or provider-mutated tool IDs with safe fallback IDs and diagnostics.

### Tests

- [ ] Fragmented client tool input across multiple deltas.
- [ ] Tool result before final text.
- [ ] Tool use with malformed JSON arguments falls back to `{}` and logs safe diagnostics.
- [ ] Server tool result with deferred assistant text keeps result before answer text.
- [ ] MCP tool use/result increments `server_tool_use.mcp_calls` exactly once.

## Phase F: Usage And Token Estimator Strategy

`STATUS: TODO`

### Goal

- [ ] Make usage accounting explicit about source and accuracy.
- [ ] Avoid scattered fallback estimators and accidental double counting.

### Target Files And Symbols

- [ ] `src/core/usage.ts`
- [ ] `src/inbound/claude/convert.ts` `countClaudeInputTokens(...)`
- [ ] `src/upstream/kiro/parse.ts` `estimateKiroFallbackTokens(...)` and `estimateInputTokens(...)`
- [ ] `src/upstream/codex/parse.ts` usage update helpers.

### Implementation Checklist

- [ ] Add a provider-neutral `UsageEstimate` or `TokenEstimator` interface.
- [ ] Track usage source: `upstream_exact`, `local_count`, `context_percentage_estimate`, `fallback_tokenizer`, `fallback_bytes`.
- [ ] Keep Anthropic-style input split: `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`.
- [ ] Treat cache-read tokens carefully: OpenAI-style `prompt_tokens` with cached details should not double count cached input.
- [ ] Preserve cumulative output token behavior when merging stream usage snapshots.
- [ ] Emit safe logs when falling back from exact upstream usage to an estimate.

### Tests

- [ ] OpenAI/Codex usage with cached prompt tokens maps to Claude input/cache fields without double counting.
- [ ] Anthropic/Kiro object usage with explicit `input_tokens` and `cache_read_input_tokens` is preserved.
- [ ] Missing upstream usage uses local/fallback estimates and records the expected source.
- [ ] Server tool usage counts use max/merge semantics rather than additive double counting across completion snapshots.

## Phase G: Stream Telemetry And Debuggability

`STATUS: TODO`

### Goal

- [ ] Make production stream problems diagnosable without raw payload logs.
- [ ] Give future optimization work evidence about latency and stream failure modes.

### Target Files And Symbols

- [ ] `src/inbound/claude/index.ts` proxy log hooks.
- [ ] `src/inbound/claude/handlers.ts` direct Codex handler logs.
- [ ] `src/upstream/kiro/stream-retry.ts` first-token retry logging.
- [ ] `src/core/debug-capture.ts` for optional bounded debug bundles.

### Implementation Checklist

- [ ] Log request ID, provider, model, stream/non-stream, duration, first-token latency, and terminal event type.
- [ ] Count emitted text blocks, thinking blocks, client tool calls, server tool calls, and stream errors.
- [ ] Record whether usage was exact or estimated.
- [ ] Record first-token retry attempts and final outcome.
- [ ] Record client cancellation separately from upstream failure.
- [ ] Keep debug bundles bounded and credential-safe.

### Tests

- [ ] Stream cancellation updates proxy log without treating it as upstream failure.
- [ ] First-token timeout logs retry metadata without raw body content.
- [ ] Stream error after partial output records terminal error metadata.
- [ ] Usage fallback records estimate source.

## Suggested Implementation Sequence

1. [ ] Add accumulator tests first, without changing runtime code.
2. [ ] Add `canonical-accumulator.ts` and make tests pass.
3. [ ] Add `sse-writer.ts` behind `claudeCanonicalStreamResponse(...)`, preserving output shape.
4. [ ] Migrate direct Codex streaming to canonical events.
5. [ ] Harden Kiro parser diagnostics and edge cases.
6. [ ] Extract tool coordinator only after Codex and Kiro behavior is fully covered.
7. [ ] Add usage estimator source metadata and telemetry.

## Verification Commands

Run focused tests first, then widen:

```sh
bun test test/inbound/claude-edge.test.ts test/claude.test.ts test/upstream/kiro/sse-compat.test.ts
bun test test/upstream/kiro test/upstream/codex-edge.test.ts
bun run typecheck
bun run check
```

## Residual Risks

- [ ] Claude Code is sensitive to exact SSE order; any renderer refactor must compare event sequences, not just final text.
- [ ] Kiro upstream framing may remain heuristic if no formal delimiter is available.
- [ ] Some synthetic thinking labels are intentionally UX-driven to keep Claude Code alive; removing them may reintroduce apparent hangs.
- [ ] Consolidating direct Codex and canonical paths may temporarily duplicate tests until old direct renderer tests are migrated.
