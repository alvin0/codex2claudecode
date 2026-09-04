# Changelog

All notable changes to this package are documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

## [0.4.1] - 2026-09-04

### Added

- Added `NATIVE_FEATURE_NOTICES`, which controls whether `degrade` notices are written into the client's own text. Off by default: the notices describe the upstream rather than the request, so they repeated on every turn. They still reach `Canonical_Response.featureNotices`, stream telemetry, and `/logs`.
- Added citation support to the Claude streaming path: `text_done` now carries the upstream's annotations, and the renderer emits `citations_delta` events through the same mapping the non-streaming path uses.
- Added `Canonical_StreamResponse.usage`, so an upstream that already counted its input (Kiro) reports the same `input_tokens` in `message_start` that `message_delta` closes on.

### Changed

- Feature warnings now render as one line naming the affected features instead of a header plus one detail line per notice. The prose stays on the telemetry channel.
- Kiro's `promptCache` cell is now `degrade` instead of `reject`: a dropped cache hint changes what a request costs, not what it answers, and rejecting it turned away every Claude Code request (which always sends `cache_control`). Codex and Copilot already declared `degrade` on the same fact.
- `CLAUDE_CODE_DISABLE_1M_CONTEXT` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` are now optional in the Claude environment editor: blank by default, written only when given a value, and removed from `settings.json` when cleared.
- `/switch-provider` now reports a failed provider-state write instead of letting the rejection escape, and says how to connect an account when the target has none.

### Fixed

- Fixed `bun test` timeouts on slower machines by raising the per-test limit to 30s, and made `coverage` skip the same live smoke tests `test` does.

## [0.4.0] - 2026-09-03

### Added

#### Native API Mode

- Added a declared capability matrix per upstream (`src/upstream/<provider>/capabilities.ts`) covering 12 named features — `sampling`, `outputLength`, `stopSequences`, `thinkingBudget`, `systemPrompt`, `promptCache`, `strictToolSchema`, `toolChoiceForced`, `structuredOutput`, `webSearch`, `webFetch`, `mcpToolset` — where every cell resolves to exactly one of four policies: `native`, `emulate`, `degrade`, `reject`.
- Added the `feature_notice` canonical event and its `featureNotices` telemetry field, so a request that was accepted with changed semantics now says so instead of changing quietly. Claude and OpenAI inbound providers render notices in their own wire format.
- Added no-silent-drop enforcement: a client field the upstream cannot honor is either sent, emulated, degraded with a notice, or rejected with a message — never discarded without a trace.
- Added `NATIVE_STRICT`, which escalates every `degrade` outcome to a `400`. Interpreted in one place (`src/core/feature-policy.ts`) rather than at each feature site.
- Added byte passthrough for `/v1/responses` → Codex via `src/app/passthrough-resolver.ts`, gated by `NATIVE_PASSTHROUGH`. This is the only inbound/upstream pair whose wire formats match, so it is the only pair that qualifies.
- Added canonical carriage for fields the request layer previously dropped: `temperature`, `top_p`, output-length limits, stop sequences, thinking budget, and structured-output format. Inbound providers map them in; upstream providers consume them per the matrix.
- Added a provider-agnostic MCP protocol client in core (`src/core/mcp/`): JSON-RPC 2.0 over HTTP for `initialize`, `tools/list`, and `tools/call`, plus toolset expansion and execution. Kiro can emulate a client-declared MCP toolset when `NATIVE_MCP_EMULATION` is on; with the flag off the previous `400` stands byte for byte.
- Added rejection with guidance for MCP toolsets that declare `require_approval`, instead of withholding them silently.
- Added Kiro `web_fetch` emulation — the gateway performs the fetch rather than refusing the request.
- Added declared hosted tool types for Codex, replacing the mis-shaped forwarding they used to get.
- Added `src/app/native-flags.ts` as the single reader for `NATIVE_STRICT`, `NATIVE_PASSTHROUGH`, `NATIVE_MCP_EMULATION`, and `KIRO_WEB_SEARCH_HEURISTICS`. All four are off by default; the resolved booleans are threaded through provider construction.
- Added a live verification harness (`test/native/`, `scripts/native-verify.ts`) with 14 named cases and one secret-redacted transcript per case, runnable via `bun run test:native:verify` and `bun run test:native:live`.
- Added an architecture contract property test (`test/architecture.property.test.ts`) asserting the layer boundaries in `.kiro/steering/provider-architecture-coding-rules.md`.
- Added upstream probe scripts: `probe:codex:effort`, `probe:codex:sampling`, `probe:native:combined`, plus Codex and Kiro model probes.

#### Account rotation

- Added rotation mode, toggled from `/rotation` in the UI and off by default because it spends other accounts' quota. The toggle applies to the running gateway immediately and persists across restarts.
- While on, an account-level failure retries on the next account instead of returning to the client. Cooldown ladder: `401`/`403` rest 30 minutes, `402`/`429` rest until the provider's reset time, `5xx` rest 1 minute. Anything else (malformed request, `404`) is returned as-is.
- The account that answers becomes the active one and is persisted; quota failures are re-probed every 5 minutes.

#### Codex login and transport

- Added browser login for Codex (`/connect` → **Login with browser**): the same OAuth PKCE flow `codex login` uses, on the fixed callback `http://localhost:1455/auth/callback`, writing into this gateway's own auth file. `~/.codex/auth.json` is never touched. The URL is printed as well as opened so a headless machine can finish sign-in elsewhere.
- Added a Codex WebSocket transport for `wss://chatgpt.com/backend-api/codex/responses`, off by default behind `CODEX_WIRE_API=responses_websocket`. Streaming requests only; non-streaming turns and any handshake or socket failure fall back to HTTPS.

