# Project Optimization Todo

Created from the project-wide architecture, test-risk, and external gateway-pattern research pass on 2026-04-29. Use this as the implementation checklist for optimizing the whole `codex2claudecode` repository beyond the Claude `/v1/messages` response path.

For `/v1/messages` response-specific stream assembly work, keep using `CLAUDE_MESSAGES_RESPONSE_OPTIMIZATION_TODO.md`. This file tracks the broader platform work that should make those changes safer.

## Research Sources

- Current repository architecture:
  - `src/app/runtime.ts`
  - `src/app/bootstrap.ts`
  - `src/app/provider-config.ts`
  - `src/core/interfaces.ts`
  - `src/core/registry.ts`
  - `src/core/request-logs.ts`
  - `src/core/debug-capture.ts`
  - `src/core/log-preview.ts`
  - `src/inbound/claude/*`
  - `src/inbound/openai/*`
  - `src/upstream/codex/*`
  - `src/upstream/kiro/*`
  - `src/ui/*`
- Verification and release surfaces:
  - `package.json`
  - `vitest.config.ts`
  - `.github/workflows/ci.yml`
  - `.github/workflows/publish.yml`
  - `test/helpers.ts`
  - `test/runtime-registry.test.ts`
  - `test/core/*`
  - `test/inbound/*`
  - `test/upstream/*`
  - `test/ui/*`
- Existing roadmaps:
  - `CLAUDE_MESSAGES_RESPONSE_OPTIMIZATION_TODO.md`
  - `KIRO_API_IMPROVEMENTS_TODO.md`
- External patterns reviewed:
  - Vercel AI provider registry and OpenAI-compatible provider docs.
  - LiteLLM proxy/router, redaction, request processing, and spend/usage tracking patterns.
  - OpenAI and Anthropic SDK timeout, retry, streaming, and request-id conventions.
  - `.temp/free-claude-code` response/SSE/event-tracker design ideas.

## Ground Rules

- [ ] Preserve all documented local API endpoints: `/v1/messages`, `/v1/messages/count_tokens`, `/v1/responses`, `/v1/chat/completions`, `/usage`, `/environments`, and `/health`.
- [ ] Keep the canonical request/response layer as the protocol boundary between inbound and upstream providers.
- [ ] Fix verification blind spots before doing broad refactors.
- [ ] Do not copy code from reference repositories; port only design ideas that fit this TypeScript/Bun architecture.
- [ ] Keep raw prompts, tool inputs, response bodies, access tokens, refresh tokens, account IDs, profile ARNs, and authorization headers out of default logs.
- [ ] Treat Kiro token counts and payload estimates as approximate unless a real upstream token-count endpoint is confirmed.
- [ ] Prefer small, behavior-preserving refactors with targeted regression tests over large rewrites.

## Current Architecture Summary

The project is already organized around a good layered gateway model:

1. `src/app/bootstrap.ts` chooses provider mode and wires inbound providers plus one upstream provider.
2. `src/core/registry.ts` routes requests by method, path, and optional header discriminators.
3. Inbound providers convert Claude/OpenAI-compatible wire formats into canonical requests.
4. Upstream providers convert canonical requests into Codex or Kiro requests and return canonical responses, canonical streams, canonical errors, or passthrough responses.
5. `src/app/runtime.ts` owns Bun serving, request matching, CORS, health endpoints, request logs, body previews, upstream proxy wrappers, and provider dispatch.
6. The Ink UI reads provider/runtime state and request logs while sharing provider metadata with the app layer.

The highest-leverage optimizations are not new endpoint support. They are making verification truthful, deduplicating repeated stream/logging mechanics, reducing request-path I/O and body copies, and hardening credential writes.

## Priority Order

