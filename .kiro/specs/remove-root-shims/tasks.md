# Implementation Plan: Remove Root Shims

## Overview

Complete the `src/` cleanup by deleting all 14 Root_Shim_File, the `src/claude/` directory (10 Legacy_Claude_Shim), and moving 5 Composition_Root_File into `src/app/`. The execution order ensures the build stays green between each phase: move files first, update barrel and entry points, verify build, update tests, delete shims, update baseline and property tests, then verify the full test suite.

## Tasks

- [x] 1. Create `src/app/` and move Composition_Root_File with updated internal imports
  - [x] 1.1 Move `src/cli.ts` to `src/app/cli.ts`
    - No relative imports to update — file has no relative import statements
    - _Requirements: 3.1_

  - [x] 1.2 Move `src/package-info.ts` to `src/app/package-info.ts`
    - Update the `package.json` path from `".."` to `"../.."` (now two levels deep from `src/app/`)
    - _Requirements: 3.1, 3.5_

  - [x] 1.3 Move `src/bootstrap.ts` to `src/app/bootstrap.ts`
    - Update internal imports: `./core/paths` → `../core/paths`, `./core/registry` → `../core/registry`, `./core/types` → `../core/types`, `./inbound/claude` → `../inbound/claude`, `./inbound/openai` → `../inbound/openai`, `./upstream/codex` → `../upstream/codex`
    - _Requirements: 3.1, 3.3_

  - [x] 1.4 Move `src/runtime.ts` to `src/app/runtime.ts`
    - Update internal imports: `./bootstrap` → `./bootstrap` (same dir, no change), `./core/constants` → `../core/constants`, `./core/http` → `../core/http`, `./core/interfaces` → `../core/interfaces`, `./core/request-logs` → `../core/request-logs`, `./core/types` → `../core/types`
    - _Requirements: 3.1, 3.4_

  - [x] 1.5 Move `src/bin.ts` to `src/app/bin.ts`
    - Update internal imports: `./cli` → `./cli` (same dir, no change), `./index` → `../index`, `./ui` → `../ui`
    - _Requirements: 3.1, 3.2_

- [x] 2. Update barrel and entry point imports
  - [x] 2.1 Update `src/index.ts` to re-export from `./app/` paths
    - Change `export * from "./cli"` → `export * from "./app/cli"`
    - Change `export * from "./package-info"` → `export * from "./app/package-info"`
    - Change `export * from "./runtime"` → `export * from "./app/runtime"`
    - _Requirements: 3.6, 5.1, 5.2_

  - [x] 2.2 Update Root_Entry (`index.ts` at project root)
    - Change `import { parseCliOptions } from "./src/cli"` → `import { parseCliOptions } from "./src/app/cli"`
    - _Requirements: 3.7_

- [x] 3. Checkpoint — Verify build passes
  - Run `bun run build` and ensure exit code 0
  - Ensure all composition root files are correctly wired after the move
  - _Requirements: 7.1_

- [x] 4. Update test file imports for moved Composition_Root_File
  - [x] 4.1 Update `test/cli.test.ts`
    - Change `import { parseCliOptions } from "../src/cli"` → `from "../src/app/cli"`
    - _Requirements: 3.8_

  - [x] 4.2 Update `test/package-info.test.ts`
    - Change `import { packageInfo } from "../src/package-info"` → `from "../src/app/package-info"`
    - _Requirements: 3.8_

  - [x] 4.3 Update `test/runtime.test.ts` — composition root imports
    - Change `import { startRuntime } from "../src/runtime"` → `from "../src/app/runtime"`
    - _Requirements: 3.8_

  - [x] 4.4 Update `test/runtime-registry.test.ts`
    - Change `import { startRuntimeWithBootstrap } from "../src/runtime"` → `from "../src/app/runtime"`
    - Update source code content check paths: `path.join(process.cwd(), "src", "runtime.ts")` → `path.join(process.cwd(), "src", "app", "runtime.ts")` and `"src", "bootstrap.ts"` → `"src", "app", "bootstrap.ts"`
    - Update expected import assertions: `from "./claude"` → `from "./claude"` (keep), `from "./inbound/"` → `from "./inbound/"` (keep), `from "./upstream/"` → `from "./upstream/"` (keep); update bootstrap assertions: `from "./inbound/claude"` → `from "../inbound/claude"`, `from "./inbound/openai"` → `from "../inbound/openai"`, `from "./upstream/codex"` → `from "../upstream/codex"`
    - _Requirements: 3.8_

