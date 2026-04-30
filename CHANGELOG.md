# Changelog

All notable changes to this package are documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

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