- [ ] P0: Make default tests and coverage truthful before changing behavior.
- [ ] P0: Centralize response stream interception and log-preview wrapping.
- [ ] P1: Move request-log persistence behind a bounded background writer.
- [ ] P1: Add atomic credential and detail-file writes.
- [ ] P1: Normalize retry, timeout, usage, and metadata policy across providers.
- [ ] P2: Reduce Kiro payload conversion and token-estimation serialization costs.
- [ ] P2: Separate runtime routing/logging/health/proxy responsibilities into smaller modules.
- [ ] P2: Make provider capability/config policy explicit and hierarchical.
- [ ] P3: Split large UI state/render orchestration only after runtime/core changes stabilize.

## Phase A: Verification Gates And Coverage Truthfulness

`STATUS: TODO`

### Goal

- [ ] Ensure local `bun run test`, CI, and publish verification run the deterministic nested test suites.
- [ ] Make coverage reporting explicit about which source tree it measures.
- [ ] Prevent the README/CI from claiming broad 100% coverage when coverage is scoped narrowly.

### Target Files And Symbols

- [ ] `package.json` `scripts.test`
- [ ] `vitest.config.ts` `test.include` and `test.coverage`
- [ ] `.github/workflows/ci.yml`
- [ ] `.github/workflows/publish.yml`
- [ ] `README.md` development and CI evidence sections
- [ ] Existing test helpers in `test/helpers.ts` and `test/vitest-bun-shim.ts`

### Implementation Checklist

- [ ] Change `bun run test` from `bun test test/*.test.ts ...` to a recursive deterministic pattern that includes nested suites such as `test/core`, `test/inbound`, `test/upstream`, and `test/ui`.
- [ ] Keep `test/live.test.ts` excluded from default deterministic runs.
- [ ] Decide whether default coverage should measure all `src/**/*.ts` or a declared set of subsystems.
- [ ] If coverage remains scoped, rename/report it as scoped coverage instead of project-wide coverage.
- [ ] Add CI evidence that shows nested suites were discovered and run.
- [ ] Update publish workflow if it depends on `bun run test`.
- [ ] Update README test/coverage claims after the real scope is selected.

### Tests And Verification

- [ ] `bun run test` runs nested deterministic tests and excludes only live smoke tests.
- [ ] `bun run coverage` reports the intended source scope.
- [ ] CI and publish workflow commands still match local scripts.
- [ ] No secrets or local auth files are included in evidence artifacts.

## Phase B: Shared Stream Interception And Log Preview

`STATUS: TODO`

### Goal

- [ ] Replace repeated stream-body wrappers with one core utility.
- [ ] Make response preview, chunk decoding, completion callbacks, and cancellation behavior consistent.
- [ ] Reduce future risk before changing canonical stream assembly.

### Target Files And Symbols

- [ ] Add `src/core/stream-utils.ts` or equivalent.
- [ ] Reuse `src/core/log-preview.ts` preview behavior.
- [ ] Replace local wrappers in:
  - `src/app/runtime.ts` `responseWithLoggedBody(...)`
  - `src/inbound/openai/index.ts` `responseWithLoggedBody(...)`
  - `src/upstream/codex/index.ts` `withLoggedResponseBody(...)`
  - `src/upstream/kiro/index.ts` `withLoggedResponseBody(...)`
- [ ] Review `src/inbound/claude/index.ts` `withLoggedCanonicalStream(...)` for possible reuse or explicit separation.

### Implementation Checklist

- [ ] Provide a typed helper that accepts a `Response`, preview limit, optional chunk callback, completion callback, and cancellation/error callback.
- [ ] Preserve response status, status text, and headers exactly unless a caller explicitly changes them.
- [ ] Ensure downstream cancellation cancels or releases the upstream reader best-effort.
- [ ] Ensure callback exceptions do not corrupt the client response stream.
- [ ] Avoid full-body buffering; preview only up to the configured limit.
- [ ] Keep safe metadata logging: event type, byte count, status, and bounded preview only.

### Tests And Verification

- [ ] Add focused tests for chunked bodies, empty bodies, cancellation, callback failure, and non-streaming responses.
- [ ] Re-run existing runtime, inbound OpenAI, upstream Codex, and upstream Kiro tests.
- [ ] Re-run `/v1/messages` response tests before starting `CLAUDE_MESSAGES_RESPONSE_OPTIMIZATION_TODO.md` Phase A/B work.

