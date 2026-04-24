# Implementation Plan: Consolidate Root Shims

## Overview

Consolidate the import graph of codex2claudecode by updating all internal consumers to import directly from Provider Directories (`src/core/`, `src/upstream/codex/`, `src/inbound/claude/`, `src/inbound/openai/`) instead of going through root-level shim files. Move `claude-code-env.config.ts` into `src/inbound/claude/` with a backward-compat shim at the old location. All 12 root shims, 10 legacy claude shims, and 3 inbound shims are preserved — no shim is deleted.

The implementation follows the safe execution order from the design: move file → inbound shims → handler → UI files → barrel → full test.

## Tasks

- [x] 1. Move `claude-code-env.config.ts` to `src/inbound/claude/` and create shim
  - [x] 1.1 Move `src/claude-code-env.config.ts` to `src/inbound/claude/claude-code-env.config.ts`
    - Copy the file content to `src/inbound/claude/claude-code-env.config.ts`
    - Update the import of `MODEL_CLIENT_DEFAULTS` inside the moved file: change `from "./models"` to `from "./models"` (keep as-is since `src/inbound/claude/models.ts` exists and re-exports from the right place)
    - Verify `src/inbound/claude/models.ts` exports `MODEL_CLIENT_DEFAULTS` — if not, import from `../../models` instead
    - _Requirements: 2.1_

  - [x] 1.2 Replace `src/claude-code-env.config.ts` with a shim that re-exports exactly 3 symbols
    - The shim must use explicit named exports: `export { CLAUDE_CODE_ENV_CONFIG } from "./inbound/claude/claude-code-env.config"`
    - Must also re-export types: `export type { ClaudeCodeEditableEnvKey, ClaudeCodeLockedEnvKey } from "./inbound/claude/claude-code-env.config"`
    - Do NOT use `export *` — the Exact_Export_Surface is exactly `CLAUDE_CODE_ENV_CONFIG`, `ClaudeCodeEditableEnvKey`, `ClaudeCodeLockedEnvKey`
    - _Requirements: 2.1, 2.4, 3.3_

  - [x] 1.3 Verify build passes after file move
    - Run `bun run build` and confirm success
    - _Requirements: 6.3_

- [x] 2. Update inbound shim import sources
  - [x] 2.1 Update `src/inbound/client.ts` to import from `../upstream/codex/client`
    - Change `export { CodexStandaloneClient } from "../client"` to `export { CodexStandaloneClient } from "../upstream/codex/client"`
    - _Requirements: 1.2_

  - [x] 2.2 Update `src/inbound/constants.ts` to import from `../core/constants`
    - Change `export { LOG_BODY_PREVIEW_LIMIT } from "../constants"` to `export { LOG_BODY_PREVIEW_LIMIT } from "../core/constants"`
    - _Requirements: 1.3_

  - [x] 2.3 Update `src/inbound/reasoning.ts` to import from provider directories
    - Replace single re-export from `"../reasoning"` with two separate re-exports:
      - `export { normalizeReasoningBody } from "../core/reasoning"`
      - `export { normalizeRequestBody } from "./openai/normalize"`
    - Exact_Export_Surface must remain: `normalizeReasoningBody`, `normalizeRequestBody`
    - _Requirements: 1.4_

  - [x] 2.4 Verify build passes after inbound shim updates
    - Run `bun run build` and confirm success
    - _Requirements: 6.3_

- [x] 3. Update `src/inbound/claude/handlers.ts` imports
  - [x] 3.1 Update handler imports to point directly to provider directories
    - Change `import { LOG_BODY_PREVIEW_LIMIT } from "../constants"` to `import { LOG_BODY_PREVIEW_LIMIT } from "../../core/constants"`
    - Change `import type { CodexStandaloneClient } from "../client"` to `import type { CodexStandaloneClient } from "../../upstream/codex/client"`
    - Change `import { normalizeReasoningBody } from "../reasoning"` to `import { normalizeReasoningBody } from "../../core/reasoning"`
    - Keep `import type { ... } from "../types"` unchanged — this is `src/inbound/types.ts`, not a root shim
    - _Requirements: 1.5_

  - [x] 3.2 Verify build passes after handler update
    - Run `bun run build` and confirm success
    - _Requirements: 6.3_

- [x] 4. Checkpoint - Verify core changes
  - Ensure all tests pass, ask the user if questions arise.
  - Run `bun test test/core/ test/inbound/ test/upstream/ test/backward-compat.test.ts` and confirm 0 failures
  - _Requirements: 6.2_

- [x] 5. Update UI file imports
  - [x] 5.1 Update `src/ui/app.tsx` imports to point to provider directories
    - Change `from "../account-info"` to `from "../upstream/codex/account-info"`
    - Change `from "../auth"` to `from "../upstream/codex/auth"`
    - Change `from "../client"` to `from "../upstream/codex/client"`
    - Change `from "../connect-account"` to `from "../upstream/codex/connect-account"`
    - Change `from "../paths"` to `from "../core/paths"`
    - Change `from "../request-logs"` to `from "../core/request-logs"`
    - Change `from "../types"` to appropriate provider directory imports — split into `from "../core/types"` and `from "../upstream/codex/types"` based on which types are used
    - Keep `from "../runtime"`, `from "../package-info"`, `from "../cli"` unchanged — these are composition root files, not shims
    - _Requirements: 1.6_

  - [x] 5.2 Update `src/ui/accounts.ts` imports to point to provider directories
    - Change `from "../auth"` to `from "../upstream/codex/auth"`
    - Change `from "../account-info"` to `from "../upstream/codex/account-info"`
    - Change `from "../types"` to `from "../upstream/codex/types"` (uses `AuthFileContent`, `AuthFileData`)
    - _Requirements: 1.6_

  - [x] 5.3 Update `src/ui/limits.ts` imports to point to provider directories
    - Change `from "../account-info"` to `from "../upstream/codex/account-info"` (uses `AccountInfo` type)
    - _Requirements: 1.6_

  - [x] 5.4 Update `src/ui/claude-env.ts` imports to point to provider directories
    - Change `from "../claude-code-env.config"` to `from "../inbound/claude/claude-code-env.config"`
    - Change `from "../paths"` to `from "../core/paths"`
    - _Requirements: 1.6_

  - [x] 5.5 Verify build passes after UI file updates
    - Run `bun run build` and confirm success
    - _Requirements: 6.3_

