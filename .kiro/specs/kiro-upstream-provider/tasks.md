# Implementation Plan: Kiro Upstream Provider

## Overview

Implement a new upstream provider at `src/upstream/kiro/` that routes requests through the Kiro API (Amazon Q Developer). The provider follows the existing Codex upstream provider pattern with 7 files (constants, types, auth, client, payload, parse, index) plus bootstrap integration. Each task builds incrementally — foundational types and constants first, then auth, client, payload conversion, response parsing, provider orchestration, and finally bootstrap wiring. Tests are co-located with each implementation step.

## Tasks

- [ ] 1. Create constants and types foundation
  - [ ] 1.1 Create `src/upstream/kiro/constants.ts` with all provider constants
    - Auth endpoints (`KIRO_AUTH_TOKEN_PATH`, `KIRO_DESKTOP_REFRESH_TEMPLATE`, `SSO_OIDC_ENDPOINT_TEMPLATE`)
    - API endpoints (`KIRO_API_HOST_TEMPLATE`, `GENERATE_ASSISTANT_RESPONSE_PATH`, `LIST_AVAILABLE_MODELS_PATH`)
    - Timeouts and thresholds (`TOKEN_REFRESH_THRESHOLD_SECONDS`, `STREAMING_READ_TIMEOUT_MS`, `MAX_RETRIES`, `BASE_RETRY_DELAY_MS`, `PAYLOAD_SIZE_LIMIT_BYTES`, `TOOL_DESCRIPTION_MAX_LENGTH`, `TOOL_NAME_MAX_LENGTH`, `MODEL_CACHE_TTL_SECONDS`, `DEFAULT_MAX_INPUT_TOKENS`)
    - Thinking tag budgets (`REASONING_EFFORT_BUDGETS`)
    - Header templates (`USER_AGENT_TEMPLATE`, `X_AMZ_USER_AGENT_TEMPLATE`)
    - App state (`KIRO_STATE_FILE_NAME`)
    - _Requirements: R4.4, R4.5, R4.9, R5.6, R6.19, R6.21a, R6.10, R6.22, R13.3, R14.4_

  - [ ] 1.2 Create `src/upstream/kiro/types.ts` with all Kiro-specific TypeScript types
    - Auth types: `KiroAuthType`, `KiroAuthTokenFile`, `KiroDeviceRegistrationFile`, `KiroRefreshResponse`, `SsoOidcRefreshResponse`
    - Payload types: `KiroConversationState`, `KiroCurrentMessage`, `KiroUserInputMessage`, `KiroUserInputMessageContext`, `KiroAssistantResponseMessage`, `KiroHistoryEntry`, `KiroToolSpecification`, `KiroToolUse`, `KiroToolResult`, `KiroImage`, `KiroGeneratePayload`
    - Parser types: `KiroContentEvent`, `KiroToolStartEvent`, `KiroToolInputEvent`, `KiroToolStopEvent`, `KiroUsageEvent`, `KiroContextUsageEvent`
    - Error types: `ToolNameTooLongError`, `PayloadTooLargeError`, `KiroHttpError`, `KiroNetworkError`
    - _Requirements: R1.3, R3.1, R3.2, R5.5, R6.1, R6.4, R6.5, R6.6, R6.8, R7.2-R7.6, R18.1, R18.2_

