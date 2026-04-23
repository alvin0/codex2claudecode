# Requirements Document

## Introduction

Spec trước (`consolidate-root-shims`) đã cập nhật tất cả internal consumer để import trực tiếp từ Provider_Directory (`src/core/`, `src/upstream/codex/`, `src/inbound/claude/`, `src/inbound/openai/`). Tuy nhiên, tất cả 14 Root_Shim_File và 10 Legacy_Claude_Shim vẫn được giữ nguyên tại vị trí cũ cho backward compatibility.

Mục tiêu của spec này là **xóa hoàn toàn tất cả file `.ts` nằm trực tiếp trong `src/`** (ngoại trừ `src/index.ts`) để thư mục `src/` chỉ chứa subdirectory. Cụ thể:

1. **Xóa 14 Root_Shim_File** — không còn internal consumer nào import từ đây, chỉ còn external consumer và test file
2. **Xóa thư mục `src/claude/`** với 10 Legacy_Claude_Shim
3. **Di chuyển 5 Composition_Root_File** (`bin.ts`, `bootstrap.ts`, `cli.ts`, `package-info.ts`, `runtime.ts`) vào subdirectory phù hợp
4. **Cập nhật Backward_Compat_Baseline** để phản ánh cấu trúc mới
5. **Cập nhật tất cả test file và entry point** import từ các file bị xóa/di chuyển

### Phân loại 19 file root-level (không kể `index.ts`)

**14 Root_Shim_File** (chỉ chứa re-export, không có logic):
- `account-info.ts`, `auth.ts`, `client.ts`, `codex-auth.ts`, `connect-account.ts`, `constants.ts`, `http.ts`, `models.ts`, `paths.ts`, `reasoning.ts`, `request-logs.ts`, `types.ts` — 12 shim gốc
- `claude-code-env.config.ts` — shim tạo bởi spec trước (re-export từ `./inbound/claude/`)
- `claude.ts` — shim re-export từ `./inbound/claude/handlers`

**5 Composition_Root_File** (chứa logic thực):
- `bin.ts` — CLI entry point
- `bootstrap.ts` — server bootstrap logic
- `cli.ts` — CLI argument parser
- `package-info.ts` — package metadata utility
- `runtime.ts` — runtime server logic

**10 Legacy_Claude_Shim** (thư mục `src/claude/`):
- `convert.ts`, `errors.ts`, `handlers.ts`, `index.ts`, `mcp.ts`, `response.ts`, `server-tool-adapter.ts`, `server-tools.ts`, `sse.ts`, `web.ts`

### Tác động đến consumer

- **Test file** import trực tiếp từ root shim path (ví dụ: `../src/client`, `../src/constants`, `../src/claude/convert`) — cần cập nhật
- **Root `index.ts`** import từ `./src/cli` — cần cập nhật
- **`src/bin.ts`** import từ `./cli`, `./index`, `./ui` — cần cập nhật sau khi di chuyển
- **`src/index.ts`** đã import trực tiếp từ Provider_Directory (sau consolidation), nhưng vẫn re-export từ `./cli`, `./package-info`, `./runtime` — cần cập nhật
- **External consumer** import qua package name (`codex2claudecode`) sẽ không bị ảnh hưởng vì `src/index.ts` vẫn là barrel export

## Glossary

- **Root_Shim_File**: File TypeScript nằm trực tiếp trong `src/` chỉ chứa câu lệnh re-export, không có logic riêng. Bao gồm 12 shim gốc + `claude-code-env.config.ts` + `claude.ts` = 14 file
- **Legacy_Claude_Shim**: File TypeScript trong thư mục `src/claude/` re-export từ `src/inbound/claude/` hoặc `src/core/`. Tổng cộng 10 file
- **Composition_Root_File**: File TypeScript nằm trực tiếp trong `src/` chứa logic thực sự — không phải shim. Gồm: `bin.ts`, `bootstrap.ts`, `cli.ts`, `package-info.ts`, `runtime.ts`
- **Backward_Compat_Baseline**: File JSON tại `test/backward-compat-baseline.json` ghi lại tất cả module path importable và exported symbol
- **Backward_Compat_Test**: Test suite tại `test/backward-compat.test.ts` kiểm tra mọi module trong baseline vẫn importable với đúng export surface
- **Public_API_Barrel**: File `src/index.ts` — barrel export chính của package, file duy nhất được giữ lại tại root `src/`
- **Provider_Directory**: Thư mục con theo kiến trúc provider-agnostic: `src/core/`, `src/upstream/codex/`, `src/inbound/claude/`, `src/inbound/openai/`
- **App_Directory**: Thư mục `src/app/` — vị trí đích cho các Composition_Root_File sau khi di chuyển
- **Root_Entry**: File `index.ts` tại root project — entry point chính, re-export từ `src/index.ts` và chạy CLI

