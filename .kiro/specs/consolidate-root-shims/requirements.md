# Requirements Document

## Introduction

Dự án codex2claudecode hiện có ~19 file nằm ở root của `src/`. Phần lớn là re-export shim được tạo trong quá trình refactor provider-agnostic (Phase 7 của spec trước). Ngoài ra, thư mục `src/claude/` chứa ~10 file shim re-export — phần lớn từ `src/inbound/claude/`, ngoại trừ `src/claude/sse.ts` re-export từ `src/core/sse`.

Mục tiêu là:
1. Cập nhật tất cả Internal_Consumer để import trực tiếp từ Provider_Directory thay vì đi qua shim
2. Di chuyển file có logic thực vào đúng Provider_Directory
3. Giữ nguyên tất cả shim file tại vị trí cũ để đảm bảo backward compatibility — **không xóa shim nào**
4. Đảm bảo Backward_Compat_Baseline và test suite không bị ảnh hưởng

### Phân loại file root-level

**Shim đơn nguồn** (re-export từ một Provider_Directory duy nhất): `account-info.ts`, `auth.ts`, `client.ts`, `codex-auth.ts`, `connect-account.ts`, `http.ts`, `models.ts`, `paths.ts`, `request-logs.ts`

**Shim đa nguồn** (re-export từ nhiều Provider_Directory): `constants.ts` (core + upstream/codex), `reasoning.ts` (core + inbound/openai), `types.ts` (core + upstream/codex + inbound/claude)

**File có logic thực** (cần di chuyển hoặc giữ nguyên): `bin.ts`, `bootstrap.ts`, `claude-code-env.config.ts`, `cli.ts`, `package-info.ts`, `runtime.ts`

**Shim đã chuyển đổi** (từng có logic, hiện là shim): `claude.ts` (re-export `handleClaudeMessages`, `handleClaudeCountTokens` từ `./inbound/claude/handlers`)

**Thư mục shim `src/claude/`**: 10 file — 9 file re-export từ `src/inbound/claude/`, 1 file (`sse.ts`) re-export từ `src/core/sse`

**Shim cấp inbound**: `src/inbound/client.ts`, `src/inbound/constants.ts`, `src/inbound/reasoning.ts` — hiện import ngược qua root shim thay vì trực tiếp từ nguồn

## Glossary

- **Root_Shim**: File TypeScript nằm trực tiếp trong `src/` chỉ chứa câu lệnh re-export (`export * from`, `export { ... } from`, hoặc `export type { ... } from`) mà không có logic riêng
- **Single_Source_Shim**: Root_Shim re-export từ đúng một Provider_Directory
- **Multi_Source_Shim**: Root_Shim re-export từ hai hoặc nhiều Provider_Directory (ví dụ: `src/constants.ts`, `src/reasoning.ts`, `src/types.ts`)
- **Legacy_Claude_Shim**: File TypeScript trong thư mục `src/claude/` re-export từ `src/inbound/claude/` hoặc `src/core/`
- **Inbound_Shim**: File TypeScript trong `src/inbound/` re-export ngược qua root shim thay vì import trực tiếp từ nguồn (cụ thể: `client.ts`, `constants.ts`, `reasoning.ts`)
- **Backward_Compat_Baseline**: File JSON tại `test/backward-compat-baseline.json` ghi lại tất cả module path importable và exported symbol; test hiện tại resolve module qua trường `file` (đường dẫn tương đối đến file `.ts`)
- **Backward_Compat_Test**: Test suite tại `test/backward-compat.test.ts` kiểm tra: (a) mọi `module.file` trong baseline vẫn importable, (b) mọi symbol trong `module.exports` có mặt, (c) các specific re-export case resolve đúng runtime symbol
- **Public_API_Barrel**: File `src/index.ts` là barrel export chính của package
- **Provider_Directory**: Thư mục con theo kiến trúc provider-agnostic: `src/core/`, `src/upstream/codex/`, `src/inbound/claude/`, `src/inbound/openai/`
- **Internal_Consumer**: File trong project import symbol qua shim thay vì trực tiếp từ Provider_Directory
- **Exact_Export_Surface**: Tập hợp chính xác các symbol name mà một shim export — phải giữ nguyên, không được mở rộng hoặc thu hẹp