- [ ] 2. Implement auth module
  - [ ] 2.1 Create `src/upstream/kiro/auth.ts` with `Kiro_Auth_Manager` class
    - `static async fromAuthFile(path?, options?)` — read and parse Auth_Token_File, handle missing/invalid JSON
    - Device_Registration_File reading via `clientIdHash` — handle missing/corrupt companion files gracefully (invalid JSON, missing fields, permission errors → log warning, proceed without OIDC)
    - Auth type detection: `aws_sso_oidc` when `clientId` + `clientSecret` available (direct Auth_Token_File overrides Device_Registration_File), `kiro_desktop` otherwise
    - `getAccessToken()` — proactive refresh when expiring soon
    - `isTokenExpiringSoon()` — within 600s of `expiresAt`
    - `isTokenExpired()` — past `expiresAt`, or unparseable `expiresAt` treated as expired
    - `refresh()` — Desktop Auth POST to `prod.{region}.auth.desktop.kiro.dev/refreshToken`, SSO OIDC POST to `oidc.{region}.amazonaws.com/token`
    - Compute `expiresAt` as `new Date(Date.now() + expiresIn * 1000).toISOString()`
    - Desktop Auth: update `profileArn` from refresh response when present
    - `writeBackCredentials()` — preserve all existing fields, only update token fields + conditionally `profileArn`; create parent directories if missing
    - Concurrent refresh prevention via pending promise reuse
    - `getRegion()`, `getProfileArn()`, `getAuthType()` accessors
    - _Requirements: R1.1-R1.7, R2.1-R2.4, R3.1-R3.10, R16.1-R16.4_

  - [ ] 2.2 Write property tests for auth module (`test/upstream/kiro/auth.property.test.ts`)
    - **Property 1: Auth field storage completeness** — for any valid Auth_Token_File with required + optional fields, all present fields stored, absent optionals undefined
    - **Validates: R1.1, R1.3**
    - **Property 2: Token expiration threshold correctness** — for any (currentTime, expiresAt), `isTokenExpiringSoon()` iff `currentTime >= expiresAt - 600s`, `isTokenExpired()` iff `currentTime >= expiresAt`
    - **Validates: R2.1, R2.2, R2.3**
    - **Property 3: Auth type detection from credentials** — `aws_sso_oidc` iff both `clientId` and `clientSecret` available, `kiro_desktop` otherwise, with direct Auth_Token_File priority
    - **Validates: R3.1, R3.2**
    - **Property 4: Refresh response credential update** — after refresh, `getAccessToken()` returns new token, `expiresAt` computed correctly
    - **Validates: R3.5, R3.5a, R3.6**
    - **Property 5: Credential file write-back preservation** — round-trip read→refresh→write→read preserves non-token fields, only updates `accessToken`, `refreshToken`, `expiresAt`, conditionally `profileArn`
    - **Validates: R3.6, R3.7, R16.1, R16.2, R16.4**

  - [ ] 2.3 Write unit tests for auth module (`test/upstream/kiro/auth.test.ts`)
    - Missing Auth_Token_File throws with file path
    - Invalid JSON throws with parse error
    - Missing Device_Registration_File logs warning, proceeds without OIDC
    - Corrupt Device_Registration_File (invalid JSON, missing fields) logs warning, falls back to Desktop Auth
    - Unparseable `expiresAt` treated as expired
    - Concurrent refresh reuses pending promise
    - Desktop Auth refresh includes `User-Agent: KiroIDE-{version}-{fingerprint}` header
    - SSO OIDC refresh uses camelCase JSON body (`grantType`, `clientId`, `clientSecret`, `refreshToken`)
    - Refresh failure throws with status code and response body
    - Parent directory creation on write-back
    - _Requirements: R1.5, R1.6, R1.7, R2.4, R3.3, R3.4, R3.8, R3.9, R3.10, R16.3_

