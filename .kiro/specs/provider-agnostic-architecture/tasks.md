# Implementation Plan: Provider-Agnostic Architecture

## Overview

Refactor the codex2claudecode proxy server from a monolithic, Claude-centric architecture into a provider-agnostic system with clean separation between inbound API format adapters, upstream LLM connectors, and shared core utilities. The implementation follows the 8-phase migration strategy from the design document, building incrementally from core types through provider implementations to runtime refactoring and backward-compatible re-exports.

## Tasks

- [x] 0. Phase 0 — Pre-refactor baseline
  - [x] 0.1 Capture backward-compat module path baseline
    - **Must be done before any file moves or refactoring begins (before Phase 1)**
    - Scan the current `src/` tree for all `.ts`/`.tsx` files and extract their named exports into `test/backward-compat-baseline.json`
    - The baseline records every importable `src/**` module path and its exported symbol names as they exist in the pre-refactor codebase
    - Commit this file so it is available as a fixed reference throughout the refactoring
    - _Requirements: 12.4, 12.5, 12.6_

- [x] 1. Phase 1 — Core types and interfaces
  - [x] 1.1 Create `src/core/types.ts` with shared type definitions
    - Move `JsonObject`, `RequestOptions`, `RuntimeOptions`, `HealthStatus`, `RequestLogEntry`, `RequestProxyLog`, `SseEvent` from `src/types.ts` into `src/core/types.ts`
    - Keep provider-specific types (OAuth types, Claude types, Codex types) out of core
    - _Requirements: 1.7, 8.1, 8.2_

  - [x] 1.2 Create `src/core/canonical.ts` with canonical request/response types
    - Define `Canonical_Request`, `Canonical_InputMessage`, `Canonical_Response`, `Canonical_ContentBlock` (text, tool_call, server_tool, thinking), `Canonical_Usage`
    - Define `Canonical_StreamResponse` with `AsyncIterable<Canonical_Event>`, `Canonical_Event` union type (text_delta, tool_call_delta, server_tool_block, thinking_delta, thinking_signature, usage, content_block_start/stop, message_start/stop, error, completion, lifecycle, message_item_done)
    - Define `Canonical_ErrorResponse` (status, headers, body)
    - Define `Canonical_PassthroughResponse` (status, statusText, headers, body)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 8.1_

  - [x] 1.3 Create `src/core/interfaces.ts` with provider interfaces
    - Define `UpstreamResult` union type
    - Define `Upstream_Provider` interface with `proxy`, `checkHealth`, optional `usage`, optional `environments`
    - Define `TokenCredentialProvider<T>` optional capability interface
    - Define `Route_Descriptor` with path, method, basePath, headerDiscriminator
    - Define `Inbound_Provider` interface with `name`, `routes()`, `handle()`
    - Define `RequestHandlerContext` interface
    - Define `Credential_Store` interface
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 4.1, 4.2, 4.4, 8.7_

  - [x] 1.4 Move shared utilities into `src/core/`
    - Move SSE parsing utilities (`consumeCodexSse`, `parseSseJson`, `parseJsonObject`, `StreamIdleTimeoutError`) from `src/claude/sse.ts` to `src/core/sse.ts`
    - Move HTTP utilities (`responseHeaders`, `cors`) from `src/http.ts` to `src/core/http.ts`
    - Move path utilities (`appDataDir`, `defaultAuthFile`, `resolveAuthFile`, `expandHome`, `ensureParentDir`) from `src/paths.ts` to `src/core/paths.ts`
    - Move request logging utilities from `src/request-logs.ts` to `src/core/request-logs.ts`
    - Move `normalizeReasoningBody` from `src/reasoning.ts` to `src/core/reasoning.ts`
    - Move generic constants (`LOG_BODY_PREVIEW_LIMIT`, `STREAM_IDLE_TIMEOUT_MS`) from `src/constants.ts` to `src/core/constants.ts`
    - _Requirements: 8.3, 8.4, 8.5, 8.6, 8.8_

  - [x]* 1.5 Write unit tests for canonical type construction
    - Create `test/core/canonical.test.ts`
    - Test construction of each canonical type variant
    - Test that `Canonical_Request` does not contain format-specific fields
    - _Requirements: 1.7_

