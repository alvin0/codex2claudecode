# Requirements Document

## Introduction

This document specifies the requirements for refactoring the codex2claudecode proxy server into a provider-agnostic architecture. The current system is tightly coupled to Claude as the inbound API format and Codex/OpenAI as the upstream provider. The refactoring introduces a canonical internal request/response representation and abstraction layers so that multiple inbound API formats (Claude, OpenAI, Gemini) and multiple upstream LLM providers (Codex, Kiro, Azure) can be supported through standard interfaces. Each inbound provider translates to/from the canonical internal format, and each upstream provider translates from that format to its own wire protocol. All existing tests must continue to pass after the refactoring.

## Glossary

- **Runtime**: The HTTP server that receives inbound requests, routes them to the appropriate Inbound_Provider via the Provider_Registry, and returns responses to the caller. The Runtime owns generic infrastructure routes (health, test-connection, OPTIONS, root info) but delegates all API-format-specific handling to registered providers.
- **Canonical_Request**: The provider-agnostic internal request representation that all Inbound_Providers produce and all Upstream_Providers consume. Contains structured fields for model, instructions, input messages, tools, streaming preference, a passthrough hint (boolean), and provider-neutral metadata.
- **Canonical_Response**: The provider-agnostic internal response type for non-streaming successful responses. Contains structured output: response id, model, stop reason, ordered content blocks (text, tool calls, server tool results, thinking), and usage statistics. This is one of four concrete response types that an Upstream_Provider can return; the others are Canonical_StreamResponse, Canonical_ErrorResponse, and Canonical_PassthroughResponse. Collectively these four types are referred to as the "canonical response types". The Inbound_Provider never sees the upstream wire format directly.
- **Inbound_Provider**: An adapter that translates requests from a specific external API format (e.g., Claude Messages API, OpenAI Chat Completions API) into a Canonical_Request, dispatches it to the Upstream_Provider, and translates the Canonical_Response back into the external API format.
- **Upstream_Provider**: A connector that accepts a Canonical_Request, translates it into the upstream LLM backend's wire format (e.g., Codex Responses API), sends it, and returns one of: Canonical_Response (parsed structured success), Canonical_StreamResponse (parsed streaming success), Canonical_ErrorResponse (upstream error passthrough), or Canonical_PassthroughResponse (raw wire-compatible success passthrough). Each Upstream_Provider manages its own authentication, credential lifecycle, and upstream wire format parsing internally — the Inbound_Provider never sees the upstream wire format directly.
- **Provider_Registry**: A registry that maps route descriptors (combining path pattern, HTTP method, and optional discriminators) to Inbound_Provider instances and manages registration conflicts.
- **Route_Descriptor**: A routing rule that includes at minimum a path pattern and HTTP method. A Route_Descriptor may optionally include a base path prefix or header-based discriminator to resolve ambiguity when multiple providers handle similar paths.
- **Core**: The set of generic, provider-agnostic modules shared across all providers: types, HTTP utilities, SSE parsing, request logging, file path utilities, and the canonical request/response definitions.
- **Canonical_Event**: A single provider-agnostic streaming event emitted by an Upstream_Provider. Event types include: text delta, tool call delta, server tool block (web search result, MCP tool use/result, citation), thinking delta (with label or verbatim reasoning text), thinking signature, usage update, content block lifecycle (start/stop), message lifecycle (start/stop), error, and completion signal. Inbound_Providers consume Canonical_Events to produce their own wire-format SSE events without knowledge of the upstream wire format.
- **Model_Catalog**: The centralized model metadata store loaded from models.json that provides model information in a format-agnostic structure. The Model_Catalog accepts an injectable model filter function to determine active models, rather than reading provider-specific configuration files directly.
- **Credential_Store**: A generic interface for reading and persisting authentication credentials. Provider-specific credential formats (OAuth tokens, API keys, service accounts) are implemented by each Upstream_Provider behind this interface.

## Requirements

### Requirement 1: Canonical Internal Representation

**User Story:** As a developer, I want a canonical internal request/response model that is independent of any specific API format, so that inbound and upstream providers can be developed and tested independently without knowledge of each other's wire formats.

#### Acceptance Criteria