- [ ] 3. Checkpoint — Verify auth module
  - Run `bun test test/upstream/kiro/auth.test.ts test/upstream/kiro/auth.property.test.ts`
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement HTTP client
  - [ ] 4.1 Create `src/upstream/kiro/client.ts` with `Kiro_Client` class
    - Constructor takes `Kiro_Auth_Manager` and optional `fetch` override
    - `generateAssistantResponse(payload, options?)` — POST to `https://q.{region}.amazonaws.com/generateAssistantResponse`
    - Build all 9 required headers per R4 (Authorization, Content-Type, x-amzn-codewhisperer-optout, User-Agent, x-amz-user-agent, x-amzn-kiro-agent-mode, amz-sdk-invocation-id, amz-sdk-request)
    - Proactive token refresh via `auth.getAccessToken()` before every request
    - Return `Response` ONLY for 2xx; throw `KiroHttpError` for all non-OK
    - Non-retryable (400, 401) → throw immediately
    - 403 → refresh token, retry once; still fails → throw
    - 429 → exponential backoff (1s, 2s, 4s), up to 3 retries
    - 5xx → exponential backoff, up to 3 retries
    - Fetch errors: caller-abort (`options.signal?.aborted === true`) → re-throw `AbortError` as-is; internal errors → wrap as `KiroNetworkError`
    - Read timeout: 300s for streaming via `AbortSignal.timeout`
    - `listAvailableModels()` — GET to `ListAvailableModels?origin=AI_EDITOR`, include `profileArn` query param for Desktop Auth only, omit for SSO OIDC
    - `checkHealth(timeoutMs)` — authenticated probe to verify both Kiro API reachability and credential validity: call `auth.getAccessToken()` (triggers proactive refresh if expiring), then send a GET to `ListAvailableModels?origin=AI_EDITOR` (the same endpoint used by `listAvailableModels()`, including `profileArn` for Desktop Auth) with auth headers and `AbortSignal.timeout(timeoutMs)`. Return `HealthStatus` with `ok: true` on 2xx only, `ok: false` with descriptive message on 401/403 (auth failure), 5xx (server error), or network failure/timeout. Uses a real authenticated endpoint so the result reflects actual usability, not just network reachability.
    - _Requirements: R4.1-R4.9, R5.1-R5.7, R12.1, R18.1-R18.3_

  - [ ] 4.2 Write property test for client headers (`test/upstream/kiro/client.property.test.ts`)
    - **Property 6: Request header completeness** — for any valid auth state, every request includes all 9 required headers with correct patterns, API host is `https://q.{region}.amazonaws.com`
    - **Validates: R4.1-R4.9**

  - [ ] 4.3 Write unit tests for client (`test/upstream/kiro/client.test.ts`)
    - 403 triggers token refresh + retry
    - 429 uses exponential backoff (1s, 2s, 4s)
    - 5xx retries up to 3 times
    - Non-retryable (400, 401) throws immediately without retry
    - Exhausted retries throw `KiroHttpError` with last status
    - Caller-initiated abort re-throws `AbortError` without wrapping
    - Internal timeout wraps as `KiroNetworkError`
    - Proactive token refresh before each request
    - `listAvailableModels` includes `profileArn` for Desktop Auth, omits for SSO OIDC
    - `listAvailableModels` sends `origin=AI_EDITOR` query param
    - `checkHealth` returns `ok: true` on 2xx from `ListAvailableModels`, `ok: false` on 401/403 (auth failure), 5xx, timeout, network error
    - `checkHealth` triggers proactive auth refresh via `getAccessToken()` before probe
    - `checkHealth` uses `ListAvailableModels?origin=AI_EDITOR` endpoint (not API host root)
    - _Requirements: R5.1-R5.7, R12.1, R18.1-R18.2_