- [x] 2. Phase 2 — Provider Registry
  - [x] 2.1 Implement `src/core/registry.ts` with `Provider_Registry` class
    - Implement `register(provider)` with conflict detection for same path + method + equivalent discriminators
    - Implement `match(method, pathname, headers)` with specificity-ordered evaluation: exact header > presence header > no discriminator, with registration-order tie-breaking
    - Implement path matching supporting exact paths and parameterized segments (`:model_id`)
    - Implement `listRoutes()` returning all registered routes with provider names
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 9.1, 9.2, 9.3, 9.4_

  - [x]* 2.2 Write property test: Registry matches correct provider (Property 6)
    - **Property 6: Provider_Registry matches the correct provider for any registered route**
    - Generate random non-conflicting route sets + matching requests
    - Verify the registry returns the provider that registered the matching descriptor
    - **Validates: Requirements 4.3, 5.2, 9.2**

  - [x]* 2.3 Write property test: Registry detects conflicting registrations (Property 7)
    - **Property 7: Provider_Registry detects all conflicting route registrations**
    - Generate random pairs of Route_Descriptors with same path/method/discriminators
    - Verify registration throws a conflict error
    - Verify non-conflicting pairs register successfully
    - **Validates: Requirements 5.4, 9.3**

  - [x]* 2.4 Write property test: Registry specificity ordering (Property 8)
    - **Property 8: Provider_Registry specificity ordering**
    - Generate route sets with overlapping paths at different specificity levels
    - Verify exact header match wins over presence, presence wins over none
    - Verify registration-order tie-breaking within same specificity
    - **Validates: Requirements 5.5**

  - [x]* 2.5 Write unit tests for Provider_Registry edge cases
    - Create `test/core/registry.test.ts`
    - Test parameterized path matching (`:model_id`)
    - Test basePath prefix resolution
    - Test conflict error messages identify both providers
    - Test `listRoutes()` output format
    - Test no-match returns undefined
    - _Requirements: 9.2, 9.3, 9.4, 9.5_