#### Codex CLI / Codex IDE mode

- Added `/set-codex-cli` in the UI and `--setup-codex-cli` on the CLI to write a Codex CLI / Codex IDE profile pointing at this gateway, with `--make-default` to make it the default profile.
- Added OpenAI-inbound model alias resolution so Codex-CLI-style model names route correctly.

#### Kiro

- Added provider credits reporting from Kiro's metering payload.
- Added per-model reasoning effort enums read from Kiro model metadata, with a bundled static catalog as fallback.

### Changed

- Updated Codex default models: `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL` to `gpt-5.6-sol`, `ANTHROPIC_DEFAULT_SONNET_MODEL` to `gpt-5.6-terra`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` to `gpt-5.6-luna`.
- Updated Kiro default models: `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL` to `claude-opus-5`, `ANTHROPIC_DEFAULT_SONNET_MODEL` to `claude-sonnet-5`. `ANTHROPIC_DEFAULT_HAIKU_MODEL` stays `claude-haiku-4.5`.
- Added model aliases `gpt-5.6` and `gpt-5.6-latest` → `gpt-5.6-sol`, and `claude-opus-4-8` → `claude-opus-4.8`.
- An effort level outside a Kiro model's published enum is now mapped to the nearest supported level with a notice, instead of failing the request with a `400`.
- A Claude `thinking.budget_tokens` on Kiro is now mapped onto the nearest effort level the model publishes, and the mapping is reported. Kiro's wire format has no budget field, so the change of semantics is disclosed rather than applied silently.
- Kiro web search no longer guesses user intent. The old intent-preflight and synthesized tool-call heuristics are behind `KIRO_WEB_SEARCH_HEURISTICS`, off by default. A `web_search` the model itself emits is still executed in both flag states.
- Split output-length handling out of `sampling` into its own `outputLength` feature, because the two carry different policies on the same upstream.
- Reasoning signatures are now redacted in request logs and debug captures.
- Rebuilt the bundled `dist/index.js` artifact for this release.

### Fixed

- Fixed the Kiro model-default effort rung being unreachable: the resolver returned before loading model metadata, so a request that stated neither a level nor a budget never picked up the model's own published default.
- Fixed a canonical `web_fetch` on Kiro falling through to the undeclared-hosted-tool path, which reported it under `mcpToolset` and escalated to a `400` under `NATIVE_STRICT` for a request the upstream declares it can serve.

## [0.3.2] - 2026-06-29

### Added

- Added `/endpoint-share` in the terminal UI so Codex, Kiro, and Copilot can proxy selected endpoints to one another from a guided wizard.
- Added per-endpoint proxy persistence in provider state, covering `messages`, `count_tokens`, `responses`, `chat_completions`, and `embeddings`.
- Added shared Claude and OpenAI route registries so bootstrap, runtime, and UI can discover and advertise endpoint coverage from the same source of truth.
- Added bootstrap and runtime helpers for endpoint-share wiring, including connected-account checks and proxy-target normalization.
- Added tests for endpoint-share normalization, source selection, and bootstrap/runtime proxy registration.

### Changed

- Refactored provider bootstrap into shared runtime helpers so auth-file resolution and upstream construction are handled consistently across Codex, Kiro, and Copilot.
- Updated runtime route listing and root metadata so proxied OpenAI endpoints are reported with the correct provider labels.
- Rebuilt the bundled `dist/index.js` artifact for this release.

## [0.3.1] - 2026-06-27

### Changed

- Updated the npm publish workflow so tagged releases can publish automatically while still supporting manual dispatch.
- Split GitHub Release and npm publish responsibilities so tag releases no longer try to publish twice.
- Re-exported provider types and tightened Copilot/OpenAI type surfaces to keep the current codebase type-safe after the provider consolidation work.
- Rebuilt the bundled `dist/index.js` artifact for this release.

## [0.3.0] - 2026-06-27

### Added

- Added Copilot as a first-class provider alongside Codex and Kiro.
- Added Copilot device-code login with visible verification URL and user code in the terminal UI.
- Added Copilot `POST /v1/embeddings` support.
- Added shared filesystem-backed provider state and cache files so provider switching does not depend on Cloudflare storage.

### Changed

- Consolidated provider auth/state storage into `provider-state.json` and `provider-cache.json`, while keeping legacy files migratable.
- `/switch-provider` now exposes Codex, Kiro, and Copilot as switch targets.
- Switching providers now persists the selected provider back to the shared provider-state file.
- Empty auth scaffolds are now created up front so switching works even before a provider is connected.
- Rebuilt the bundled `dist/index.js` artifact for this release.

## [0.2.5] - 2026-05-29

### Added

- Added support for `~/.aws/sso/cache/kiro-auth-token-cli.json` (Kiro CLI / IdC) as a second Kiro auth source alongside the existing desktop cache.
- The `/connect` menu for Kiro now shows three options: **Add from Kiro IDE auth**, **Add from Kiro CLI auth**, and **Manual**.

### Changed

- Bootstrap and UI now auto-discover the CLI cache as a fallback when the desktop cache is absent and `KIRO_AUTH_FILE` is not set.
- Rebuilt the bundled `dist/index.js` artifact for this release.



### Changed

- Updated Codex default model: `ANTHROPIC_DEFAULT_SONNET_MODEL` changed from `gpt-5.5` to `gpt-5.4`.
- Updated Kiro default models: `ANTHROPIC_MODEL` changed to `claude-opus-4.7`, `ANTHROPIC_DEFAULT_OPUS_MODEL` changed to `claude-opus-4.7`, `ANTHROPIC_DEFAULT_SONNET_MODEL` changed to `claude-sonnet-4.6`.

## [0.2.3] - 2026-04-30

### Added

- Standalone binaries for macOS, Linux, and Windows — download and run directly, no Bun or Node.js needed.
- Auto-release workflow: pushing a version tag builds all platforms and uploads binaries to GitHub Releases.
- README quick-start section for standalone binary installation with one-liner curl commands.

### Changed

- npm package no longer bundles standalone binaries, keeping the download size small.
- Rebuilt the bundled `dist/index.js` artifact for this release.

## [0.2.2] - 2026-04-29

### Added

- Added model metadata registries for Codex and Kiro, populated from upstream APIs at startup with per-model token limits, capabilities, and supported input types.
- Added API password protection via `--password` CLI flag or `API_PASSWORD` environment variable. Protected endpoints require `X-Api-Key` or `Authorization: Bearer` headers; health, root, and OPTIONS requests remain open.
- Added timing-safe password comparison (`timingSafeCompare`) to prevent password length leaking via timing side-channels.
- Added non-streaming response accumulation for clients that send `stream: false` — both Claude and OpenAI-compatible inbound providers now collect the canonical stream and return a single JSON response.
- Added `backfillInputTokens` fallback for upstream providers that don't report input token counts — Claude inbound uses a purpose-built tokenizer, OpenAI inbound uses `gpt-tokenizer` as a crude approximation.
- Added Kiro `"(empty)"` sentinel filter — Kiro sends `content: "(empty)"` when the model produces no text before a tool call; this is now silently discarded instead of forwarded as real content.
- Added empty delta guard in Claude SSE stream conversion — empty string deltas from upstream are filtered before they can open spurious content blocks.
- Added `password_protected` field to `GET /` config response so clients can detect whether auth is required.
- Added auth token redaction in Claude environment preview lines and `formatManagedEnvironment` output.
- Added property-based tests (fast-check) for auth guard, empty delta guard, and Kiro sentinel filter.
- Added integration tests for API password protection covering all protected/unprotected endpoints and backward compatibility.
- Added `/v1/models?origin=true` passthrough for raw upstream model list responses.
- Added PDF and image binary attachment support in Kiro payload conversion — previously these were skipped.
- Added core stream utilities (`interceptResponseStream`, `withChunkCallback`) replacing duplicated response body logging across providers.
- Added core building blocks for future use: `CanonicalStreamAccumulator`, `StreamTelemetryCollector`, `ToolCallCoordinator`, `UsageSource` tracking.
- Added `ProviderCapabilities` interface in core with concrete definitions in each upstream provider directory.
- Added `atomicJsonWrite` for safe request log writes via temp-file + rename.
- Added Kiro event-stream parser diagnostics and telemetry counters.

### Changed

- Extracted Claude SSE framing into `ClaudeSseWriter`, reducing inline block management in `claudeCanonicalStreamResponse` significantly.
- Introduced `CodexProxyFn` interface so the Claude handler depends on an abstract contract instead of importing upstream Codex modules directly.
- OpenAI-compatible inbound now always uses the canonical path (`passthrough=false`, `stream=false` by default) for proper JSON and SSE framing.
- Kiro token estimation and payload size calculation now exclude base64 image data, preventing inflated estimates and false context-limit errors.
- Kiro `estimateInputTokens` now uses per-model `maxInputTokens` from the metadata registry instead of a hardcoded default.
- Claude Codex adapter now uses a dynamic model resolver wired to `upstream.listModels()` at bootstrap.
- Added `x-accel-buffering: no` header to Claude SSE responses for better proxy compatibility.
- `mergeCanonicalUsage` now uses `Math.max` semantics for all usage fields instead of simple assignment, ensuring monotonic growth across streaming events.
- Claude environment helpers (`managedEnvironmentEntries`, `claudeEnvironmentPreviewLines`, `persistClaudeEnvironment`, etc.) now accept and thread `apiPassword` through the full call chain.
- `WelcomePanel` displays auth status as `"enabled"` / `"none"` instead of exposing the raw password value.
- Rebuilt the bundled `dist/index.js` artifact for this release.

### Fixed

- Fixed Kiro base64 image payloads causing false "context window exceeded" errors and inflated input token estimates.
- Fixed Kiro event-stream parser matching patterns inside JSON string values, causing mid-string splits on nested JSON.
- Fixed request log writes being non-atomic — now uses temp-file + rename so the original is preserved on failure.
- Fixed `stream` default in Claude inbound convert — reverted from `stream: body.stream ?? false` back to `stream: body.stream ?? true` to preserve existing streaming behavior.
- Fixed `useProviderRuntime` React hook missing `apiPassword` in the `useEffect` dependency array, which could cause stale closures when the password changes.

## [0.2.1] - 2026-04-27

### Added

- Added provider-kind guards so Claude and OpenAI-compatible inbound adapters fail fast when wired to the wrong upstream provider.
- Added shared canonical usage accounting for input, output, cached-input, reasoning-output, and server-tool usage fields.
- Added Kiro usage parsing for object-shaped session `usage` events, including cache and server-tool fields when Kiro returns them.
- Added tests for Codex and Kiro `/v1/messages` separation, OpenAI-compatible Kiro routing, streamed usage merging, and Kiro context-limit behavior.

### Changed

- Codex/OpenAI usage is now preserved through canonical responses and streams instead of dropping cached-token or reasoning-token details.
- Kiro streaming and non-streaming responses now prefer concrete Kiro usage data over local estimates when upstream usage is available.
- OpenAI-compatible streaming responses now merge usage updates across usage and completion events instead of replacing earlier token details.
- Rebuilt the bundled `dist/index.js` artifact for this release.

### Fixed

- Fixed Claude Code over-Kiro oversized payload handling by returning a Claude-style context-window error instead of proxy-side compacting or trimming Claude Code history.
- Fixed context-limit error forwarding so Claude Code can see actionable upstream context-window messages and trigger its own recovery behavior.
- Fixed accidental Codex/Kiro adapter mixing for `/v1/messages`, `/v1/responses`, and `/v1/chat/completions`.
- Fixed Kiro server-tool usage accounting so repeated usage events and locally emitted server-tool blocks keep the larger observed count without double counting.
- Fixed Kiro missing-body streams with preflight server-tool blocks so final usage still reports server-tool usage.

## [0.2.0] - 2026-04-26

### Added

- Added Kiro as a first-class upstream provider alongside Codex.
- Added Kiro account connection flows, including import from the Kiro IDE auth cache and manual credential entry.
- Added Kiro-compatible request handling for `/v1/responses` and `/v1/chat/completions`.
- Added Kiro model discovery with a fallback catalog when the upstream model list is unavailable.
- Added Kiro usage and limits display in the terminal UI.
- Added provider-aware routing, account selection, health checks, and runtime state management.

### Changed

- Reworked the internal architecture around provider-specific inbound and upstream adapters.
- Migrated the packaged runtime to Bun and declared Bun `>=1.3.0` as the runtime requirement.
- Improved proxy logging so request and response bodies are captured only when needed.
- Optimized Kiro payload trimming with binary search to reduce request preparation overhead.
- Improved Kiro streaming and non-streaming response parsing, including tool calls, usage estimation, and thinking output handling.
- Expanded type checking and deterministic test coverage for provider edge cases.

### Fixed

- Preserved thinking tags and thinking blocks while converting Kiro responses.
- Reduced oversized Kiro request failures by trimming older conversation history before sending upstream.
- Improved error mapping for Kiro authentication, network, HTTP, and MCP web search failures.

### Breaking Changes

- The application now requires Bun `>=1.3.0` at runtime.
- The npm/npx binary is a compatibility launcher. It checks for Bun, falls back to `npx --yes bun@latest` when no local Bun is available, and prints install instructions when no usable Bun can be started.

### Migration Notes

- Install Bun before upgrading existing Node-only environments:

  ```sh
  curl -fsSL https://bun.sh/install | bash
  ```

- Windows PowerShell:

  ```powershell
  powershell -c "irm bun.sh/install.ps1 | iex"
  ```

## [0.1.x] - 2026-04-24 to 2026-04-25

### Added

- Initial npm package and CLI entry point for `codex2claudecode`.
- Added a local Claude-compatible API that lets Claude Code use Codex/ChatGPT account credentials.
- Added Codex account import from `~/.codex/auth.json` and manual credential connection.
- Added Claude Code environment export helpers for local `ANTHROPIC_*` settings.
- Added core Claude-compatible endpoints, including messages, token counting, model listing, health, usage, and environment helpers.
- Added terminal UI commands for connecting accounts, switching accounts, viewing limits, viewing logs, and managing Claude Code environment settings.
- Added Codex fast mode configuration, model metadata handling, request logs, stream idle timeout handling, and thinking block conversion.
- Added support for Claude Code web search permissions and document-related response conversion.

### Changed

- Consolidated the initial module structure and package export surface.
- Improved terminal UI text rendering, layout responsiveness, and log readability.
- Improved Codex token refresh handling and synchronization with the original Codex CLI auth file.

### Fixed

- Fixed package metadata resolution so the package can locate `package.json` from nested runtime paths.

### Notes

- The `0.1.x` series focused on bootstrapping the package and making Codex export cleanly into Claude Code workflows.
- Kiro support was introduced after the `0.1.x` series and is part of `0.2.0`.