- [ ] 5. Checkpoint — Verify client module
  - Run `bun test test/upstream/kiro/client.test.ts test/upstream/kiro/client.property.test.ts`
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement payload conversion
  - [ ] 6.1 Create `src/upstream/kiro/payload.ts` with `convertCanonicalToKiroPayload` function
    - Implement the 12-step processing pipeline (steps 3-12, receiving `effectiveTools` from provider):
    - Step 3: Tool-role extraction on the ENTIRE pre-split input array — `role: "tool"` → `role: "user"` with `toolResults` in Kiro wire shape `{ toolUseId, content: [{ text }], status: "success" }`, empty output → `"(empty result)"`
    - Step 3.5: Strip historical server-tool content (`server_tool`, `web_search`, `mcp_call`, `mcp_call_output`) from all messages with warnings
    - Step 3.75: Named toolChoice conversion on the ENTIRE pre-split input array (not just post-split history) — convert non-effective `toolUses` and their corresponding `toolResults` to text representation, preserving only the named tool's structured `toolUses`/`toolResults`. This ensures the final message that becomes `currentMessage` is also cleaned, preventing Kiro validation failures from `toolResults` referencing tools absent from `effectiveTools`. Text format: `function_call` → `[Tool: {name} ({call_id})]\n{arguments}`, `toolResults` → `[Tool Result ({toolUseId})]\n{flattenedText}` with `flattenedText` from `content[].text` joined by newlines, `"(empty result)"` when empty.
    - Step 4: No-tools conversion on the ENTIRE pre-split input array — when `effectiveTools` empty, convert all `function_call`/`toolResults` to text using exact formats: `function_call` → `[Tool: {name} ({call_id})]\n{arguments}` (re-serialize via `JSON.stringify()` if parsed to object), `toolResults` → `[Tool Result ({toolUseId})]\n{flattenedText}` where `flattenedText` extracts `text` from each `content[]` item and joins with newlines (NOT `JSON.stringify(content)`), empty `flattenedText` → `"(empty result)"`. After conversion, remove `toolUses`/`toolResults` from payload structures.
    - Step 5: Validate tool names — reject names >64 chars with `ToolNameTooLongError`
    - Step 6: Remaining repair pipeline — normalize unknown roles, merge adjacent same-role, ensure user-first, ensure alternating
    - Step 7: Split — all but last → history, last → currentMessage source
    - Step 8: Derive currentMessage — assistant-last → `"Continue"`, tool-last → toolResults, empty → `"Continue"`
    - Step 9: Embed system prompt — prepend to first history message or currentMessage
    - Step 10: Validate orphaned toolResults — convert unmatched to text in both history and currentMessage
    - Step 10.5: Ensure non-empty content — `"(empty)"` fallback for all history messages
    - Step 10.75: Inject thinking tags — prepend `<thinking_mode>` and `<max_thinking_length>` when `reasoningEffort` present
    - Step 11: Build Kiro payload — tools at `currentMessage.userInputMessage.userInputMessageContext.tools`, omit empty `toolUses` from `assistantResponseMessage`, `profileArn` top-level for Desktop Auth only
    - Step 12: Measure and trim — trim oldest pairs if >400KB, re-validate orphaned toolResults, re-embed system prompt, re-measure FINAL payload, loop until fits or `PayloadTooLargeError`
    - Tool schema sanitization: remove empty `required` arrays, `additionalProperties` fields recursively
    - Tool description overflow: >10000 chars → move to system prompt with reference
    - Empty tool descriptions → `"Tool: {name}"` placeholder
    - Schema source: `parameters` field, fallback `input_schema`, then `{ type: "object", properties: {} }`
    - `inputSchema` wrapped as `{ json: sanitizedSchema }`
    - `input_image` data URL → `{ format, source: { bytes } }` in `userInputMessage.images`
    - URL-based images → text placeholder
    - `input_file` handling: text data URL → decoded text, binary → placeholder, URL/file_id → placeholder
    - `conversationId` as random UUID v4 per request
    - _Requirements: R6.1-R6.22, R17.1-R17.4_

  - [ ] 6.2 Write property tests for payload conversion (`test/upstream/kiro/payload.property.test.ts`)
    - **Property 7: Payload conversion structural correctness** — for any valid request with non-empty `effectiveTools`, payload has `conversationState` with UUID `conversationId`, `chatTriggerType: "MANUAL"`, `currentMessage` with non-empty `content`, `modelId`, `origin: "AI_EDITOR"`, tools at correct path
    - **Validates: R6.1, R6.4, R6.8a, R6.11**
    - **Property 8: Tool-role extraction correctness** — for any `role: "tool"` message, extraction produces `role: "user"` with `toolResults` in Kiro wire shape, empty output → `"(empty result)"`
    - **Validates: R6.3a, R6.6**
    - **Property 9: Schema sanitization idempotence** — sanitize(sanitize(schema)) === sanitize(schema)
    - **Validates: R6.9, R17.1, R17.2, R17.4**
    - **Property 10: Content preservation round-trip** — for valid requests without server tools, non-empty `effectiveTools`, non-named `toolChoice`, text content and tool call structure preserved
    - **Validates: R6.16**
    - **Property 11: No-tools text conversion completeness** — when `effectiveTools` empty, no `toolResults` or `toolUses` remain in any message, and converted text uses correct format (not stringified content arrays)
    - **Validates: R6.17**
    - **Property 14: Orphaned toolResults detection and text conversion** — unmatched toolResults converted to text in both history and currentMessage
    - **Validates: R6.13a, R6.13b**
    - **Property 15: Payload size trimming convergence and invariant preservation** — oversized payloads either trim to <400KB or throw, preserving: (a) size under 400KB, (b) user-first and alternating roles, (c) system prompt present in first history message or currentMessage, (d) no orphaned toolResults in history or currentMessage, (e) all history messages have non-empty content
    - **Validates: R6.19, R6.2, R6.2a, R6.13a, R6.13b, R6.14a**

  - [ ] 6.3 Write unit tests for payload conversion (`test/upstream/kiro/payload.test.ts`)
    - Empty history produces no `history` field
    - Assistant-last message → added to history, currentMessage `"Continue"`
    - Tool-result-only turn → toolResults in currentMessage, content `"Continue"`
    - System prompt embedding: prepend to first history message vs currentMessage when history empty
    - Tool description overflow → moved to system prompt
    - Empty tool description → `"Tool: {name}"` placeholder
    - Schema source priority: `parameters` > `input_schema` > default
    - `inputSchema` wrapped in `{ json: ... }`
    - `input_image` data URL conversion
    - URL-based image → text placeholder
    - `input_file` text data URL → decoded text
    - `input_file` binary → placeholder
    - `profileArn` included for Desktop Auth, omitted for SSO OIDC
    - Empty `toolUses` omitted from `assistantResponseMessage`
    - Thinking tag injection with various `reasoningEffort` values
    - Payload trimming: removes oldest pairs, re-validates orphans, re-embeds system prompt, re-measures final size
    - `PayloadTooLargeError` when all history exhausted
    - `ToolNameTooLongError` for names >64 chars
    - No-tools conversion exact text format: `function_call` → `[Tool: {name} ({call_id})]\n{arguments}`, `toolResults` → `[Tool Result ({toolUseId})]\n{flattenedText}` with `content[].text` flattened (not stringified array), empty → `"(empty result)"`
    - No-tools conversion: verify no `toolResults` or `toolUses` remain in any message after conversion
    - Named toolChoice on ENTIRE pre-split array: verify currentMessage source is also cleaned (toolResults for non-effective tools converted to text), not just history messages
    - Named toolChoice: named tool's own `toolUses`/`toolResults` remain in structured form
    - _Requirements: R6.1-R6.22, R17.1-R17.3_