- [x] 3. Checkpoint — Core and Registry
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Phase 3 — Codex Upstream Provider
  - [x] 4.1 Create `src/upstream/codex/` directory structure
    - Move `src/auth.ts` → `src/upstream/codex/auth.ts` (OAuth types, JWT parsing, auth file I/O)
    - Move `src/codex-auth.ts` → `src/upstream/codex/codex-auth.ts` (Codex CLI auth syncing)
    - Move `src/account-info.ts` → `src/upstream/codex/account-info.ts`
    - Move `src/connect-account.ts` → `src/upstream/codex/connect-account.ts`
    - Extract Codex-specific constants (`DEFAULT_CLIENT_ID`, `DEFAULT_ISSUER`, `DEFAULT_CODEX_ENDPOINT`, `WHAM_USAGE_ENDPOINT`, `WHAM_ENVIRONMENTS_ENDPOINT`, `REFRESH_SAFETY_MARGIN_MS`) from `src/constants.ts` to `src/upstream/codex/constants.ts`
    - Extract Codex-specific types (`CodexClientOptions`, `CodexClientTokens`, `TokenResponse`, `AuthFileContent`, `AuthFileData`, `CodexClientTokens`) from `src/types.ts` to `src/upstream/codex/` modules
    - _Requirements: 3.3, 3.4, 3.5, 13.3_

  - [x] 4.2 Create `src/upstream/codex/parse.ts` for Codex SSE → canonical parsing
    - Implement parsing of Codex SSE events into `Canonical_Response` (non-streaming)
    - Implement parsing of Codex SSE events into `Canonical_StreamResponse` with `Canonical_Event` async iterable (streaming)
    - Handle all Codex SSE event types and map them to the full `Canonical_Event` union:
      - `response.output_text.delta` → `text_delta`, `response.output_text.done` → `text_done`
      - `response.function_call_arguments.delta` → `tool_call_delta`, `response.function_call_arguments.done` → `tool_call_done`
      - Server tool output items (web search results, MCP tool use/result, citations) → `server_tool_block`
      - Reasoning/thinking output items → `thinking_delta` (with label text) and `thinking_signature`
      - `response.completed` usage data → `usage` event
      - `response.output_item.added` / content part lifecycle → `content_block_start` / `content_block_stop`
      - `response.created` → `message_start`, `response.completed` → `message_stop`
      - `response.output_item.done` → `message_item_done`
      - Upstream error events → `error`
      - `response.completed` → `completion` (with output, usage, stop reason, incomplete reason)
      - Rate limit / informational events → `lifecycle`
    - Map Codex content types to canonical content blocks (text, tool_call, server_tool, thinking) for non-streaming `Canonical_Response` collection
    - _Requirements: 1.5, 3.9, 3.10_

  - [x] 4.3 Implement `src/upstream/codex/client.ts` with refactored client
    - Refactor `CodexStandaloneClient` to use core types and upstream-local types
    - Keep all existing methods: `proxy`, `checkHealth`, `usage`, `environments`, `refresh`, `tokens`, `fromAuthFile`
    - Update imports to reference `src/upstream/codex/auth`, `src/upstream/codex/constants`, `src/core/reasoning`
    - _Requirements: 3.1, 3.2, 3.6, 3.7, 3.12, 3.13_

  - [x] 4.4 Implement `src/upstream/codex/index.ts` with `Codex_Upstream_Provider`
    - Implement `Upstream_Provider` interface and `TokenCredentialProvider<CodexClientTokens>`
    - Implement `proxy(request)`: translate `Canonical_Request` → Codex body, send upstream, return appropriate canonical response type based on passthrough flag and response status
    - Implement `checkHealth`, `usage`, `environments` delegating to the internal client
    - Handle 401 retry logic (refresh tokens, retry once)
    - For passthrough requests: return `Canonical_PassthroughResponse` on success
    - For non-passthrough: parse SSE into `Canonical_Response` or `Canonical_StreamResponse`
    - For errors: return `Canonical_ErrorResponse`
    - _Requirements: 3.1, 3.2, 3.8, 3.9, 3.10, 3.11_

  - [x]* 4.5 Write property test: Upstream translation produces correct Codex body (Property 3)
    - **Property 3: Upstream translation produces structurally correct Codex body**
    - Generate random `Canonical_Request` objects
    - Verify translated body contains: model (reasoning suffix stripped), input array with same message count, `store: false`, matching stream flag, matching tool count
    - **Validates: Requirements 1.9, 3.8**

  - [x]* 4.6 Write property test: Codex SSE parsing produces valid Canonical_Response (Property 5)
    - **Property 5: Codex SSE event sequence produces valid Canonical_Response**
    - Generate random valid SSE event sequences with `response.completed` events
    - Verify usage tokens match, text content captured, function calls captured with correct IDs
    - **Validates: Requirements 3.9**

  - [x]* 4.7 Write unit tests for Codex upstream provider
    - Create `test/upstream/codex.test.ts`
    - Test `Canonical_Request` → Codex body translation with concrete examples
    - Test 401 retry behavior
    - Test passthrough response wrapping
    - Test error response wrapping
    - Test SSE stream parsing with known event sequences
    - _Requirements: 3.7, 3.8, 3.9, 3.10, 3.11_