## Phase C: Request Log Writer And Persistence Boundaries

`STATUS: TODO`

### Goal

- [ ] Keep request logs useful without making disk writes the default hot-path bottleneck.
- [ ] Encapsulate NDJSON recent logs, detail files, retention, and write queues behind one persistence abstraction.

### Target Files And Symbols

- [ ] `src/core/request-logs.ts` `appendRequestLog(...)`, `enqueueWrite(...)`, `readRecentRequestLogs(...)`, `clearRequestLogs(...)`
- [ ] `src/app/runtime.ts` request-log mode handling
- [ ] `src/ui/app.tsx` recent-log read/merge behavior
- [ ] Consider adding `src/core/log-writer.ts`

### Implementation Checklist

- [ ] Keep public request-log read APIs stable for the UI.
- [ ] Move per-auth-file queueing and flush policy behind a small writer object.
- [ ] Add a bounded in-memory queue for async mode and clear overflow behavior.
- [ ] Keep `sync` mode as an explicit awaitable flush, not an accidental default for high-latency disk writes.
- [ ] Keep retention and orphan-detail cleanup behavior.
- [ ] Write detail files atomically to avoid partial JSON on process interruption.
- [ ] Surface safe writer metrics such as queue length, dropped entries, and write latency in debug-only diagnostics.

### Tests And Verification

- [ ] Concurrent appends to the same auth file preserve valid NDJSON.
- [ ] Async mode returns without waiting for disk flush but eventually persists entries.
- [ ] Sync mode waits for flush and propagates or records write failure safely.
- [ ] Detail-file writes are atomic from the reader's perspective.
- [ ] UI log reader still handles recent entries and missing detail files gracefully.

## Phase D: Atomic Credential Writes And Auth Concurrency

`STATUS: TODO`

### Goal

- [ ] Reduce the risk of corrupting or losing auth state when the gateway and upstream CLI/IDE update the same files.
- [ ] Keep credential writes private and recoverable.

### Target Files And Symbols

- [ ] `src/upstream/codex/client.ts` `saveAuthFile(...)`, `syncFromSourceBeforeRefresh(...)`, `refreshAccessToken(...)`
- [ ] `src/upstream/kiro/auth.ts` `writeBackCredentials(...)`, `refreshWithSourceSync(...)`, `refreshUpstreamAndWriteBack(...)`
- [ ] `src/core/bun-fs.ts` write helpers if shared atomic write belongs there

### Implementation Checklist

- [ ] Add a shared atomic JSON write helper using temp-file plus rename.
- [ ] Preserve or explicitly set `0o600` permissions for credential files and temp files.
- [ ] Avoid rewriting unchanged credential files.
- [ ] Add in-process locking per credential path around source sync and write-back.
- [ ] Consider a lightweight lockfile/advisory-lock strategy for cross-process safety if Bun and target platforms support it reliably.
- [ ] Preserve current refresh de-duplication promises.
- [ ] Keep all public errors credential-safe.

### Tests And Verification

- [ ] Atomic write leaves either old or new valid JSON if a simulated write fails.
- [ ] Concurrent refresh calls perform one upstream refresh per provider instance.
- [ ] Source-file updates made before refresh are not overwritten by stale managed state.
- [ ] Credential file mode is private after writes.

## Phase E: Provider Policy For Retries, Timeouts, Usage, And Metadata

`STATUS: TODO`

### Goal

- [ ] Make provider behavior explicit instead of scattered across runtime, inbound, and upstream modules.
- [ ] Align with external gateway patterns: request-scoped retries/timeouts, normalized streaming metadata, and hierarchical redaction policy.

### Target Files And Symbols

