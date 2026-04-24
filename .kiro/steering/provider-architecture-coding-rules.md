---
inclusion: always
---

# Provider Architecture Coding Rules

Tài liệu này là coding rule bắt buộc cho coder khi thêm tính năng, sửa bug, viết test, hoặc chỉnh cấu trúc module trong project.

Hãy xem cấu trúc hiện tại của `src/` là contract kiến trúc chính thức. Khi phân vân nên đặt file ở đâu hoặc import từ đâu, ưu tiên ownership thật của logic thay vì đường dẫn ngắn hơn.

## Mục Tiêu Kiến Trúc

Kiến trúc của project tách hệ thống thành ba lớp chính:

- Core định nghĩa contract provider-agnostic và utility dùng chung.
- Inbound providers dịch API format bên ngoài sang canonical model của project.
- Upstream providers dịch canonical model sang wire format của backend LLM provider.

Runtime không nên biết chi tiết Claude, OpenAI, Codex, hoặc provider cụ thể nào khác. Runtime chỉ route request qua registry và gọi interface chung. Concrete providers được wire tại bootstrap.

Mục tiêu khi viết code mới:

- Dễ thêm inbound provider mới mà không sửa upstream provider hiện có.
- Dễ thêm upstream provider mới mà không sửa inbound provider hiện có.
- Không tạo dependency vòng giữa core, inbound, upstream, app.
- Không đưa provider-specific behavior vào public barrel hoặc core utilities.
- Không tạo compatibility shortcut ở root `src/`.
- Tách file theo từng nhóm logic rõ ràng để code dễ đọc, dễ test, và dễ mở rộng sau này.

## Cấu Trúc Hiện Tại

`src/` chỉ được chứa `index.ts` và các subdirectory:

- `src/app/`: application-level composition như CLI parser, bootstrap wiring, runtime server, package metadata, executable entry logic.
- `src/core/`: contract và utility provider-agnostic như canonical types, provider interfaces, registry, HTTP/SSE helpers, paths, request logs, generic constants, reasoning normalization.
- `src/inbound/<provider>/`: adapter cho inbound API format. Module ở đây dịch request/response format bên ngoài sang canonical types và ngược lại.
- `src/upstream/<provider>/`: connector đến upstream LLM provider. Module ở đây dịch canonical request sang provider wire format, gọi upstream, rồi parse response về canonical result types.
- `src/ui/`: UI code.

Không thêm file `.ts` hoặc `.tsx` trực tiếp dưới `src/`, ngoại trừ `src/index.ts`.

Ví dụ cấu trúc hợp lệ:

```text
src/
  index.ts
  app/
  core/
  inbound/
    claude/
    openai/
  upstream/
    codex/
  ui/
```

Ví dụ cấu trúc không hợp lệ:

```text
src/feature.ts
src/provider.ts
src/shared-utils.ts
```

## Ownership Theo Thư Mục

`src/app/` sở hữu application wiring và entry-level behavior:

- CLI argument parsing.
- Bootstrap concrete providers.
- Runtime server lifecycle.
- Package metadata.
- Executable entry logic.

`src/core/` sở hữu những phần không phụ thuộc provider:

- Canonical request/response/event types.
- `Inbound_Provider`, `Upstream_Provider`, route descriptors, request handler context.
- Provider registry.
- HTTP helpers, CORS helpers.
- SSE parsing helpers nếu helper đó không gắn với một provider cụ thể.
- Path utilities, request log utilities, generic constants.
- Generic reasoning normalization dựa trên model identifier.

`src/inbound/<provider>/` sở hữu inbound API format:

- Route descriptors cho API format đó.
- Parse request body từ wire format bên ngoài.
- Convert inbound request sang canonical request.
- Convert canonical success/stream/error về inbound response format.
- Error shape theo inbound API.
- Model presentation theo inbound API.
- Provider-specific inbound config, ví dụ Claude environment config.

`src/upstream/<provider>/` sở hữu upstream provider:

- Auth, credential lifecycle, token refresh, API keys, account info.
- Provider constants như endpoint URLs, issuer, client id.
- Request construction sang upstream wire format.
- Header sanitization và provider-specific HTTP behavior.
- Response parsing từ upstream wire format về canonical result types.
- Optional provider capabilities như usage hoặc environments.

`src/ui/` sở hữu UI code và chỉ nên import từ owner thật của logic mà UI cần dùng.

## Tách File Theo Logic Khi Làm Task Mới

Khi làm task mới, việc tách file theo từng logic là bắt buộc nếu feature bắt đầu có nhiều trách nhiệm khác nhau. Đừng gom nhiều loại behavior vào một file lớn chỉ vì đang sửa cùng một task. File nhỏ, có ownership rõ ràng giúp người sau hiểu nhanh hơn, test dễ hơn, và thêm provider hoặc flow mới ít phải sửa module hiện có hơn.

Một file nên có một vai trò chính:

- Parse input hoặc validate input.
- Convert từ wire format sang canonical model.
- Convert từ canonical model sang wire format.
- Gọi upstream/client.
- Parse upstream response.
- Định nghĩa type/interface.
- Định nghĩa constants.
- Format error response.
- Register route hoặc provider.
- Điều phối flow ở mức handler/orchestrator.

Nếu một file vừa parse request, vừa gọi upstream, vừa format response, vừa chứa constants, vừa chứa helper xử lý type, hãy tách ra. Handler có thể điều phối các module nhỏ hơn, nhưng không nên trở thành nơi chứa toàn bộ logic domain.

Ví dụ tách hợp lý trong inbound provider:

```text
src/inbound/example/
  index.ts          # Provider class, route descriptors, registration-facing API
  handlers.ts       # Request handler orchestration
  convert.ts        # Example wire request -> Canonical_Request
  response.ts       # Canonical result -> Example wire response
  errors.ts         # Example API error format
  types.ts          # Example-specific wire types
```

Ví dụ tách hợp lý trong upstream provider:

```text
src/upstream/example/
  index.ts          # Upstream_Provider implementation
  client.ts         # HTTP client and retry behavior
  auth.ts           # Credentials, token/API key loading
  constants.ts      # Provider endpoints and header constants
  parse.ts          # Upstream wire response -> canonical result
  types.ts          # Example-specific upstream wire types
```

Khi quyết định có nên tách file không, dùng các câu hỏi sau:

- Logic này có thể được test độc lập không?
- Logic này có thể thay đổi vì một lý do khác với phần còn lại không?
- Logic này thuộc layer khác không: core, inbound, upstream, app, ui?
- Logic này có thể được reuse bởi provider khác mà vẫn provider-agnostic không?
- File hiện tại có đang cần scroll nhiều để hiểu một flow đơn giản không?

Nếu câu trả lời là có, hãy tách file. Tuy nhiên, không tạo abstraction chung quá sớm. Tách file theo ownership thật trước; chỉ tạo shared abstraction khi có duplication thực tế và abstraction đó không làm mờ boundary giữa các layer.

## Quy Tắc Import

Source file nội bộ và test phải import từ thư mục sở hữu logic thật. Không import từ path tiện tay chỉ vì ngắn hơn.

Import từ owner hiện tại:

- Core utilities và shared types: `src/core/*`
- Codex auth/client/account logic: `src/upstream/codex/*`
- Claude API handling/model/env logic: `src/inbound/claude/*`
- OpenAI-compatible normalization/handling: `src/inbound/openai/*`
- Runtime, bootstrap, CLI, package info: `src/app/*`

`src/index.ts` là public package barrel. Internal files không dùng barrel này như shortcut để import code trong project.

Ví dụ import đúng:

```ts
import { responseHeaders } from "../core/http"
import { CodexStandaloneClient } from "../upstream/codex/client"
import { handleClaudeMessages } from "../inbound/claude/handlers"
import { startRuntime } from "../app/runtime"
```

Ví dụ import sai:

```ts
import { CodexStandaloneClient, startRuntime } from "../index"
```

Khi cập nhật test, test cũng phải import từ owner thật. Test không nên đi qua public barrel nếu đang kiểm tra module nội bộ.

## Ranh Giới Layer

`src/core/` phải luôn provider-agnostic. Không đưa logic Claude-specific, OpenAI-specific, Codex-specific, OAuth-specific, hoặc provider wire-format vào core. Core chỉ định nghĩa canonical contracts và shared utilities.

Inbound provider được phụ thuộc vào `src/core/` và chính thư mục inbound provider của nó. Inbound provider không được biết upstream wire format và không import concrete upstream implementation.

Upstream provider được phụ thuộc vào `src/core/` và chính thư mục upstream provider của nó. Upstream provider không import inbound provider modules hoặc inbound API-format types.

`src/app/bootstrap.ts` là composition root dùng để wire concrete providers. `src/app/runtime.ts` chỉ phụ thuộc vào core interfaces và provider registry behavior, không import concrete provider implementations.

Provider-specific credential lifecycle, constants, request headers, endpoint URLs, và wire parsing thuộc về `src/upstream/<provider>/`.

Provider-specific external API request/response formatting, error shape, model presentation, và route descriptors thuộc về `src/inbound/<provider>/`.

Luồng phụ thuộc mong muốn:

```text
src/app/bootstrap.ts -> concrete inbound/upstream providers
src/app/runtime.ts   -> src/core/interfaces + src/core/registry
src/inbound/*        -> src/core/*
src/upstream/*       -> src/core/*
src/ui/*             -> owner module thật
src/index.ts         -> public exports only
```

Không tạo luồng phụ thuộc này:

```text
src/core/*           -> src/inbound/* hoặc src/upstream/*
src/inbound/claude/* -> src/upstream/codex/*
src/upstream/codex/* -> src/inbound/claude/*
src/app/runtime.ts   -> concrete providers
internal source      -> src/index.ts
```

Nếu một function có vẻ cần dùng ở cả inbound và upstream, hãy hỏi: function đó có thật sự provider-agnostic không?

