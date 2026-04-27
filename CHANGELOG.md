# Changelog

All notable changes to this package are documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

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