1. THE Core module SHALL define a Canonical_Request type with structured fields for: model identifier, instructions, input messages (role + content blocks), tools, streaming preference, a passthrough hint (boolean, indicating the caller wants a raw passthrough response rather than a parsed canonical response), and an extensible metadata map.
2. THE Core module SHALL define a Canonical_Response type with structured output fields for non-streaming responses: response id, model identifier, stop reason, and an ordered list of content blocks. Content block types SHALL include at minimum: text block, tool call block (function call with id/name/arguments), server tool block (web search results, MCP tool use/result, citations), and thinking block (with signature). THE Canonical_Response SHALL also include usage statistics: input tokens, output tokens, and server tool usage counts (web search requests, web fetch requests, MCP calls). THE Canonical_Response SHALL NOT expose the raw upstream HTTP Response or upstream-specific SSE event types.
3. THE Core module SHALL define a Canonical_ErrorResponse type for upstream error forwarding, containing: HTTP status code, response headers, and raw body text. This allows Inbound_Providers to forward upstream errors with the original status code and body intact (e.g., a 418 from upstream is returned as 418 to the caller with the original body).
4. THE Core module SHALL define a Canonical_PassthroughResponse type for wire-compatible forwarding of successful upstream responses, containing: HTTP status code, response headers, and the raw response body (as a ReadableStream for streaming or string/buffer for non-streaming). This allows Inbound_Providers that need wire-compatible passthrough (e.g., OpenAI-compatible routes) to forward the upstream response without structural transformation.
5. THE Core module SHALL define a Canonical_Event type for streaming responses, representing individual events in a provider-agnostic format. Event types SHALL include at minimum: text delta, tool call delta (function call arguments), server tool block (web search result, MCP tool use/result, citation), thinking delta (with label text), thinking signature, usage update, content block start/stop, message start/stop, error, and completion signal. THE Upstream_Provider SHALL parse its own SSE/wire format and emit Canonical_Events.
6. THE Core module SHALL define a Canonical_StreamResponse type that wraps an async iterator of Canonical_Events along with response metadata (status code, response id, model).
7. THE Canonical_Request SHALL NOT contain fields specific to any single API format (no Claude-specific fields like `anthropic-version`, no OpenAI-specific fields like `store`).
8. WHEN an Inbound_Provider receives an external request, THE Inbound_Provider SHALL translate the external format into a Canonical_Request before passing it to the Upstream_Provider.
9. WHEN an Upstream_Provider receives a Canonical_Request, THE Upstream_Provider SHALL translate the Canonical_Request into its own upstream wire format, send it, and return a Canonical_Response, Canonical_StreamResponse, Canonical_ErrorResponse, or Canonical_PassthroughResponse — independently of the originating inbound format.
10. FOR ALL valid Canonical_Request objects, translating to an upstream wire format and back SHALL preserve the model identifier, instruction text, message count, and tool count (round-trip structural equivalence).

### Requirement 2: Upstream Provider Interface

**User Story:** As a developer, I want a minimal standard interface for upstream LLM providers, so that adding a new upstream requires only implementing a well-defined contract without modifying existing code.

#### Acceptance Criteria