## Requirements

### Requirement 1: Xóa tất cả Root_Shim_File

**User Story:** Là developer, tôi muốn xóa tất cả shim file tại root `src/` vì không còn internal consumer nào import từ đây, để giảm clutter và loại bỏ dead code.

#### Acceptance Criteria

1. THE Removal_System SHALL xóa 14 Root_Shim_File sau đây khỏi `src/`: `account-info.ts`, `auth.ts`, `client.ts`, `codex-auth.ts`, `connect-account.ts`, `constants.ts`, `http.ts`, `models.ts`, `paths.ts`, `reasoning.ts`, `request-logs.ts`, `types.ts`, `claude-code-env.config.ts`, `claude.ts`
2. WHEN một Root_Shim_File bị xóa, THE Removal_System SHALL cập nhật tất cả test file import từ path tương ứng để trỏ trực tiếp đến Provider_Directory chứa symbol gốc
3. WHEN `src/constants.ts` bị xóa, THE Removal_System SHALL cập nhật `test/runtime.test.ts` để import `LOG_BODY_PREVIEW_LIMIT` từ `../src/core/constants`
4. WHEN `src/http.ts` bị xóa, THE Removal_System SHALL cập nhật `test/runtime.test.ts` để import `cors`, `responseHeaders` từ `../src/core/http`
5. WHEN `src/request-logs.ts` bị xóa, THE Removal_System SHALL cập nhật `test/runtime.test.ts` và `test/request-logs.test.ts` để import từ `../src/core/request-logs`
6. WHEN `src/types.ts` bị xóa, THE Removal_System SHALL cập nhật `test/request-logs.test.ts` để import `RequestLogEntry` từ `../src/core/types`
7. WHEN `src/client.ts` bị xóa, THE Removal_System SHALL cập nhật `test/client.test.ts` và `test/live.test.ts` để import `CodexStandaloneClient` từ `../src/upstream/codex/client`
8. WHEN `src/account-info.ts` bị xóa, THE Removal_System SHALL cập nhật `test/account-info.test.ts` để import từ `../src/upstream/codex/account-info`
9. WHEN `src/connect-account.ts` bị xóa, THE Removal_System SHALL cập nhật `test/connect-account.test.ts` để import từ `../src/upstream/codex/connect-account`
10. WHEN `src/claude-code-env.config.ts` bị xóa, THE Removal_System SHALL cập nhật `test/claude-env.test.ts` để import `CLAUDE_CODE_ENV_CONFIG` từ `../src/inbound/claude/claude-code-env.config`

### Requirement 2: Xóa thư mục `src/claude/` và tất cả Legacy_Claude_Shim

**User Story:** Là developer, tôi muốn xóa thư mục `src/claude/` chứa 10 legacy shim file vì tất cả logic thực đã nằm trong `src/inbound/claude/` và `src/core/`.

#### Acceptance Criteria

1. THE Removal_System SHALL xóa toàn bộ thư mục `src/claude/` bao gồm 10 file: `convert.ts`, `errors.ts`, `handlers.ts`, `index.ts`, `mcp.ts`, `response.ts`, `server-tool-adapter.ts`, `server-tools.ts`, `sse.ts`, `web.ts`
2. WHEN một Legacy_Claude_Shim bị xóa, THE Removal_System SHALL cập nhật tất cả test file import từ `../src/claude/...` để trỏ trực tiếp đến `../src/inbound/claude/...` hoặc `../src/core/...` (riêng `sse.ts` re-export từ `src/core/sse`)
3. WHEN `src/claude/convert.ts` bị xóa, THE Removal_System SHALL cập nhật `test/claude.test.ts` để import `claudeToResponsesBody`, `countClaudeInputTokens` từ `../src/inbound/claude/convert`
4. WHEN `src/claude/errors.ts` bị xóa, THE Removal_System SHALL cập nhật `test/claude.test.ts` để import `claudeErrorResponse` từ `../src/inbound/claude/errors`
5. WHEN `src/claude/handlers.ts` bị xóa, THE Removal_System SHALL cập nhật `test/claude.test.ts` để import `handleClaudeCountTokens`, `handleClaudeMessages` từ `../src/inbound/claude/handlers`
6. WHEN `src/claude/response.ts` bị xóa, THE Removal_System SHALL cập nhật `test/claude.test.ts` để import `collectClaudeMessage`, `claudeStreamResponse` từ `../src/inbound/claude/response`
7. WHEN `src/claude/sse.ts` bị xóa, THE Removal_System SHALL cập nhật `test/claude.test.ts` để import `consumeCodexSse`, `parseJsonObject`, `parseSseJson` từ `../src/core/sse`
8. WHEN `src/claude/web.ts` bị xóa, THE Removal_System SHALL cập nhật `test/claude.test.ts` để import từ `../src/inbound/claude/web`
9. WHEN `src/claude/server-tools.ts` bị xóa, THE Removal_System SHALL cập nhật `test/claude.test.ts` để import từ `../src/inbound/claude/server-tools`