## Requirements

### Requirement 1: Cập nhật Internal_Consumer import path

**User Story:** Là developer, tôi muốn các file trong project import trực tiếp từ Provider_Directory thay vì đi qua shim để dependency graph rõ ràng và không có tham chiếu vòng.

#### Acceptance Criteria

1. FOR EACH Internal_Consumer import từ một Root_Shim hoặc Inbound_Shim, THE Consolidation_System SHALL cập nhật import path để trỏ trực tiếp đến Provider_Directory chứa symbol gốc
2. THE Consolidation_System SHALL cập nhật `src/inbound/client.ts` để re-export từ `../upstream/codex/client` thay vì `../client`
3. THE Consolidation_System SHALL cập nhật `src/inbound/constants.ts` để re-export từ `../core/constants` thay vì `../constants`
4. THE Consolidation_System SHALL cập nhật `src/inbound/reasoning.ts` để re-export từ `../core/reasoning` và `./openai/normalize` thay vì `../reasoning`
5. THE Consolidation_System SHALL cập nhật `src/inbound/claude/handlers.ts` để import `LOG_BODY_PREVIEW_LIMIT` từ `../../core/constants`, `CodexStandaloneClient` từ `../../upstream/codex/client`, `normalizeReasoningBody` từ `../../core/reasoning`, và types từ `../types` (giữ nguyên vì `../types` là `src/inbound/types.ts` — không phải root shim)
6. THE Consolidation_System SHALL cập nhật tất cả file trong `src/ui/` mà import qua root shim để trỏ trực tiếp đến Provider_Directory tương ứng, NGOẠI TRỪ import từ `src/runtime.ts`, `src/package-info.ts`, `src/cli.ts`, `src/bootstrap.ts` (các file giữ nguyên tại root)
7. THE Consolidation_System SHALL cập nhật `src/index.ts` (Public_API_Barrel) để re-export trực tiếp từ Provider_Directory thay vì qua root shim. Cụ thể: thay `export * from "./types"` bằng explicit type re-export từ `./core/types`, `./upstream/codex/types`, `./inbound/claude/types`; thay `export * from "./auth"` bằng `export * from "./upstream/codex/auth"`; v.v. — `src/index.ts` KHÔNG ĐƯỢC import qua bất kỳ Root_Shim nào sau khi consolidation
8. WHEN import path được cập nhật, THE Consolidation_System SHALL đảm bảo TypeScript compile thành công và không có import nào bị hỏng

### Requirement 2: Di chuyển file có logic vào đúng Provider_Directory

**User Story:** Là developer, tôi muốn các file có logic thực sự nằm trong đúng thư mục kiến trúc thay vì ở root `src/`.

#### Acceptance Criteria

1. THE Consolidation_System SHALL di chuyển `src/claude-code-env.config.ts` vào `src/inbound/claude/claude-code-env.config.ts` và tạo shim tại `src/claude-code-env.config.ts` re-export tất cả symbol từ vị trí mới
2. `src/claude.ts` hiện đã là shim re-export `handleClaudeMessages` và `handleClaudeCountTokens` từ `./inbound/claude/handlers` — THE Consolidation_System SHALL giữ nguyên file này
3. THE Consolidation_System SHALL giữ nguyên tại vị trí hiện tại: `src/bootstrap.ts`, `src/runtime.ts`, `src/bin.ts`, `src/cli.ts`, `src/package-info.ts` — vì đây là composition root, runtime server, CLI entry point, CLI parser, và package metadata utility
4. WHEN một file có logic được di chuyển, THE shim tại vị trí cũ SHALL export đúng Exact_Export_Surface như file gốc — không dùng `export *` nếu module nguồn export nhiều symbol hơn shim gốc

### Requirement 3: Giữ nguyên tất cả shim file cho backward compatibility

**User Story:** Là maintainer, tôi muốn tất cả import path đã công bố vẫn hoạt động sau khi consolidation để không break consumer hiện tại.

#### Acceptance Criteria