- Nếu có, đặt ở `src/core/`.
- Nếu chỉ dùng chung vì Codex và Claude hiện tại tình cờ cần cùng behavior, tránh đưa vào core quá sớm. Tách helper nhỏ hơn hoặc để ở provider đang sở hữu behavior.

## Quy Tắc Public API

Giữ `src/index.ts` ổn định cho package consumers. Nếu thay đổi public export, phải cập nhật và verify backward compatibility baseline một cách có chủ đích.

Khi export cross-domain types trong `src/index.ts`, ưu tiên explicit exports. Tránh dùng `export *` từ type modules rộng vì có thể vô tình expose internal symbols.

Không tạo file trung gian ở root `src/` để làm shortcut import. Nếu nhu cầu compatibility thay đổi, hãy cập nhật public API, baseline, và tests rõ ràng thay vì âm thầm thêm đường dẫn mới.

`src/index.ts` được phép re-export public API từ provider directories và app modules, nhưng không nên biến thành nơi gom mọi internal utility. Chỉ export những gì package consumer thật sự cần.

Khi sửa `src/index.ts`:

- Kiểm tra export surface trước và sau khi sửa.
- Không dùng `export *` từ module có nhiều internal symbols nếu chỉ muốn expose một subset.
- Type-only public exports nên dùng `export type { ... }`.
- Runtime imports trong `runExample()` phải trỏ trực tiếp đến owner thật.

## Khi Thêm Provider

Khi thêm inbound provider:

1. Tạo `src/inbound/<provider>/`.
2. Implement inbound provider interface từ `src/core/interfaces`.
3. Dịch incoming wire format thành canonical request types.
4. Dịch canonical result types ngược về inbound wire format.
5. Register provider trong `src/app/bootstrap.ts`.

Khi thêm upstream provider:

1. Tạo `src/upstream/<provider>/`.
2. Implement upstream provider interface từ `src/core/interfaces`.
3. Giữ auth, credentials, provider constants, request construction, và response parsing trong provider directory đó.
4. Return canonical success, stream, error, hoặc passthrough result types cho inbound providers.
5. Wire provider selection trong application startup code.

Thêm provider mới không nên yêu cầu sửa `src/app/runtime.ts`. Runtime route qua provider registry và core interfaces.

## Khi Đổi Owner Hoặc Sắp Xếp Module

Khi một module đổi owner:

1. Xác định owner mới theo domain thật, không theo nơi đang được import nhiều nhất.
2. Di chuyển file vào `src/core/`, `src/inbound/<provider>/`, `src/upstream/<provider>/`, `src/app/`, hoặc `src/ui/`.
3. Cập nhật tất cả imports sang owner mới.
4. Không tạo shortcut file ở root `src/`.
5. Cập nhật `src/index.ts` chỉ nếu public API cần giữ hoặc thay đổi.
6. Cập nhật `test/backward-compat-baseline.json` nếu module surface hợp lệ thay đổi.

Nếu logic chứa provider wire-format, nó không thuộc `src/core/`.

Nếu logic chứa startup wiring giữa nhiều providers, nó thuộc `src/app/bootstrap.ts` hoặc module app-level gần đó.

Nếu logic chỉ là route matching, canonical contracts, hoặc shared infrastructure không biết provider nào, nó có thể thuộc `src/core/`.

## Anti-Patterns Cần Tránh

Không làm những việc sau:

- Thêm `src/foo.ts` ở root để import cho ngắn.
- Tạo module trung gian chỉ để re-export từ owner thật.
- Import từ `src/index.ts` bên trong source nội bộ.
- Đưa Codex auth/token types vào `src/core/types.ts`.
- Đưa Claude request body hoặc OpenAI chat-completions body vào canonical types.
- Để inbound provider forward raw upstream response trừ khi flow đó được biểu diễn bằng canonical passthrough result.
- Để upstream provider format response theo Claude/OpenAI inbound shape.
- Sửa `src/app/runtime.ts` mỗi khi thêm provider route mới.
- Dùng broad `export *` trong public barrel chỉ để tiện.
- Cập nhật baseline để che lỗi import path thay vì sửa owner/import đúng.

## Checklist Trước Khi Kết Thúc Task

Trước khi kết thúc task có thay đổi code, verify:

- `src/` chỉ chứa `index.ts` và subdirectories.
- Không có source file mới nằm trực tiếp dưới `src/` ngoài `src/index.ts`.
- Không có provider-specific code leak vào `src/core/`.
- Inbound provider không import concrete upstream implementation modules.
- Upstream provider không import inbound provider modules.
- `src/app/runtime.ts` không import concrete providers.
- `src/index.ts` vẫn expose đúng public API surface mong muốn.
- `test/backward-compat-baseline.json` khớp với public/module surface mong muốn.

Các câu lệnh hữu ích:

```sh
find src -maxdepth 1 -type f ! -name index.ts -print
rg "from ['\"].*/index['\"]" src test
```

Chạy các check liên quan:

```sh
bun run build
bun run test
bun test test/backward-compat.test.ts
bun test test/core/consolidation.property.test.ts
```