- [ ] `src/core/interfaces.ts` `Upstream_Provider`, `RequestHandlerContext`, and `UpstreamResult`
- [ ] `src/app/bootstrap.ts` provider construction
- [ ] `src/app/provider-config.ts` provider mode/config resolution
- [ ] `src/upstream/codex/index.ts` and `src/upstream/codex/client.ts`
- [ ] `src/upstream/kiro/index.ts`, `src/upstream/kiro/client.ts`, and `src/upstream/kiro/constants.ts`
- [ ] `src/core/debug-capture.ts`, `src/core/log-preview.ts`, and redaction helpers

### Implementation Checklist

- [ ] Define provider capability metadata: streaming, passthrough, usage support, environments support, token counting support, model listing, retry policy, timeout policy, and log-body policy.
- [ ] Make request-scoped overrides explicit and validated.
- [ ] Preserve provider-specific metadata separately from normalized canonical output.
- [ ] Keep usage source and accuracy visible: upstream-reported, provider-estimated, local-estimated, or unavailable.
- [ ] Centralize redaction precedence: request override, provider override, global/default policy.
- [ ] Capture request IDs and upstream trace IDs when available without logging sensitive payloads.
- [ ] Keep unsupported endpoints returning clear `501` or provider-specific guidance.

### Tests And Verification

- [ ] Capability metadata matches registered routes and runtime optional endpoint behavior.
- [ ] Retry and timeout overrides do not apply after downstream stream bytes have been emitted unless explicitly safe.
- [ ] Usage metadata survives streaming and non-streaming paths.
- [ ] Redaction precedence is tested for request, provider, and global levels.

## Phase F: Kiro Payload And Token-Estimate Efficiency

`STATUS: TODO`

### Goal

- [ ] Reduce CPU and memory pressure for large Kiro requests.
- [ ] Keep current payload-limit and Claude Code compaction behavior unchanged.

### Target Files And Symbols

- [ ] `src/upstream/kiro/payload.ts` `convertCanonicalToKiroPayload(...)` and trimming helpers
- [ ] `src/upstream/kiro/index.ts` token estimation and preflight logic
- [ ] `test/upstream/kiro/payload.test.ts`
- [ ] `test/upstream/kiro/index.test.ts`
- [ ] `test/upstream/kiro/*.property.test.ts`

### Implementation Checklist

- [ ] Reuse a single `TextEncoder` where practical.
- [ ] Avoid repeated full `JSON.stringify(...)` passes during trimming.
- [ ] Cache conversion results within a single request lifecycle when preflight and generation need the same payload shape.
- [ ] Trim incrementally over message history instead of repeatedly rebuilding unrelated fields.
- [ ] Keep Claude inbound overflow mode as context-error when required for Claude Code compaction.
- [ ] Keep non-Claude overflow mode trimming behavior and warning injection.

### Tests And Verification

- [ ] Existing payload-size and trimming tests continue to pass.
- [ ] Add edge tests for large histories near, at, and over configured byte limits.
- [ ] Add regression tests proving web-search preflight expansion can still trigger the correct context-limit behavior.
- [ ] Measure before/after serialization count or request conversion time with a deterministic large fixture if feasible.

## Phase G: Runtime Module Boundaries

`STATUS: TODO`

### Goal

- [ ] Split `src/app/runtime.ts` after shared stream/logging primitives exist.
- [ ] Keep runtime provider-agnostic and preserve the existing bootstrap composition boundary.

### Target Files And Symbols

- [ ] `src/app/runtime.ts` `startRuntimeWithBootstrap(...)`
- [ ] Consider extracting:
  - `src/app/runtime-router.ts`
  - `src/app/runtime-health.ts`
  - `src/app/runtime-logging.ts`
  - `src/app/runtime-proxy.ts`
- [ ] Preserve tests in `test/runtime-registry.test.ts` and runtime-related suites.

### Implementation Checklist

- [ ] Extract routing helpers without importing concrete inbound or upstream providers into runtime.
- [ ] Extract health endpoint behavior and periodic health checks.
- [ ] Extract request log capture and proxy log update mechanics after Phase C.
- [ ] Extract optional upstream endpoint handling for `/usage` and `/environments`.
- [ ] Keep route matching behavior and Bun idle-timeout disabling exactly covered by tests.