- [ ] 7. Checkpoint — Verify payload conversion
  - Run `bun test test/upstream/kiro/payload.test.ts test/upstream/kiro/payload.property.test.ts`
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement response parsing
  - [ ] 8.1 Create `src/upstream/kiro/parse.ts` with stream parser and response collector
    - `AwsEventStreamParser` class:
      - `feed(chunk: Uint8Array)` — decode UTF-8, buffer incomplete JSON, detect event boundaries by pattern matching (`{"content":`, `{"name":`, `{"input":`, `{"stop":`, `{"usage":`, `{"contextUsagePercentage":`)
      - Nested brace matching for correct JSON boundary detection
      - Content deduplication (consecutive identical content events)
      - Tool call accumulation: dual accumulator (string buffer + object accumulator), finalization on `stop` event
      - `getToolCalls()`, `reset()`
    - `ThinkingBlockExtractor` class:
      - Buffer initial 30 chars to detect `<thinking>` or `<think>` tags
      - Extract content between opening/closing tags as thinking content
      - All content after closing tag → regular text
      - `feed(content)`, `finalize()`
    - `streamKiroResponse(response, fallbackModel, effectiveTools, inputTokenEstimate)` → `Canonical_StreamResponse`:
      - Yield `text_delta` for content events
      - Yield `tool_call_done` for finalized tool calls
      - Yield thinking event sequence: `content_block_start(thinking)` → `thinking_delta` → `thinking_signature(sig_{uuid_hex})` → `content_block_stop`
      - Yield `usage` event with estimated input/output tokens
      - Yield `message_stop` with stop reason (`end_turn`, `tool_use`, `max_tokens`)
      - Token estimation: gpt-tokenizer for output, `contextUsagePercentage` formula for input, fallback to `inputTokenEstimate`
    - `collectKiroResponse(response, fallbackModel, effectiveTools, inputTokenEstimate)` → `Canonical_Response`:
      - Consume entire event stream
      - Bracket-style tool call extraction: `[Called {name} with args: {json}]` pattern
      - Only extract when name in `effectiveTools` AND JSON parses successfully
      - Deduplicate against structured tool calls (prefer non-empty arguments)
      - Content array preserves original text order with bracket patterns removed
      - `stopReason: "tool_use"` when any `Canonical_ToolCallBlock` present
      - Response ID: `resp_{uuid}`
    - _Requirements: R7.1-R7.8, R8.1-R8.6, R9.1-R9.4, R10.1-R10.5, R13.1-R13.4, R19.1-R19.3, R20.1-R20.6, R21.1-R21.6_

  - [ ] 8.2 Write property tests for response parsing (`test/upstream/kiro/parse.property.test.ts`)
    - **Property 17: AWS event-stream parsing correctness** — for any valid sequence of Kiro event-stream chunks, all JSON events extracted correctly, cross-chunk splits handled, consecutive identical content deduplicated
    - **Validates: R7.1-R7.8**
    - **Property 18: Thinking block extraction** — for any response starting with `<thinking>`/`<think>`, thinking content extracted, subsequent content treated as regular text, correct event sequence yielded
    - **Validates: R10.1-R10.4**
    - **Property 19: Bracket-style tool call extraction** — for any non-streaming text with bracket patterns where name in `effectiveTools` and JSON valid, extracted `ToolCallBlock` and remaining `TextBlock` ordered by original position, no content loss
    - **Validates: R20.1-R20.6**
    - **Property 20: Token count estimation consistency** — for any `contextUsagePercentage` > 0 and known `maxInputTokens`, `inputTokens = max(0, floor((pct/100) * max) - output)`
    - **Validates: R13.2, R13.3**

  - [ ] 8.3 Write unit tests for response parsing (`test/upstream/kiro/parse.test.ts`)
    - Content event → `text_delta` canonical event
    - Tool start + input + stop → `tool_call_done` canonical event
    - Dual accumulator: string input chunks, object input chunks, mixed mode
    - Cross-chunk JSON splitting handled correctly
    - Content deduplication
    - Thinking block detection with `<thinking>` and `<think>` tags
    - Thinking signature format `sig_{uuid_hex}`
    - Bracket tool call extraction: valid pattern, invalid JSON preserved as text, name not in effectiveTools preserved as text
    - Bracket deduplication against structured tool calls
    - `stopReason: "tool_use"` when tool calls present (structured or bracket)
    - Non-streaming response ID format `resp_{uuid}`
    - Token estimation with and without `contextUsagePercentage`
    - Streaming mode: bracket patterns preserved as text (not extracted)
    - Malformed JSON in event-stream → skip event, continue parsing
    - _Requirements: R7.1-R7.8, R8.1-R8.6, R9.1-R9.4, R10.1-R10.5, R13.1-R13.4, R20.1-R20.6_