1. THE Upstream_Provider interface SHALL define a `proxy(request: Canonical_Request, options?: RequestOptions): Promise<Canonical_Response | Canonical_StreamResponse | Canonical_ErrorResponse | Canonical_PassthroughResponse>` method that accepts a Canonical_Request and returns a Canonical_Response (non-streaming success), Canonical_StreamResponse (streaming success), Canonical_ErrorResponse (upstream error), or Canonical_PassthroughResponse (wire-compatible passthrough when the request's passthrough hint is set). The Upstream_Provider is responsible for parsing its own upstream wire format into the canonical types.
2. THE Upstream_Provider interface SHALL define a `checkHealth(timeoutMs: number): Promise<HealthStatus>` method that returns a HealthStatus object.
3. THE Upstream_Provider interface SHALL NOT require a `refresh()` method or a `tokens` property on all implementations. Token-based credential management SHALL be an optional capability interface that only OAuth-based providers implement.
4. THE Upstream_Provider interface SHALL define optional `usage(options?: RequestOptions): Promise<Response>` and `environments(options?: RequestOptions): Promise<Response>` methods for providers that support usage and environment queries.
5. WHEN an Upstream_Provider does not implement an optional method (usage, environments), THE Runtime SHALL return HTTP 501 (Not Implemented) for the corresponding route.

### Requirement 3: Codex Upstream Provider

**User Story:** As a developer, I want the existing Codex/OpenAI client logic extracted into a Codex-specific upstream provider, so that Codex-specific authentication and endpoint logic is encapsulated behind the standard Upstream_Provider interface.

#### Acceptance Criteria

1. THE Codex_Upstream_Provider SHALL implement the Upstream_Provider interface including the `proxy` and `checkHealth` methods.
2. THE Codex_Upstream_Provider SHALL implement the optional token-based credential capability interface, exposing `refresh()` and `tokens` for OAuth token management.
3. THE Codex_Upstream_Provider SHALL encapsulate all Codex-specific constants (DEFAULT_CLIENT_ID, DEFAULT_ISSUER, DEFAULT_CODEX_ENDPOINT, WHAM_USAGE_ENDPOINT, WHAM_ENVIRONMENTS_ENDPOINT) within its own module.
4. THE Codex_Upstream_Provider SHALL manage auth file reading, writing, and Codex CLI auth syncing internally.
5. THE Codex_Upstream_Provider SHALL encapsulate all OAuth-specific types (TokenResponse, JWT parsing, account ID extraction) within its own module rather than in Core.
6. THE Codex_Upstream_Provider SHALL support the `fromAuthFile` factory method for backward compatibility.
7. WHEN a 401 response is received from the Codex upstream, THE Codex_Upstream_Provider SHALL refresh tokens and retry the request exactly once.
8. THE Codex_Upstream_Provider SHALL translate Canonical_Request objects into Codex Responses API format, including reasoning normalization, before sending them upstream.
9. THE Codex_Upstream_Provider SHALL parse successful Codex upstream responses (including SSE streams) into Canonical_Response or Canonical_StreamResponse objects, so that Inbound_Providers never see Codex wire format.
10. WHEN the Codex upstream returns a non-success HTTP status (4xx or 5xx), THE Codex_Upstream_Provider SHALL return a Canonical_ErrorResponse containing the upstream status code, response headers, and raw body text, so that Inbound_Providers can forward the error with the original status and body intact.
11. WHEN the Canonical_Request has the passthrough hint set, THE Codex_Upstream_Provider SHALL return a Canonical_PassthroughResponse wrapping the raw upstream success response (status, headers, body stream) without parsing it into structured canonical types.
12. THE Codex_Upstream_Provider SHALL sanitize request headers by removing hop-by-hop headers and setting authorization, content-type, originator, and user-agent headers.
13. THE Codex_Upstream_Provider SHALL implement the optional `usage` and `environments` methods by proxying to the WHAM endpoints.

### Requirement 4: Inbound Provider Interface

**User Story:** As a developer, I want a standard interface for inbound API format adapters, so that the Runtime can route requests to the correct handler without hardcoding API-specific routes.

#### Acceptance Criteria

1. THE Inbound_Provider interface SHALL define a method to return the set of Route_Descriptors the provider handles, where each Route_Descriptor includes at minimum a path pattern and HTTP method.
2. THE Inbound_Provider interface SHALL define a request handler method that accepts an HTTP request, the matched Route_Descriptor, and the Upstream_Provider, and returns an HTTP Response. The Inbound_Provider is responsible for constructing the final HTTP Response including status code, headers, and body. The Runtime applies CORS headers to all responses after the Inbound_Provider returns.
3. WHEN the Runtime receives a request, THE Provider_Registry SHALL match the request against registered Route_Descriptors using path pattern, HTTP method, and any additional discriminators.
4. THE Inbound_Provider interface SHALL allow providers to register multiple Route_Descriptors (e.g., POST `/v1/messages`, POST `/v1/messages/count_tokens`, GET `/v1/models`).

### Requirement 5: Route Disambiguation for Multi-Inbound Providers

**User Story:** As a developer, I want the routing system to support multiple inbound providers that may share similar path structures, so that providers like Claude and OpenAI can coexist without path collisions.

#### Acceptance Criteria

1. THE Route_Descriptor SHALL support a configurable base path prefix per provider (e.g., `/claude/v1/messages`, `/openai/v1/chat/completions`) as one disambiguation strategy.
2. THE Route_Descriptor SHALL support HTTP method as a routing dimension, so that GET `/v1/models` and POST `/v1/models` can be handled by different providers.
3. THE Route_Descriptor SHALL support an optional header-based discriminator defined as a header name and a match mode: "presence" (header exists, any value) or "exact" (header exists with a specific value). Each Route_Descriptor SHALL have at most one header discriminator.
4. TWO Route_Descriptors SHALL be considered conflicting when they have the same resolved path pattern (including base path prefix), same HTTP method, AND equivalent header discriminators. Header discriminators are equivalent when: both have no discriminator, or both check the same header name with the same match mode and value. TWO Route_Descriptors with the same path and method where one has no header discriminator and the other has a header discriminator SHALL NOT be considered conflicting — this is the "generic fallback + header-specialized route" pattern, resolved by the specificity ordering in AC 5. THE Provider_Registry SHALL reject conflicting registrations and report an error identifying both providers.
5. THE Provider_Registry SHALL evaluate incoming requests against Route_Descriptors using specificity-first ordering: Route_Descriptors with an "exact" header discriminator SHALL be evaluated first, then "presence" discriminators, then Route_Descriptors without a header discriminator (for the same resolved path and method). WHEN multiple Route_Descriptors at the same specificity level both match a request (e.g., two "exact" discriminators on different headers that both match), THE Provider_Registry SHALL use registration order as the tie-breaker (first registered wins). In practice, the conflict detection in AC 4 prevents most ambiguous cases; this tie-breaker covers the remaining edge case of two non-equivalent discriminators at the same specificity level that both happen to match.

### Requirement 6: Claude Inbound Provider

**User Story:** As a developer, I want the existing Claude API handling logic encapsulated as a Claude-specific inbound provider, so that Claude-specific request/response translation is isolated from the Runtime.

#### Acceptance Criteria

1. THE Claude_Inbound_Provider SHALL implement the Inbound_Provider interface.
2. THE Claude_Inbound_Provider SHALL register Route_Descriptors for: POST `/v1/messages`, POST `/v1/messages/count_tokens`, GET `/v1/models`, and GET `/v1/models/:model_id`.
3. THE Claude_Inbound_Provider SHALL translate Claude Messages API requests into Canonical_Request objects (not directly into Codex Responses API format).
4. THE Claude_Inbound_Provider SHALL translate Canonical_Response (non-streaming) and Canonical_StreamResponse (streaming) objects back into Claude Messages API format. For streaming, the Claude_Inbound_Provider SHALL consume Canonical_Events and emit Claude-format SSE events without knowledge of the upstream wire format.
5. THE Claude_Inbound_Provider SHALL return errors in Claude API error format (type: "error", error.type, error.message).
6. THE Claude_Inbound_Provider SHALL handle the `/v1/message` path (without trailing 's') as a backward-compatible alias for `/v1/messages`.
7. THE Claude_Inbound_Provider SHALL use the Model_Catalog to retrieve model data and format it into Claude API model responses.

### Requirement 7: OpenAI-Compatible Inbound Provider

**User Story:** As a developer, I want the existing OpenAI-compatible passthrough routes handled by an inbound provider, so that no API-format-specific routes are hardcoded in the Runtime.

#### Acceptance Criteria

1. THE OpenAI_Inbound_Provider SHALL implement the Inbound_Provider interface.
2. THE OpenAI_Inbound_Provider SHALL register Route_Descriptors for: POST `/v1/responses` and POST `/v1/chat/completions`.
3. THE OpenAI_Inbound_Provider SHALL translate incoming OpenAI-format requests into Canonical_Request objects using the existing request normalization logic (normalizeRequestBody), with the passthrough hint set to true so that the Upstream_Provider returns a Canonical_PassthroughResponse for successful responses.
4. THE OpenAI_Inbound_Provider SHALL pass the Canonical_Request to the Upstream_Provider and return an HTTP Response with appropriate response headers. CORS headers SHALL be applied by the Runtime, not by the Inbound_Provider.
5. FOR successful upstream responses (2xx), THE OpenAI_Inbound_Provider SHALL forward the response body and streaming SSE shape wire-compatible with the current behavior: the upstream success body (JSON or SSE stream) SHALL be passed through to the caller without structural transformation, preserving the same response schema and SSE event format that `/v1/responses` and `/v1/chat/completions` currently return.
6. FOR upstream error responses (non-2xx), THE OpenAI_Inbound_Provider SHALL forward the Canonical_ErrorResponse status code, headers, and body text to the caller unchanged.
7. IF the incoming request body contains invalid JSON, THEN THE OpenAI_Inbound_Provider SHALL return a 500 error response with a descriptive error message.

### Requirement 8: Generic Core Modules

**User Story:** As a developer, I want provider-agnostic utilities extracted into a core module, so that all providers can share common functionality without circular dependencies.

#### Acceptance Criteria

1. THE Core module SHALL contain the Canonical_Request, Canonical_Response, Canonical_ErrorResponse, Canonical_PassthroughResponse, Canonical_StreamResponse, and Canonical_Event type definitions.
2. THE Core module SHALL contain generic type definitions shared across providers: JsonObject, RequestOptions, RuntimeOptions, HealthStatus, RequestLogEntry, SseEvent.
3. THE Core module SHALL contain the SSE parsing utilities (consumeCodexSse, parseSseJson, parseJsonObject, StreamIdleTimeoutError).
4. THE Core module SHALL contain the HTTP utilities (responseHeaders, cors).
5. THE Core module SHALL contain the request logging utilities (appendRequestLog, readRecentRequestLogs, clearRequestLogs, requestLogFilePath, ensureRequestLogFile).
6. THE Core module SHALL contain the file path utilities (appDataDir, defaultAuthFile, resolveAuthFile, expandHome, ensureParentDir).
7. THE Core module SHALL contain a generic Credential_Store interface for reading and persisting credentials. OAuth-specific types (TokenResponse, JWT helpers, AuthFileContent, AuthFileData) SHALL reside in the Codex upstream provider module, not in Core.
8. THE Core module SHALL contain the `normalizeReasoningBody` utility for reasoning effort normalization (model suffix parsing), as this operates on the generic model identifier field.
9. THE `normalizeRequestBody` function SHALL reside in the OpenAI_Inbound_Provider module, not in Core, because it normalizes OpenAI-specific request formats (`/v1/chat/completions` messages → input, `/v1/responses` string input → structured input) into the Canonical_Request format. A backward-compatible re-export SHALL be maintained at `src/reasoning`.

### Requirement 9: Provider Registry

**User Story:** As a developer, I want a provider registry that dynamically maps routes to inbound providers, so that the Runtime does not contain hardcoded route-to-handler mappings for any API format.

#### Acceptance Criteria

1. THE Provider_Registry SHALL allow registering Inbound_Provider instances with their Route_Descriptors at runtime.
2. THE Provider_Registry SHALL match incoming requests against registered Route_Descriptors using path pattern (exact match and parameterized segments), HTTP method, and optional discriminators.
3. WHEN multiple providers register conflicting Route_Descriptors (same path, method, and discriminators), THE Provider_Registry SHALL reject the registration and report a conflict error.
4. THE Provider_Registry SHALL expose a method to list all registered routes and their owning providers, for use in the root endpoint info response.
5. WHEN no registered provider matches a request, THE Runtime SHALL return a 404 response.
6. WHEN a request matches a registered route but uses a disallowed HTTP method, THE Runtime SHALL return a 405 response.

### Requirement 10: Model Catalog with Injectable Model Filter

**User Story:** As a developer, I want the model catalog to accept an injectable model filter rather than reading provider-specific configuration files directly, so that the catalog remains provider-agnostic.

#### Acceptance Criteria

1. THE Model_Catalog SHALL load model definitions from models.json and provide a generic lookup API (getModel, listModels, resolveAlias).
2. THE Model_Catalog SHALL store model metadata in a format-agnostic structure (id, display_name, created_at, max_input_tokens, max_tokens, capabilities).
3. THE Model_Catalog SHALL accept an injectable "active model resolver" function that returns the list of active model IDs, rather than reading ~/.claude/settings.json directly.
4. THE Claude_Inbound_Provider SHALL inject a model resolver that reads ~/.claude/settings.json to determine active model IDs, maintaining the current behavior.
5. WHEN no model resolver is injected, THE Model_Catalog SHALL return all models from models.json as active.

### Requirement 11: Runtime Refactoring

**User Story:** As a developer, I want the Runtime to delegate all API-format-specific request handling to registered Inbound_Providers, so that adding new API formats does not require modifying the Runtime.

#### Acceptance Criteria

1. THE Runtime SHALL create an Upstream_Provider instance during startup based on configuration.
2. THE Runtime SHALL create and register Inbound_Provider instances (Claude, OpenAI-compatible) with the Provider_Registry during startup.
3. THE Runtime SHALL delegate all API-format-specific request handling to the matched Inbound_Provider via the Provider_Registry.
4. THE Runtime SHALL handle infrastructure routes directly: root info (`/`), health (`/health`), test-connection (`/test-connection`), and OPTIONS preflight.
5. THE Runtime SHALL delegate usage (`/usage`, `/wham/usage`) and environments (`/environments`, `/wham/environments`) routes to the Upstream_Provider's optional methods.
6. WHEN the Upstream_Provider does not implement usage or environments, THE Runtime SHALL return HTTP 501 for those routes.
7. THE Runtime SHALL maintain all existing request logging, health monitoring, CORS behavior, and port fallback behavior.
8. WHEN the Runtime starts, THE Runtime SHALL log all registered provider routes alongside the existing endpoint listing.
9. THE Runtime SHALL NOT contain any import of or reference to Claude-specific, OpenAI-specific, or Codex-specific modules directly. All provider-specific logic SHALL be accessed through the Provider_Registry and Upstream_Provider interfaces.

### Requirement 12: Backward Compatibility

**User Story:** As a developer, I want the refactored codebase to maintain full backward compatibility, so that all existing tests pass and the public API surface remains unchanged.

#### Acceptance Criteria

1. THE refactored codebase SHALL pass all existing test cases without modification to test assertions.
2. THE public exports from `src/index.ts` SHALL remain unchanged (CodexStandaloneClient, startRuntime, runExample, all type exports).
3. THE re-export from `src/claude.ts` SHALL continue to export handleClaudeMessages and handleClaudeCountTokens.
4. THE following module import paths SHALL remain functional via re-exports from their original locations:
   - `src/client` (CodexStandaloneClient)
   - `src/http` (cors, responseHeaders)
   - `src/request-logs` (appendRequestLog, readRecentRequestLogs, clearRequestLogs, requestLogFilePath, ensureRequestLogFile, MAX_REQUEST_LOG_ENTRIES, REQUEST_LOG_FILE_NAME)
   - `src/constants` (LOG_BODY_PREVIEW_LIMIT and all other constants)
   - `src/runtime` (startRuntime)
   - `src/types` (all type exports)
   - `src/auth` (readAuthFile, readAuthFileData, selectAuthEntry, extractAccountId, extractAccountIdFromClaims, parseJwtClaims, IdTokenClaims)
   - `src/reasoning` (normalizeReasoningBody, normalizeRequestBody)
   - `src/account-info` (AccountInfo, AccountInfoFile, readAccountInfoFile, writeAccountInfoFile, refreshActiveAccountInfo, writeActiveAccountInfo, accountInfoPath, accountInfoFromAuthData, accountInfoFromAuth, accountInfoKey)
   - `src/paths` (resolveAuthFile, ensureParentDir, appDataDir, defaultAuthFile, expandHome, APP_DATA_DIR_NAME, AUTH_FILE_NAME)
   - `src/codex-auth` (syncCodexCliAuthTokens, readCodexCliAuthFile, codexCliAuthAccountId, DEFAULT_CODEX_CLI_AUTH_FILE, CodexCliAuthFile)
   - `src/claude/convert` (claudeToResponsesBody, countClaudeInputTokens)
   - `src/claude/errors` (claudeErrorResponse, claudeStreamErrorEvent)
   - `src/claude/handlers` (handleClaudeCountTokens, handleClaudeMessages)
   - `src/claude/response` (collectClaudeMessage, claudeStreamResponse)
   - `src/claude/sse` (consumeCodexSse, parseJsonObject, parseSseJson, StreamIdleTimeoutError)
   - `src/claude/web` (claudeWebResultHasContent, codexMessageContentToClaudeBlocks, codexOutputItemsToClaudeContent, codexWebCallToClaudeBlocks, countCodexWebCalls, webServerToolAdapter)
   - `src/claude/server-tools` (resolveClaudeTools, claudeToolChoiceToResponsesToolChoice, codexServerToolCallToClaudeBlocks, codexOutputItemsToClaudeContent, countClaudeServerToolCalls, isServerToolOutputItem, ResolvedClaudeTools)
   - `src/claude/server-tool-adapter` (ClaudeServerToolAdapter, ServerToolResolutionContext, ResolvedServerTool, ServerToolContent, ServerToolUsageCounts, codexMessageContentToClaudeTextBlocks, codexMessageOutputToClaudeTextBlocks)
   - `src/claude/mcp` (resolveMcpServers, claudeMcpToolsetToResponsesTool, codexMcpToClaudeBlocks, isMcpOutputItem, countMcpCalls, mcpServerToolAdapter, MCP_TOOL_RESULT_INCLUDE, MCP_APPROVAL_INCLUDE)
   - `src/claude-code-env.config` (CLAUDE_CODE_ENV_CONFIG)
   - `src/cli` (parseCliOptions)
   - `src/connect-account` (connectAccount, connectAccountFromCodexAuth, ConnectAccountDraft, ConnectAccountOptions)
   - `src/package-info` (packageInfo)
   - `src/ui/limits` (usageToView, LimitRowView, LimitGroupView, UsageView)
   - `src/ui/claude-env` (claudeEnvironmentCommands, claudeEnvironmentConfigPath, claudeEnvironmentExports, claudeEnvironmentPowerShellCommands, claudeEnvironmentUnsetCommands, claudeSettingsPath, claudeSettingsPathForScope, claudeSettingsScopeLabel, and all other exports)
5. IN ADDITION to the explicitly enumerated symbols above, ANY symbol that is currently exported from a module listed in AC 4 SHALL remain importable from that module path after refactoring. The enumerated lists are the minimum guaranteed surface; the actual contract is "all current public exports of each listed module".
6. BECAUSE the package publishes the entire `src` directory via the `files` field in package.json, ALL module paths currently importable under `src/**` SHALL remain importable after refactoring — either at their original path or via a re-export from the original path. This includes but is not limited to: `src/ui/accounts`, `src/ui/clipboard`, `src/ui/commands`, `src/ui/runtime-state`, `src/ui/types`, `src/ui/index`, `src/claude/index`, and all `src/ui/components/*` modules.
7. THE Runtime SHALL serve the same endpoints on the same paths with the same request/response formats, including the `/v1/message` (singular) alias and `/wham/usage`, `/wham/environments` legacy paths.
8. THE Runtime SHALL maintain the same port fallback, health monitoring, and request logging behavior.

### Requirement 13: Separation of Concerns and Extensibility

**User Story:** As a developer, I want the codebase organized so that core utilities, inbound providers, and upstream providers are clearly separated, so that adding a new provider requires creating files only in the appropriate provider directory.

#### Acceptance Criteria

1. THE refactored codebase SHALL separate generic provider-agnostic utilities from provider-specific code, such that no provider-specific module imports from another provider's directory.
2. THE refactored codebase SHALL organize inbound API format adapters in a dedicated directory structure with a subdirectory per provider.
3. THE refactored codebase SHALL organize upstream LLM connectors in a dedicated directory structure with a subdirectory per provider.
4. THE refactored codebase SHALL place provider interface definitions (Inbound_Provider, Upstream_Provider, Route_Descriptor) and the Provider_Registry in a location accessible to all providers without circular dependencies.
5. THE refactored codebase SHALL maintain backward-compatible re-exports from all original file locations enumerated in Requirement 12.
6. WHEN a new inbound provider is added, THE developer SHALL only need to create files in the inbound provider directory and register the provider at startup, without modifying Core, Upstream, or Runtime modules.
7. WHEN a new upstream provider is added, THE developer SHALL only need to create files in the upstream provider directory and update the startup configuration, without modifying Core, Inbound, or Runtime modules.