- [x] 6. Update `src/index.ts` (Public API Barrel) to re-export from provider directories
  - [x] 6.1 Replace all root shim re-exports with direct provider directory re-exports
    - Replace `export * from "./types"` with explicit type re-exports from `./core/types`, `./upstream/codex/types`, `./inbound/claude/types` — use `export type { ... }` with the exact symbol list from the baseline
    - Replace `export * from "./account-info"` with `export * from "./upstream/codex/account-info"`
    - Replace `export * from "./auth"` with `export * from "./upstream/codex/auth"`
    - Replace `export * from "./client"` with `export { CodexStandaloneClient } from "./upstream/codex/client"`
    - Replace `export * from "./reasoning"` with `export { normalizeReasoningBody } from "./core/reasoning"` and `export { normalizeRequestBody } from "./inbound/openai/normalize"`
    - Keep `export * from "./cli"`, `export * from "./package-info"`, `export * from "./runtime"` unchanged — these are composition root files
    - Update the `runExample()` function imports: change `from "./client"` to `from "./upstream/codex/client"`, change `from "./paths"` to `from "./core/paths"`, change `from "./runtime"` to keep as-is (composition root)
    - `src/index.ts` must NOT import from any Root_Shim after this change
    - _Requirements: 1.7, 5.1, 5.2, 5.3, 5.4_

  - [x] 6.2 Verify the export surface of `src/index.ts` matches the baseline exactly
    - The baseline lists 42 exports for `src/index` — verify all are present after the update
    - Run `bun run build` and confirm success
    - _Requirements: 5.1, 5.2, 6.3_

- [x] 7. Checkpoint - Full verification
  - Ensure all tests pass, ask the user if questions arise.
  - Run `bun run build` and confirm success
  - Run `bun run test` (stable suite, 84+ tests) and confirm 0 failures
  - Run `bun test test/core/ test/inbound/ test/upstream/ test/backward-compat.test.ts` and confirm 0 failures
  - _Requirements: 6.1, 6.2, 6.3_

- [x] 8. Write property-based tests for consolidation correctness
  - [x] 8.1 Install `fast-check` as a dev dependency
    - Run `bun add -d fast-check`
    - _Requirements: 6.2_

  - [x] 8.2 Write property test: No internal consumer imports from shim paths
    - Create `test/core/consolidation.property.test.ts`
    - **Property 1: No internal consumer imports from shim paths**
    - Use `fast-check` to randomly select internal consumer files (excluding shim files, test files, and composition root files)
    - For each selected file, parse its import/export-from statements and verify none reference root shim module paths (`src/account-info`, `src/auth`, `src/client`, `src/codex-auth`, `src/connect-account`, `src/constants`, `src/http`, `src/models`, `src/paths`, `src/reasoning`, `src/request-logs`, `src/types`)
    - Minimum 100 iterations
    - **Validates: Requirements 1.1, 1.6, 1.7, 5.4**

  - [x] 8.3 Write property test: All shim export surfaces preserved
    - Add to `test/core/consolidation.property.test.ts`
    - **Property 2: All shim export surfaces preserved**
    - Use `fast-check` to randomly select shim files from the backward-compat baseline (12 root shims + 10 legacy claude shims + `src/claude.ts`)
    - For each selected shim, extract export names using `test/export-surface.ts` utility and verify they match exactly with the baseline — no symbols added, no symbols removed
    - Minimum 100 iterations
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 2.4**

  - [x] 8.4 Write property test: All baseline modules remain importable with correct exports
    - Add to `test/core/consolidation.property.test.ts`
    - **Property 3: All baseline modules remain importable with correct exports**
    - Use `fast-check` to randomly select module entries from `test/backward-compat-baseline.json`
    - For each selected module, dynamically import the file at `module.file` and verify all symbols listed in `module.exports` are present
    - Minimum 100 iterations
    - **Validates: Requirements 4.1, 4.3, 4.4, 5.1, 5.2**

- [x] 9. Final checkpoint - Full test suite
  - Ensure all tests pass, ask the user if questions arise.
  - Run `bun run build` and confirm success
  - Run `bun run test` (stable suite, 84+ tests) and confirm 0 failures
  - Run `bun test test/core/ test/inbound/ test/upstream/ test/backward-compat.test.ts` and confirm 0 failures
  - Verify backward-compat baseline file (`test/backward-compat-baseline.json`) has NOT been modified
  - _Requirements: 4.1, 4.2, 6.1, 6.2, 6.3, 6.4_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation after each major phase
- Property tests validate universal correctness properties from the design document using fast-check with minimum 100 iterations
- The project uses `bun` as runtime and test runner — use `bun run test` for the stable suite, and `bun test test/core/ test/inbound/ test/upstream/ test/backward-compat.test.ts` for new and provider-specific tests
- The safe execution order (move file → inbound shims → handler → UI files → barrel → full test) minimizes risk of cascading failures
- All 12 root shims + 10 legacy claude shims must be preserved with exact export surfaces
- The backward-compat baseline (`test/backward-compat-baseline.json`) must NOT be modified