- [ ] 9. Checkpoint — Verify response parsing
  - Run `bun test test/upstream/kiro/parse.test.ts test/upstream/kiro/parse.property.test.ts`
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Implement provider orchestration and model resolver
  - [ ] 10.1 Create `src/upstream/kiro/index.ts` with `Kiro_Upstream_Provider` class
    - `static async fromAuthFile(path?, options?)` — create auth manager, client, return provider
    - Implement `Upstream_Provider` interface: `proxy(request, options)`, `checkHealth(timeoutMs)`
    - `proxy()` flow:
      1. Reject if `request.textFormat` is set → 400
      2. Validate no server tools (`web_search`, `web_fetch`, `mcp`) → 400
      3. Compute `effectiveTools` from `request.tools` and `request.toolChoice` (pass same set to both converter and parser per R6.18a)
      4. Normalize model name via `normalizeKiroModelName`
      5. Compute `inputTokenEstimate` from request messages using gpt-tokenizer (BEFORE conversion)
      6. Call `convertCanonicalToKiroPayload(request, effectiveTools, ...)`
      7. Catch `ToolNameTooLongError` → 400, `PayloadTooLargeError` → 413
      8. Call `client.generateAssistantResponse(payload, { signal, stream })`
      9. Streaming → `streamKiroResponse(...)`, non-streaming → `collectKiroResponse(...)`
      10. Catch `KiroHttpError` → `Canonical_ErrorResponse` with error's status/headers/body
      11. Catch `KiroNetworkError` → `Canonical_ErrorResponse` with status 504
      12. `AbortError` NOT caught — propagates to inbound provider
    - `checkHealth(timeoutMs)` — delegate to `client.checkHealth(timeoutMs)`, return `HealthStatus`
    - `listModels()` — cache for 3600s, include hidden models, merge/deduplicate with API results, fallback list on API failure
    - `normalizeKiroModelName()` — dash-to-dot minor version, strip date suffix, strip `-latest`, legacy format normalization, idempotent
    - _Requirements: R6.15, R6.18, R6.18a, R6.21a, R9.4, R11.1-R11.6, R12.2-R12.5, R13.1, R14.1, R18.1-R18.3, R19.1-R19.4_

  - [ ] 10.2 Write property tests for provider-owned logic (`test/upstream/kiro/index.property.test.ts`, `test/upstream/kiro/model.property.test.ts`)
    - **Property 12: effectiveTools computation correctness** — `auto`/`required`/absent → all tools; `none` → empty; named → single tool. Tested on the provider helper that computes `effectiveTools`, not on the converter.
    - **Validates: R6.18**
    - **Property 13: Server tool validation** — any request with `web_search`/`web_fetch`/`mcp` tools → 400 error before conversion. Tested on the provider's `proxy()` method or its validation helper.
    - **Validates: R6.15**
    - **Property 16: Model name normalization idempotence** — `normalize(normalize(x)) === normalize(x)` for any model name string
    - **Validates: R11.6**

  - [ ] 10.3 Write unit tests for provider and model resolver (`test/upstream/kiro/index.test.ts`, `test/upstream/kiro/model.test.ts`)
    - `textFormat` set → 400 error
    - Server tools in request → 400 error before conversion
    - Named toolChoice with missing tool → 400 error
    - `effectiveTools` computation for each `toolChoice` value (`auto`, `required`, `none`, absent, named)
    - `KiroHttpError` mapped to `Canonical_ErrorResponse`
    - `KiroNetworkError` mapped to 504
    - `Canonical_PassthroughResponse` never returned (passthrough flag ignored)
    - Model normalization: `claude-sonnet-4-5` → `claude-sonnet-4.5`, date suffix stripped, `-latest` stripped, legacy format
    - Model listing: TTL expiry triggers re-fetch, hidden models merged/deduplicated with API results, fallback on API failure
    - Model listing: SSO OIDC does NOT send `profileArn` query param
    - `checkHealth` delegates to client, returns `HealthStatus`
    - _Requirements: R6.15, R6.18, R11.1-R11.5, R12.1-R12.5, R18.1-R18.2, R19.1-R19.3_