### Requirement 3: Di chuyển Composition_Root_File vào `src/app/`

**User Story:** Là developer, tôi muốn các file chứa logic cross-cutting (CLI, bootstrap, runtime) nằm trong subdirectory `src/app/` thay vì root `src/` để cấu trúc thư mục nhất quán — chỉ `src/index.ts` tồn tại tại root.

#### Acceptance Criteria

1. THE Removal_System SHALL di chuyển 5 Composition_Root_File vào `src/app/`: `bin.ts` → `src/app/bin.ts`, `bootstrap.ts` → `src/app/bootstrap.ts`, `cli.ts` → `src/app/cli.ts`, `package-info.ts` → `src/app/package-info.ts`, `runtime.ts` → `src/app/runtime.ts`
2. WHEN `src/bin.ts` được di chuyển sang `src/app/bin.ts`, THE Removal_System SHALL cập nhật import path bên trong file: `./cli` → `./cli`, `./index` → `../index`, `./ui` → `../ui`
3. WHEN `src/bootstrap.ts` được di chuyển sang `src/app/bootstrap.ts`, THE Removal_System SHALL cập nhật import path bên trong file: `./core/paths` → `../core/paths`, `./core/registry` → `../core/registry`, `./core/types` → `../core/types`, `./inbound/claude` → `../inbound/claude`, `./inbound/openai` → `../inbound/openai`, `./upstream/codex` → `../upstream/codex`
4. WHEN `src/runtime.ts` được di chuyển sang `src/app/runtime.ts`, THE Removal_System SHALL cập nhật import path bên trong file: `./bootstrap` → `./bootstrap`, `./core/constants` → `../core/constants`, `./core/http` → `../core/http`, `./core/interfaces` → `../core/interfaces`, `./core/request-logs` → `../core/request-logs`, `./core/types` → `../core/types`
5. WHEN `src/package-info.ts` được di chuyển sang `src/app/package-info.ts`, THE Removal_System SHALL đảm bảo đường dẫn đọc `package.json` vẫn chính xác — path tương đối từ `src/app/` đến root là `../..` thay vì `..`
6. WHEN Composition_Root_File được di chuyển, THE Removal_System SHALL cập nhật `src/index.ts` để re-export từ `./app/cli`, `./app/package-info`, `./app/runtime` thay vì `./cli`, `./package-info`, `./runtime`
7. WHEN Composition_Root_File được di chuyển, THE Removal_System SHALL cập nhật Root_Entry (`index.ts` tại root project) để import `parseCliOptions` từ `./src/app/cli` thay vì `./src/cli`
8. WHEN Composition_Root_File được di chuyển, THE Removal_System SHALL cập nhật test file tương ứng: `test/cli.test.ts` import từ `../src/app/cli`, `test/package-info.test.ts` import từ `../src/app/package-info`, `test/runtime.test.ts` import `startRuntime` từ `../src/app/runtime`, `test/runtime-registry.test.ts` import `startRuntimeWithBootstrap` từ `../src/app/runtime`

### Requirement 4: Cập nhật Backward_Compat_Baseline

**User Story:** Là developer, tôi muốn Backward_Compat_Baseline phản ánh chính xác cấu trúc file mới sau khi xóa shim và di chuyển file, để test backward compat tiếp tục hoạt động.

#### Acceptance Criteria