- [x] 5. Checkpoint — Upstream Provider
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Phase 4 — Claude Inbound Provider
  - [x] 6.1 Create `src/inbound/claude/` directory structure
    - Move `src/claude/convert.ts` → `src/inbound/claude/convert.ts` (refactor to translate Claude → `Canonical_Request` instead of directly to Codex format)
    - Move `src/claude/response.ts` → `src/inbound/claude/response.ts` (refactor to translate `Canonical_Response`/`Canonical_StreamResponse` → Claude format)
    - Move `src/claude/errors.ts` → `src/inbound/claude/errors.ts`
    - Move `src/claude/handlers.ts` → `src/inbound/claude/handlers.ts`
    - Move `src/claude/server-tools.ts` → `src/inbound/claude/server-tools.ts`
    - Move `src/claude/server-tool-adapter.ts` → `src/inbound/claude/server-tool-adapter.ts`
    - Move `src/claude/web.ts` → `src/inbound/claude/web.ts`
    - Move `src/claude/mcp.ts` → `src/inbound/claude/mcp.ts`
    - _Requirements: 6.1, 6.2, 13.2_

  - [x] 6.2 Implement Claude → Canonical_Request translation in `src/inbound/claude/convert.ts`
    - Refactor `claudeToResponsesBody` to produce `Canonical_Request` with `passthrough: false`
    - Map Claude `model`, `system`, `messages`, `tools`, `tool_choice`, `stream`, `output_config` to canonical fields
    - Preserve server tool resolution (web, MCP) in canonical tools/metadata
    - _Requirements: 1.8, 6.3_

  - [x] 6.3 Implement Canonical_Response → Claude format translation in `src/inbound/claude/response.ts`
    - Refactor `collectClaudeMessage` to accept `Canonical_Response` and produce Claude Messages API JSON
    - Refactor `claudeStreamResponse` to consume `Canonical_StreamResponse` events and emit Claude SSE events
    - Map canonical content blocks to Claude content types (text→text, tool_call→tool_use, server_tool→server_tool_use/web_search_tool_result/mcp_tool_use/mcp_tool_result, thinking→thinking)
    - Map canonical usage to Claude usage format
    - _Requirements: 6.4_

  - [x] 6.4 Create `src/inbound/claude/models.ts` with `Model_Catalog`
    - Implement `Model_Catalog` class with `getModel`, `listModels`, `resolveAlias`
    - Accept injectable model resolver function for active model filtering
    - Implement `claudeSettingsModelResolver()` that reads `~/.claude/settings.json`
    - Support pagination (afterId, beforeId, limit)
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 6.5 Implement `src/inbound/claude/index.ts` with `Claude_Inbound_Provider`
    - Implement `Inbound_Provider` interface
    - Register routes: POST `/v1/messages`, POST `/v1/message`, POST `/v1/messages/count_tokens`, GET `/v1/models`, GET `/v1/models/:model_id`
    - Dispatch to appropriate handler based on matched route
    - Inject `claudeSettingsModelResolver` into `Model_Catalog`
    - _Requirements: 6.1, 6.2, 6.5, 6.6, 6.7_

  - [x]* 6.6 Write property test: Inbound translation produces valid Canonical_Request (Property 2 — Claude half)
    - **Property 2 (Claude): Inbound translation produces valid Canonical_Request**
    - Generate random Claude Messages API request bodies
    - Verify: model matches, input message count matches, passthrough is `false`, tools preserved
    - **Validates: Requirements 1.8, 6.3**

  - [x]* 6.7 Write property test: Canonical_Response to Claude format preserves content (Property 4)
    - **Property 4: Canonical_Response to Claude format preserves content**
    - Generate random `Canonical_Response` with varying content block types
    - Verify: id starts with `msg_`, model matches, content block count preserved, usage matches
    - **Validates: Requirements 6.4**

  - [x]* 6.8 Write unit tests for Claude inbound provider
    - Create `test/inbound/claude.test.ts`
    - Test Claude → Canonical_Request with concrete request examples
    - Test Canonical_Response → Claude JSON with concrete response examples
    - Test streaming event translation
    - Test error formatting in Claude error format
    - Test model catalog with and without resolver
    - _Requirements: 6.3, 6.4, 6.5, 6.7_

- [x] 7. Phase 5 — OpenAI Inbound Provider
  - [x] 7.1 Create `src/inbound/openai/normalize.ts`
    - Move `normalizeRequestBody` from `src/reasoning.ts` to `src/inbound/openai/normalize.ts`
    - Refactor to produce `Canonical_Request` with `passthrough: true`
    - Handle `/v1/responses` and `/v1/chat/completions` input normalization
    - _Requirements: 7.3, 8.9_

  - [x] 7.2 Implement `src/inbound/openai/index.ts` with `OpenAI_Inbound_Provider`
    - Implement `Inbound_Provider` interface
    - Register routes: POST `/v1/responses`, POST `/v1/chat/completions`
    - Parse JSON body, call `normalizeRequestBody`, call `upstream.proxy`
    - Forward `Canonical_PassthroughResponse` body + headers on success
    - Forward `Canonical_ErrorResponse` status + body on error
    - Return 500 on invalid JSON
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [x]* 7.3 Write property test: OpenAI inbound translation produces valid Canonical_Request (Property 2 — OpenAI half)
    - **Property 2 (OpenAI): Inbound translation produces valid Canonical_Request**
    - Generate random OpenAI Responses API and Chat Completions API request bodies
    - Verify: model matches, input message count matches, passthrough is `true`, tools preserved
    - **Validates: Requirements 1.8, 7.3**

  - [x]* 7.4 Write unit tests for OpenAI inbound provider
    - Create `test/inbound/openai.test.ts`
    - Test request normalization for `/v1/responses` and `/v1/chat/completions`
    - Test passthrough response forwarding
    - Test error response forwarding
    - Test invalid JSON handling
    - _Requirements: 7.3, 7.5, 7.6, 7.7_