- [ ] 11. Implement bootstrap integration
  - [ ] 11.1 Modify `src/app/bootstrap.ts` to support Kiro upstream provider selection
    - When `UPSTREAM_PROVIDER=kiro`: instantiate `Kiro_Upstream_Provider.fromAuthFile(...)`, register only `Claude_Inbound_Provider` with `listModels` as `modelResolver`, return synthetic `authFile` path (`~/.codex2claudecode/kiro-state.json`)
    - When `UPSTREAM_PROVIDER=codex` or unset: existing Codex path unchanged
    - Read `KIRO_AUTH_FILE` env var, default to `~/.aws/sso/cache/kiro-auth-token.json`
    - Do NOT register `OpenAI_Inbound_Provider` for Kiro mode
    - Do NOT modify `src/app/runtime.ts`
    - _Requirements: R14.1-R14.6, R15.5, R15.6, R22.3_

  - [ ] 11.2 Write unit tests for bootstrap Kiro integration (`test/app/bootstrap-kiro.test.ts`)
    - `UPSTREAM_PROVIDER=kiro` instantiates `Kiro_Upstream_Provider`
    - `UPSTREAM_PROVIDER=codex` instantiates `Codex_Upstream_Provider`
    - `UPSTREAM_PROVIDER` unset defaults to Codex
    - Kiro mode: only `Claude_Inbound_Provider` registered, no `OpenAI_Inbound_Provider`
    - Kiro mode: `authFile` is synthetic state path, `path.dirname(authFile)` resolves to `~/.codex2claudecode/` for request logs
    - Kiro mode: `listModels` injected as `modelResolver` into Claude inbound
    - Kiro mode: OpenAI routes (`/v1/responses`, `/v1/chat/completions`) return 404
    - `KIRO_AUTH_FILE` env var respected
    - _Requirements: R14.1-R14.6, R22.3_