- [x] 5. Update test file imports for Root_Shim_File being deleted
  - [x] 5.1 Update `test/runtime.test.ts` — shim imports
    - Change `import { LOG_BODY_PREVIEW_LIMIT } from "../src/constants"` → `from "../src/core/constants"`
    - Change `import { cors, responseHeaders } from "../src/http"` → `from "../src/core/http"`
    - Change `import { requestLogFilePath } from "../src/request-logs"` → `from "../src/core/request-logs"`
    - _Requirements: 1.3, 1.4, 1.5_

  - [x] 5.2 Update `test/request-logs.test.ts`
    - Change `from "../src/request-logs"` → `from "../src/core/request-logs"`
    - Change `import type { RequestLogEntry } from "../src/types"` → `from "../src/core/types"`
    - _Requirements: 1.5, 1.6_

  - [x] 5.3 Update `test/client.test.ts`
    - Change `import { CodexStandaloneClient } from "../src/client"` → `from "../src/upstream/codex/client"`
    - _Requirements: 1.7_

  - [x] 5.4 Update `test/live.test.ts`
    - Change `import { CodexStandaloneClient } from "../src/client"` → `from "../src/upstream/codex/client"`
    - _Requirements: 1.7_

  - [x] 5.5 Update `test/account-info.test.ts`
    - Change all imports from `"../src/account-info"` → `"../src/upstream/codex/account-info"`
    - _Requirements: 1.8_

  - [x] 5.6 Update `test/connect-account.test.ts`
    - Change `import { connectAccount, connectAccountFromCodexAuth } from "../src/connect-account"` → `from "../src/upstream/codex/connect-account"`
    - _Requirements: 1.9_

  - [x] 5.7 Update `test/claude-env.test.ts`
    - Change `import { CLAUDE_CODE_ENV_CONFIG } from "../src/claude-code-env.config"` → `from "../src/inbound/claude/claude-code-env.config"`
    - _Requirements: 1.10_

  - [x] 5.8 Update `test/claude.test.ts` — Legacy_Claude_Shim imports
    - Change `from "../src/claude/convert"` → `from "../src/inbound/claude/convert"`
    - Change `from "../src/claude/errors"` → `from "../src/inbound/claude/errors"`
    - Change `from "../src/claude/handlers"` → `from "../src/inbound/claude/handlers"`
    - Change `from "../src/claude/response"` → `from "../src/inbound/claude/response"`
    - Change `from "../src/claude/sse"` → `from "../src/core/sse"`
    - Change `from "../src/claude/web"` → `from "../src/inbound/claude/web"`
    - Change `from "../src/claude/server-tools"` → `from "../src/inbound/claude/server-tools"`
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

- [x] 6. Delete Root_Shim_File and `src/claude/` directory
  - [x] 6.1 Delete 14 Root_Shim_File
    - Delete: `src/account-info.ts`, `src/auth.ts`, `src/client.ts`, `src/codex-auth.ts`, `src/connect-account.ts`, `src/constants.ts`, `src/http.ts`, `src/models.ts`, `src/paths.ts`, `src/reasoning.ts`, `src/request-logs.ts`, `src/types.ts`, `src/claude-code-env.config.ts`, `src/claude.ts`
    - _Requirements: 1.1, 6.1_

  - [x] 6.2 Delete `src/claude/` directory (10 Legacy_Claude_Shim)
    - Delete entire directory: `src/claude/convert.ts`, `src/claude/errors.ts`, `src/claude/handlers.ts`, `src/claude/index.ts`, `src/claude/mcp.ts`, `src/claude/response.ts`, `src/claude/server-tool-adapter.ts`, `src/claude/server-tools.ts`, `src/claude/sse.ts`, `src/claude/web.ts`
    - _Requirements: 2.1, 6.2_

- [x] 7. Checkpoint — Verify build passes after deletion
  - Run `bun run build` and ensure exit code 0
  - Verify `src/` only contains `index.ts` and subdirectories: `app/`, `core/`, `inbound/`, `upstream/`, `ui/`
  - _Requirements: 6.1, 6.2, 6.3, 7.1_