- [x] 8. Checkpoint — Inbound Providers
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Phase 6 — Runtime refactoring
  - [x] 9.1 Create `src/bootstrap.ts` composition root
    - Import concrete provider implementations: `Claude_Inbound_Provider`, `OpenAI_Inbound_Provider`, `Codex_Upstream_Provider`
    - Create `Codex_Upstream_Provider` from auth file
    - Create and register `Claude_Inbound_Provider` and `OpenAI_Inbound_Provider` with `Provider_Registry`
    - Export a bootstrap function called internally by `startRuntime`
    - _Requirements: 11.1, 11.2, 13.4_

  - [x] 9.2 Refactor `src/runtime.ts` to use registry + upstream interface
    - Remove all direct imports of Claude, OpenAI, and Codex modules
    - Call bootstrap internally to get registry + upstream
    - Route API requests through `Provider_Registry.match()` → `Inbound_Provider.handle()`
    - Keep infrastructure routes handled directly: `/`, `/health`, `/test-connection`, OPTIONS
    - Delegate `/usage`, `/wham/usage`, `/environments`, `/wham/environments` to `upstream.usage()` / `upstream.environments()` with 501 fallback
    - Return 404 for unmatched routes, 405 for wrong method on known routes
    - Maintain all existing request logging, health monitoring, CORS, port fallback behavior
    - Preserve `startRuntime(options?: RuntimeOptions)` public signature unchanged
    - Log registered provider routes at startup
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 9.5, 9.6_

  - [x]* 9.3 Write unit tests for runtime with registry
    - Update `test/runtime.test.ts` if needed to verify registry-based routing
    - Test 404 for unmatched routes
    - Test 405 for wrong method
    - Test 501 for unimplemented upstream methods
    - Test infrastructure routes still work
    - _Requirements: 9.5, 9.6, 11.4, 11.6_