1. THE Consolidation_System SHALL KHÔNG xóa bất kỳ Root_Shim nào — tất cả 12 file shim (`account-info.ts`, `auth.ts`, `client.ts`, `codex-auth.ts`, `connect-account.ts`, `constants.ts`, `http.ts`, `models.ts`, `paths.ts`, `reasoning.ts`, `request-logs.ts`, `types.ts`) SHALL tiếp tục tồn tại tại vị trí hiện tại
2. THE Consolidation_System SHALL KHÔNG xóa bất kỳ Legacy_Claude_Shim nào — tất cả 10 file trong `src/claude/` SHALL tiếp tục tồn tại tại vị trí hiện tại
3. FOR EACH Root_Shim, THE Exact_Export_Surface SHALL giữ nguyên — không thêm, không bớt symbol nào so với trạng thái hiện tại
4. FOR EACH Legacy_Claude_Shim, THE Exact_Export_Surface SHALL giữ nguyên
5. Cụ thể, `src/reasoning.ts` SHALL chỉ export `normalizeReasoningBody` và `normalizeRequestBody` — KHÔNG dùng `export *` từ `src/core/reasoning` hay `src/inbound/openai/normalize` vì các module đó có thể export thêm symbol khác (ví dụ: `normalizeCanonicalRequest`)
6. Cụ thể, `src/types.ts` SHALL tiếp tục dùng `export type { ... }` với danh sách symbol cụ thể — KHÔNG dùng `export *`
7. Cụ thể, `src/claude/sse.ts` SHALL tiếp tục re-export từ `../core/sse` (KHÔNG phải từ `../inbound/claude/sse`)

### Requirement 4: Đảm bảo Backward_Compat_Baseline không bị thay đổi

**User Story:** Là developer, tôi muốn baseline và test backward compat tiếp tục hoạt động chính xác mà không cần cập nhật.

#### Acceptance Criteria

1. THE Consolidation_System SHALL KHÔNG thay đổi trường `path`, `file`, hoặc `exports` của bất kỳ entry nào trong Backward_Compat_Baseline — vì tất cả shim file vẫn tồn tại tại vị trí cũ, baseline không cần cập nhật
2. THE Consolidation_System SHALL KHÔNG thêm entry mới vào Backward_Compat_Baseline cho các file mới tại Provider_Directory (ví dụ: `src/inbound/claude/claude-code-env.config.ts`) — đây là internal module, không phải public API
3. THE Consolidation_System SHALL đảm bảo Backward_Compat_Test pass sau khi hoàn thành consolidation — cả test "all baseline src/** module paths remain importable" và "specific compatibility re-exports resolve expected runtime symbols"
4. FOR ALL module path trong Backward_Compat_Baseline, import qua `module.file` rồi kiểm tra `module.exports` SHALL cho kết quả tương đương trước và sau consolidation

### Requirement 5: Đảm bảo Public_API_Barrel ổn định

**User Story:** Là consumer của package, tôi muốn `src/index.ts` vẫn export đầy đủ symbol như trước để code import từ package không bị break.

#### Acceptance Criteria

1. THE Consolidation_System SHALL đảm bảo `src/index.ts` export đúng tập symbol như trong Backward_Compat_Baseline cho path `src/index`
2. WHEN `src/index.ts` được cập nhật để import trực tiếp từ Provider_Directory, THE Consolidation_System SHALL kiểm tra không có symbol nào bị mất hoặc thay đổi tên
3. THE Consolidation_System SHALL đảm bảo hàm `runExample()` trong `src/index.ts` vẫn hoạt động đúng sau khi cập nhật import path
4. `src/index.ts` SHALL KHÔNG import qua bất kỳ Root_Shim nào — tất cả re-export phải trỏ trực tiếp đến Provider_Directory, giữ đúng Exact_Export_Surface

### Requirement 6: Toàn bộ test suite phải pass

**User Story:** Là developer, tôi muốn đảm bảo không có regression nào sau khi consolidation.

#### Acceptance Criteria

1. THE Consolidation_System SHALL đảm bảo `bun run test` (stable suite, 84+ tests) pass với 0 failure
2. THE Consolidation_System SHALL đảm bảo `bun test test/core/ test/inbound/ test/upstream/ test/backward-compat.test.ts` pass với 0 failure
3. THE Consolidation_System SHALL đảm bảo `bun run build` thành công
4. THE Consolidation_System SHALL đảm bảo tất cả edge case test mới (172 tests trong `*-edge.test.ts`) pass với 0 failure