1. THE Removal_System SHALL xóa tất cả entry trong Backward_Compat_Baseline có `file` trỏ đến Root_Shim_File đã bị xóa: `src/account-info.ts`, `src/auth.ts`, `src/client.ts`, `src/codex-auth.ts`, `src/connect-account.ts`, `src/constants.ts`, `src/http.ts`, `src/models.ts`, `src/paths.ts`, `src/reasoning.ts`, `src/request-logs.ts`, `src/types.ts`, `src/claude-code-env.config.ts`, `src/claude.ts`
2. THE Removal_System SHALL xóa tất cả entry trong Backward_Compat_Baseline có `file` trỏ đến Legacy_Claude_Shim đã bị xóa: `src/claude/convert.ts`, `src/claude/errors.ts`, `src/claude/handlers.ts`, `src/claude/index.ts`, `src/claude/mcp.ts`, `src/claude/response.ts`, `src/claude/server-tool-adapter.ts`, `src/claude/server-tools.ts`, `src/claude/sse.ts`, `src/claude/web.ts`
3. THE Removal_System SHALL cập nhật entry cho Composition_Root_File đã di chuyển: `src/bin.ts` → `src/app/bin.ts`, `src/cli.ts` → `src/app/cli.ts`, `src/package-info.ts` → `src/app/package-info.ts`, `src/runtime.ts` → `src/app/runtime.ts` — cập nhật cả trường `path` và `file`
4. THE Removal_System SHALL giữ nguyên entry cho `src/index.ts` với đầy đủ export surface hiện tại
5. THE Removal_System SHALL giữ nguyên tất cả entry cho file trong Provider_Directory (`src/core/`, `src/upstream/codex/`, `src/inbound/claude/`, `src/inbound/openai/`) và `src/ui/`
6. THE Removal_System SHALL cập nhật Backward_Compat_Test để phản ánh cấu trúc mới — xóa các test case tham chiếu đến file đã bị xóa trong phần "specific compatibility re-exports"

### Requirement 5: Đảm bảo `src/index.ts` (Public_API_Barrel) ổn định

**User Story:** Là consumer của package, tôi muốn import từ `codex2claudecode` vẫn hoạt động đúng sau khi xóa shim và di chuyển file.

#### Acceptance Criteria

1. THE Removal_System SHALL đảm bảo `src/index.ts` export đúng tập symbol như trước khi thực hiện spec này — không thêm, không bớt symbol nào
2. WHEN Composition_Root_File được di chuyển, THE Removal_System SHALL cập nhật `src/index.ts` để re-export từ path mới: `export * from "./app/cli"`, `export * from "./app/package-info"`, `export * from "./app/runtime"`
3. THE Removal_System SHALL đảm bảo hàm `runExample()` trong `src/index.ts` vẫn hoạt động đúng
4. AFTER tất cả thay đổi, THE Removal_System SHALL verify export surface của `src/index.ts` khớp chính xác với baseline entry cho `src/index`

### Requirement 6: Đảm bảo thư mục `src/` chỉ chứa `index.ts` và subdirectory

**User Story:** Là developer, tôi muốn sau khi hoàn thành spec này, thư mục `src/` không còn file `.ts` nào ngoài `index.ts` — tất cả code nằm trong subdirectory.

#### Acceptance Criteria

1. AFTER tất cả thay đổi hoàn tất, THE Removal_System SHALL đảm bảo thư mục `src/` chỉ chứa đúng 1 file `.ts`: `src/index.ts`
2. AFTER tất cả thay đổi hoàn tất, THE Removal_System SHALL đảm bảo thư mục `src/claude/` không còn tồn tại
3. AFTER tất cả thay đổi hoàn tất, THE Removal_System SHALL đảm bảo các subdirectory sau tồn tại: `src/app/`, `src/core/`, `src/inbound/`, `src/upstream/`, `src/ui/`

### Requirement 7: Toàn bộ test suite phải pass

**User Story:** Là developer, tôi muốn đảm bảo không có regression nào sau khi xóa shim và di chuyển file.

#### Acceptance Criteria

1. THE Removal_System SHALL đảm bảo `bun run build` thành công
2. THE Removal_System SHALL đảm bảo `bun run test` pass với 0 failure
3. THE Removal_System SHALL đảm bảo `bun test test/backward-compat.test.ts` pass với 0 failure (sau khi cập nhật baseline)
4. THE Removal_System SHALL đảm bảo tất cả property-based test trong `test/core/consolidation.property.test.ts` pass — cập nhật test nếu cần để phản ánh cấu trúc mới (ví dụ: loại bỏ shim file khỏi danh sách kiểm tra)