- [x] 10. Phase 7 — Re-export shims for backward compatibility
  - [x] 10.1 Create re-export shims for root-level modules
    - `src/types.ts` → re-export from `src/core/types` + Codex-specific types from `src/upstream/codex/`
    - `src/auth.ts` → re-export from `src/upstream/codex/auth`
    - `src/client.ts` → re-export `CodexStandaloneClient` from `src/upstream/codex/client`
    - `src/http.ts` → re-export from `src/core/http`
    - `src/paths.ts` → re-export from `src/core/paths`
    - `src/constants.ts` → re-export from `src/core/constants` + `src/upstream/codex/constants`
    - `src/request-logs.ts` → re-export from `src/core/request-logs`
    - `src/reasoning.ts` → re-export `normalizeReasoningBody` from `src/core/reasoning` + `normalizeRequestBody` from `src/inbound/openai/normalize`
    - `src/account-info.ts` → re-export from `src/upstream/codex/account-info`
    - `src/codex-auth.ts` → re-export from `src/upstream/codex/codex-auth`
    - `src/connect-account.ts` → re-export from `src/upstream/codex/connect-account`
    - `src/models.ts` → re-export from `src/inbound/claude/models`
    - `src/claude-code-env.config.ts` → re-export (update imports to `src/inbound/claude/models`)
    - _Requirements: 12.4, 12.5, 12.6, 13.5_

  - [x] 10.2 Create re-export shims for `src/claude/` directory
    - `src/claude/index.ts` → re-export from `src/inbound/claude/index`
    - `src/claude/convert.ts` → re-export from `src/inbound/claude/convert`
    - `src/claude/errors.ts` → re-export from `src/inbound/claude/errors`
    - `src/claude/handlers.ts` → re-export from `src/inbound/claude/handlers`
    - `src/claude/response.ts` → re-export from `src/inbound/claude/response`
    - `src/claude/sse.ts` → re-export from `src/core/sse`
    - `src/claude/web.ts` → re-export from `src/inbound/claude/web`
    - `src/claude/server-tools.ts` → re-export from `src/inbound/claude/server-tools`
    - `src/claude/server-tool-adapter.ts` → re-export from `src/inbound/claude/server-tool-adapter`
    - `src/claude/mcp.ts` → re-export from `src/inbound/claude/mcp`
    - `src/claude.ts` → re-export `handleClaudeMessages`, `handleClaudeCountTokens`
    - _Requirements: 12.3, 12.4, 12.6_

  - [x] 10.3 Verify `src/index.ts` public API barrel remains unchanged
    - Ensure `CodexStandaloneClient`, `startRuntime`, `runExample`, and all type exports are still exported
    - Update internal import paths if needed but keep the same public surface
    - _Requirements: 12.2_

  - [x] 10.4 Write property test: All src/** module paths remain importable (Property 9)
    - **Property 9: All src/** module paths remain importable**
    - Load the baseline from `test/backward-compat-baseline.json` (captured in task 0.1 before refactoring)
    - For each path in the baseline, verify it is importable and exports at least the same symbol names
    - **Validates: Requirements 12.2, 12.4, 12.5, 12.6, 13.5**

  - [x]* 10.5 Write unit tests for backward compatibility
    - Create `test/backward-compat.test.ts`
    - Test specific import paths from Requirement 12.4 resolve correctly
    - Test that re-exported symbols match original exports
    - _Requirements: 12.4, 12.5, 12.6_

- [x] 11. Checkpoint — Re-exports and Backward Compatibility
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Phase 8 — Verification and round-trip property
  - [x]* 12.1 Write property test: Canonical_Request round-trip equivalence (Property 1)
    - **Property 1: Canonical_Request round-trip structural equivalence**
    - Generate random `Canonical_Request` objects
    - Translate to Codex Responses API format, then parse back
    - Verify model, instructions, message count, and tool count are preserved
    - **Validates: Requirements 1.10**

  - [x] 12.2 Run full stable test suite and verify all tests pass
    - Run `bun run test` (uses the package.json `test` script which excludes `live.test.ts` via `--test-name-pattern`)
    - This covers all existing `test/*.test.ts` files excluding the live Codex smoke test
    - Confirm zero failures; verify no existing test assertions were modified
    - _Requirements: 12.1_

  - [x] 12.3 Run new test suites (core, inbound, upstream, backward-compat)
    - Run `bun test test/core/ test/inbound/ test/upstream/ test/backward-compat.test.ts` to cover all newly created tests
    - Confirm zero failures across all new test files
    - _Requirements: 12.1_

  - [x]* 12.4 Run live smoke test (requires Codex credentials)
    - Run `bun run test:live` (requires `CODEX_AUTH_FILE` and network access to Codex API)
    - This is optional and only verifiable when credentials and upstream are available
    - _Requirements: 12.1_

  - [x] 12.5 Verify no provider-specific imports in runtime
    - Confirm `src/runtime.ts` has no imports from `src/inbound/`, `src/upstream/`, or `src/claude/`
    - Confirm only `src/bootstrap.ts` imports concrete provider implementations
    - _Requirements: 11.9, 13.1_

- [x] 13. Final checkpoint — Full verification
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation after each major phase
- Property tests validate universal correctness properties from the design document using fast-check with minimum 100 iterations
- Unit tests validate specific examples, edge cases, and error conditions
- The project uses `bun` as runtime and test runner — use `bun run test` for the stable suite (excludes `live.test.ts`), and `bun test test/core/ test/inbound/ test/upstream/` for new test subdirectories. Avoid bare `bun test` which would pick up `live.test.ts` and require Codex credentials.
- Re-export shims ensure all existing `src/**` import paths continue to work after refactoring