### Tests And Verification

- [ ] Runtime integration tests still prove provider agnosticism.
- [ ] Optional upstream endpoint tests still return `501` when unsupported.
- [ ] Matched `/v1` routes still disable Bun idle timeout before provider handling.
- [ ] Dynamic, prefixed, and static route matching behavior remains unchanged.

## Phase H: UI State And Provider Runtime Cleanup

`STATUS: TODO`

### Goal

- [ ] Keep the Ink UI thin and backed by stable runtime/provider state APIs.
- [ ] Avoid changing UI architecture before runtime/logging contracts stabilize.

### Target Files And Symbols

- [ ] `src/ui/app.tsx`
- [ ] `src/ui/providers/use-provider-runtime.ts`
- [ ] `src/ui/providers/registry.ts`
- [ ] `src/ui/provider-info.ts`
- [ ] `test/ui/*`

### Implementation Checklist

- [ ] Move provider-definition and provider-capability display data behind one UI-facing adapter.
- [ ] Keep log display consuming `request-logs` read APIs rather than parsing persistence details directly.
- [ ] Separate command parsing, runtime actions, and rendering state if `src/ui/app.tsx` continues growing.
- [ ] Keep UI tests focused on provider state, commands, and rendered runtime status.

### Tests And Verification

- [ ] Existing UI tests pass after runtime/logging API changes.
- [ ] Logs view still handles async persistence and missing detail files.
- [ ] Provider switching and `/connect` flows still use the active provider definition.

## External Pattern Notes To Apply Carefully

- [ ] Vercel AI style provider registry: useful for typed provider IDs, fallback providers, and middleware-like wrapping; do not replace the current registry until route-level behavior is fully covered.
- [ ] OpenAI-compatible provider options: useful model for explicit `baseURL`, `headers`, `queryParams`, `fetch`, request transforms, metadata extractors, and usage flags.
- [ ] LiteLLM router policy: useful for request-scoped `num_retries`, `timeout`, `stream_timeout`, hierarchical config overrides, and redaction precedence.
- [ ] SDK retry behavior: use transient retries for connection errors, 408, 409, 429, and 5xx before stream emission; do not blindly retry after downstream bytes are emitted.
- [ ] Request IDs: capture upstream request IDs for debugging while keeping body content redacted by default.

## Suggested Implementation Sequence

1. [ ] Phase A: Fix test discovery and coverage truthfulness.
2. [ ] Phase B: Add shared stream interception utility and replace duplicate wrappers.
3. [ ] Start `CLAUDE_MESSAGES_RESPONSE_OPTIMIZATION_TODO.md` Phase A/B after Phase B is stable.
4. [ ] Phase C: Add bounded async request-log writer and atomic detail writes.
5. [ ] Phase D: Add atomic credential writes and credential-path locking.
6. [ ] Phase E: Add provider capability/policy metadata.
7. [ ] Phase F: Optimize Kiro payload conversion.
8. [ ] Phase G: Split runtime modules.
9. [ ] Phase H: Clean up UI orchestration only after runtime contracts settle.

## Verification Command Checklist

- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run coverage`
- [ ] Targeted suites when touching Kiro streaming or payloads:
  - [ ] `bun test test/upstream/kiro`
  - [ ] `bun test test/upstream/kiro/first-token-retry.test.ts test/upstream/kiro/index.test.ts`
- [ ] Targeted suites when touching routing/runtime/logging:
  - [ ] `bun test test/runtime-registry.test.ts test/request-logs.test.ts test/core/registry.test.ts`
- [ ] Targeted suites when touching Claude/OpenAI response adapters:
  - [ ] `bun test test/inbound/claude.test.ts test/inbound/claude-edge.test.ts test/inbound/openai.test.ts test/inbound/openai-edge.test.ts`