- [x] 8. Update backward compatibility baseline and tests
  - [x] 8.1 Update `test/backward-compat-baseline.json`
    - Remove 14 Root_Shim_File entries: `src/account-info.ts`, `src/auth.ts`, `src/client.ts`, `src/codex-auth.ts`, `src/connect-account.ts`, `src/constants.ts`, `src/http.ts`, `src/models.ts`, `src/paths.ts`, `src/reasoning.ts`, `src/request-logs.ts`, `src/types.ts`, `src/claude-code-env.config.ts`, `src/claude.ts`
    - Remove 10 Legacy_Claude_Shim entries: `src/claude/convert.ts`, `src/claude/errors.ts`, `src/claude/handlers.ts`, `src/claude/index.ts`, `src/claude/mcp.ts`, `src/claude/response.ts`, `src/claude/server-tool-adapter.ts`, `src/claude/server-tools.ts`, `src/claude/sse.ts`, `src/claude/web.ts`
    - Update 4 Composition_Root_File entries: `src/bin` → `src/app/bin` (file: `src/app/bin.ts`), `src/cli` → `src/app/cli` (file: `src/app/cli.ts`), `src/package-info` → `src/app/package-info` (file: `src/app/package-info.ts`), `src/runtime` → `src/app/runtime` (file: `src/app/runtime.ts`)
    - Keep `src/index.ts`, all Provider_Directory entries, and all `src/ui/` entries unchanged
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 8.2 Update `test/backward-compat.test.ts`
    - Remove all entries in the "specific compatibility re-exports" test case that reference deleted files: `src/client.ts`, `src/http.ts`, `src/request-logs.ts`, `src/constants.ts`, `src/auth.ts`, `src/reasoning.ts`, `src/account-info.ts`, `src/codex-auth.ts`, `src/connect-account.ts`, `src/models.ts`, `src/claude/convert.ts`, `src/claude/errors.ts`, `src/claude/handlers.ts`, `src/claude/response.ts`, `src/claude/sse.ts`, `src/claude/web.ts`, `src/claude/server-tools.ts`, `src/claude/server-tool-adapter.ts`, `src/claude/mcp.ts`
    - _Requirements: 4.6_

- [x] 9. Update `test/core/consolidation.property.test.ts`
  - Update `ROOT_SHIM_MODULES` set — remove all entries (no more root shims exist)
  - Update `SHIM_FILES` set — remove all 14 root shim entries and 10 legacy claude shim entries; keep the 3 `src/inbound/` shim entries if they still exist
  - Update `COMPOSITION_ROOT_FILES` set — change paths from `src/bin.ts` → `src/app/bin.ts`, `src/bootstrap.ts` → `src/app/bootstrap.ts`, `src/cli.ts` → `src/app/cli.ts`, `src/package-info.ts` → `src/app/package-info.ts`, `src/runtime.ts` → `src/app/runtime.ts`
  - Remove `SHIM_BASELINE_FILES` set entirely (no more shim files in baseline)
  - Remove Property 2 test ("All shim export surfaces preserved") entirely — no shim files remain to verify
  - Keep Property 1 ("No internal consumer imports from shim paths") — update to reflect new file structure
  - Keep Property 3 ("All baseline modules remain importable with correct exports") — works with updated baseline
  - _Requirements: 7.4_

- [x] 9.1 Write property test for no imports from deleted paths
    - **Property 1: No source or test file imports from deleted paths**
    - Verify no TypeScript file imports from any of the 14 root shim paths, 10 legacy claude shim paths, or 5 old composition root paths
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.7, 3.8**

- [x] 9.2 Write property test for public API barrel export surface
    - **Property 2: Public API barrel export surface preserved**
    - For any symbol in the baseline entry for `src/index`, verify it exists in the actual export surface of `src/index.ts`
    - **Validates: Requirements 5.1, 5.2, 5.4**

- [x] 9.3 Write property test for baseline module importability
    - **Property 3: All baseline modules remain importable with correct exports**
    - For any module entry in the updated baseline, dynamically import the file and verify all expected exports are present
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 7.3**

- [x] 10. Final checkpoint — Verify full test suite
  - Run `bun run build` and ensure exit code 0
  - Run `bun run test` and ensure 0 failures
  - Run `bun test test/backward-compat.test.ts` and ensure 0 failures
  - Run `bun test test/core/consolidation.property.test.ts` and ensure 0 failures
  - Verify `src/` directory structure: only `index.ts` + 5 subdirectories (`app/`, `core/`, `inbound/`, `upstream/`, `ui/`)
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 6.1, 6.2, 6.3, 7.1, 7.2, 7.3, 7.4_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The execution order is critical: move files → update barrel/entry → verify build → update test imports → delete shims → update baseline → verify full suite
- Each checkpoint ensures the build stays green between phases
- Property tests validate universal correctness properties from the design document
- The design uses TypeScript throughout — all code examples use TypeScript/Bun