- [ ] 12. Claude SSE compatibility verification
  - [ ] 12.1 Write integration tests for Claude SSE compatibility (`test/upstream/kiro/sse-compat.test.ts`)
    - Feed Kiro canonical events through `claudeCanonicalStreamResponse`, verify valid Claude SSE output using actual Claude wire event names (not canonical names)
    - Assert `message_start` event contains correct `model` and `id` fields
    - Assert `content_block_start` → `content_block_delta` (type `text_delta`) → `content_block_stop` sequence for text content
    - Assert thinking content produces: `content_block_start(thinking)` → `content_block_delta` (type `thinking_delta`) → `content_block_delta` (type `signature_delta`) → `content_block_stop`
    - Assert tool calls produce: `content_block_start(tool_use)` → `content_block_delta` (type `input_json_delta`) → `content_block_stop` with `stop_reason: tool_use` in `message_delta`
    - Assert `message_delta` event contains `stop_reason` (`end_turn`, `tool_use`, `max_tokens`) and `usage.output_tokens`
    - Assert stream terminates with `message_stop`
    - Assert `content_block_stop` events appear in correct order after their corresponding block deltas
    - Test all three stop reason variants: `end_turn` (text-only), `tool_use` (with tool calls), `max_tokens` (truncated)
    - _Requirements: R21.1-R21.6_

- [ ] 13. Final checkpoint — Verify all tests pass and architecture compliance
  - Run `bun test` to ensure all tests pass
  - Run `bun run build` to confirm compilation
  - Run `bun test test/backward-compat.test.ts` to verify backward compatibility
  - Run `bun test test/core/consolidation.property.test.ts` to verify consolidation properties
  - Verify no root `src/` files added: `find src -maxdepth 1 -type f ! -name index.ts -print` (expect empty)
  - Verify `src/upstream/kiro/` only imports from `src/core/` and its own directory (no inbound imports): `rg "from ['\"].*inbound" src/upstream/kiro/` (expect empty)
  - Verify no internal imports via `src/index.ts` barrel in source or tests: `rg "from ['\"].*/index['\"]" src test` (expect empty or only legitimate external package imports)
  - Verify no provider-specific code leaked into `src/core/`: `rg "kiro|Kiro" src/core/` (expect empty)
  - Verify no changes to `src/app/runtime.ts` (git diff check)
  - Verify `src/index.ts` public API surface unchanged
  - Ask the user if questions arise.

## Notes

- Property tests and unit tests are required gates, not optional. Each implementation task (2.1, 4.1, 6.1, 8.1, 10.1, 11.1) MUST be followed by its corresponding test tasks before proceeding to the next checkpoint.
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation after each major module
- Property tests validate universal correctness properties (P1-P20) from the design document with minimum 100 iterations each
- Unit tests validate specific examples, edge cases, and error conditions
- The project uses `bun` as runtime and test runner; all tests use `fast-check` for property-based testing
- Provider architecture coding rules (`.kiro/steering/provider-architecture-coding-rules.md`) must be followed throughout
- TypeScript is the implementation language (matching the existing codebase)
- Bracket-style tool call parsing (R20) belongs to the parser module (`parse.ts`), not the payload converter
