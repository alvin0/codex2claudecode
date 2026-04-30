# codex2claudecode

[![Publish to npm](https://github.com/alvin0/codex2claudecode/actions/workflows/publish.yml/badge.svg)](https://github.com/alvin0/codex2claudecode/actions/workflows/publish.yml)
[![CI](https://github.com/alvin0/codex2claudecode/actions/workflows/ci.yml/badge.svg)](https://github.com/alvin0/codex2claudecode/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/codex2claudecode.svg)](https://www.npmjs.com/package/codex2claudecode)

Run OpenAI Codex/ChatGPT and Amazon Kiro account credentials behind a local Claude-compatible API for Claude Code.

| Codex Mode | Kiro Mode |
|---|---|
| ![Codex Mode](https://cdn.jsdelivr.net/npm/codex2claudecode@latest/images/codex-mode.png) | ![Kiro Mode](https://cdn.jsdelivr.net/npm/codex2claudecode@latest/images/kiro-mode.png) |

codex2claudecode supports two upstream providers:

- **Codex** — uses OpenAI Codex/ChatGPT credentials (GPT-5 models)
- **Kiro** — uses Amazon Kiro credentials (Kiro models)

Switch between providers at any time using the UI command:

```text
/switch-provider
```

The active provider is shown in the terminal UI title bar. Each provider has its
own account, model list, and usage tracking. Switching providers restarts the
runtime with the new provider's credentials — active Claude Code sessions will
reconnect automatically.

## Quick Start

codex2claudecode runs on Bun. Install Bun first:

```sh
curl -fsSL https://bun.sh/install | bash
```

Windows PowerShell:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Run with npm:

```sh
npx codex2claudecode
```

`npx` uses a small Node launcher that checks for Bun and prints install
instructions if Bun is missing. If Bun is not installed locally, the launcher
will try the npm-published Bun package (`npx --yes bun@latest`) and run the app
through that cached binary. It does not install Bun globally. Set
`CODEX2CLAUDECODE_DISABLE_NPX_BUN=1` to disable this fallback, or set
`BUN_BINARY=/path/to/bun` to force a specific Bun executable.

Run with Bun:

```sh
bunx codex2claudecode
```

Use a custom port:

```sh
npx codex2claudecode --port 8786
bunx codex2claudecode -p 8786
```

Protect the API with a password:

```sh
bunx codex2claudecode --password mysecret
```

Or via environment variable:

```sh
API_PASSWORD=mysecret bunx codex2claudecode
```

When a password is set, all API endpoints except `/`, `/health`, `/test-connection`, and `OPTIONS` requests require authentication via `X-Api-Key` or `Authorization: Bearer` header.

### Runtime Requirement

codex2claudecode requires Bun `>=1.3.0`. The `npx` entry point is a compatibility
launcher that falls back to the npm-published Bun package when possible and prints
installation instructions if no usable Bun is available.

## Connect an Account

Open the UI and run:

```text
/connect
```

The command uses the active provider. For Codex, you can choose:

```text
Add from ~/.codex/auth.json
Manual
```

`Add from ~/.codex/auth.json` imports ChatGPT auth from the Codex CLI auth file. Expected shape:

```json
{
  "auth_mode": "chatgpt",
  "tokens": {
    "access_token": "...",
    "refresh_token": "...",
    "account_id": "..."
  }
}
```

`Manual` asks for:

```text
accountId
accessToken
refreshToken
```

Manual mode uses the refresh token to fetch a fresh access token before saving.

Before refreshing a Codex account imported from `~/.codex/auth.json`,
codex2claudecode first checks the original Codex CLI auth file. If the Codex CLI
already changed its token fields, the managed account is updated from that
source before any refresh-token request is attempted. When codex2claudecode
performs the refresh itself, it writes the updated `access_token`,
`refresh_token`, and `account_id` fields back to the original Codex CLI auth
file as well.

For Kiro, switch to Kiro mode first, then run:

```text
/connect
```

You can choose:

```text
Add from Kiro IDE auth
Manual
```

`Add from Kiro IDE auth` imports from the Kiro auth token cache:

```text
~/.aws/sso/cache/kiro-auth-token.json
```

or from `KIRO_AUTH_FILE` when that environment variable is set. Manual mode
asks for:

```text
label
accessToken
refreshToken
region
profileArn
```

`label` and `profileArn` are optional. Managed Kiro accounts are stored in:

```text
~/.codex2claudecode/kiro-state.json
```

Before refreshing an imported Kiro account, codex2claudecode first checks the
original Kiro auth file. If Kiro IDE already changed its token fields, the
managed account is updated from that source before any refresh-token request is
attempted. When codex2claudecode performs the refresh itself, it writes the
updated `accessToken`, `refreshToken`, `expiresAt`, and `profileArn` fields back
to the original Kiro auth file as well.

## Claude Code

After the server is running, point Claude Code at it:

macOS/Linux:

```sh
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_API_KEY="codex2claudecode"
export ANTHROPIC_AUTH_TOKEN="codex2claudecode"
export ANTHROPIC_MODEL="gpt-5.4"
export ANTHROPIC_DEFAULT_OPUS_MODEL="gpt-5.4_high"
export ANTHROPIC_DEFAULT_SONNET_MODEL="gpt-5.3-codex_high"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="gpt-5.4-mini_high"
```

PowerShell:

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
$env:ANTHROPIC_API_KEY="codex2claudecode"
$env:ANTHROPIC_AUTH_TOKEN="codex2claudecode"
$env:ANTHROPIC_MODEL="gpt-5.4"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL="gpt-5.4_high"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL="gpt-5.3-codex_high"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="gpt-5.4-mini_high"
```

When `--password` is set, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are
automatically set to the password value by `/set-claude-env`. Without a password,
they default to a placeholder token.

The UI command:

```text
/set-claude-env
```

lets you edit the four default model values and preview what will be written into
`~/.claude/settings.json` under the `env` object. `ANTHROPIC_BASE_URL` is always
generated from the active host/port.

The local Claude environment config is stored next to the auth file as
`.claude-env.json`. Besides the model keys, it supports:

```json
{
  "extraEnv": {
    "CUSTOM_ENV": "custom-value"
  },
  "unsetEnv": ["HTTP_PROXY"]
}
```

`extraEnv` adds or updates more keys inside `~/.claude/settings.json` -> `env`.
`unsetEnv` removes the listed keys from that same `env` object during
`/set-claude-env`, and both lists are also included in `/unset-claude-env`.
Other top-level settings in `~/.claude/settings.json` are preserved.

## UI Commands

```text
/connect           Add or update an account for the active provider
/switch-provider   Switch between Codex and Kiro providers
/account           Switch active provider account
/limits            Show active provider account limits
/logs              Show recent runtime request logs
/set-claude-env    Edit Claude Code environment exports
/unset-claude-env  Remove Claude Code environment variables
/quit              Quit codex2claudecode
```

`/set-claude-env` writes the managed keys into `~/.claude/settings.json` under
the `env` object, updating existing values and preserving all unrelated content.
`/unset-claude-env` asks for confirmation, then removes only the managed keys
from that `env` object.

## Local API

Default server:

```text
http://127.0.0.1:8787
```

Supported endpoints:

```text
GET  /                          Server info and config
POST /v1/messages               Claude Messages API
POST /v1/messages/count_tokens  Token counting
POST /v1/responses              OpenAI Responses API
POST /v1/chat/completions       OpenAI Chat Completions API
GET  /v1/models                 Model listing
GET  /usage                     Usage statistics
GET  /environments              Environment info
GET  /health                    Health check
GET  /test-connection            Connection test
```

Both Claude and OpenAI-compatible endpoints support streaming (`stream: true`)
and non-streaming (`stream: false`) requests. Non-streaming requests accumulate
the full response before returning a single JSON body.

### API Password Protection

Start the server with `--password` or `API_PASSWORD` to require authentication:

```sh
bunx codex2claudecode --password mysecret
# or
API_PASSWORD=mysecret bunx codex2claudecode
```

Protected endpoints require one of:

```text
X-Api-Key: mysecret
Authorization: Bearer mysecret
```

Unprotected endpoints (no auth required):

```text
GET  /               Server info (includes password_protected: true/false)
GET  /health         Health check
GET  /test-connection Connection test
OPTIONS *            CORS preflight
```

Password comparison uses constant-time comparison to prevent timing attacks.

### Examples

Check server info:

```sh
curl http://127.0.0.1:8787/
```

Health check:

```sh
curl http://127.0.0.1:8787/health
```

Send a Claude Messages request (streaming):

```sh
curl http://127.0.0.1:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: mysecret" \
  -d '{
    "model": "gpt-5.4",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Send a Claude Messages request (non-streaming):

```sh
curl http://127.0.0.1:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: mysecret" \
  -d '{
    "model": "gpt-5.4",
    "max_tokens": 1024,
    "stream": false,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Send an OpenAI Chat Completions request:

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer mysecret" \
  -d '{
    "model": "gpt-5.4",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Send an OpenAI Responses request:

```sh
curl http://127.0.0.1:8787/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer mysecret" \
  -d '{
    "model": "gpt-5.4",
    "input": "Hello"
  }'
```

List available models:

```sh
curl http://127.0.0.1:8787/v1/models \
  -H "X-Api-Key: mysecret"
```

View usage statistics:

```sh
curl http://127.0.0.1:8787/usage \
  -H "X-Api-Key: mysecret"
```

Without password protection, omit the `-H "X-Api-Key: ..."` or `-H "Authorization: Bearer ..."` headers.

In Kiro mode, `/v1/responses` and `/v1/chat/completions` are supported.
`/v1/responses` expects Responses-style `input` and `text.format`; `/v1/chat/completions`
expects Chat Completions-style `messages` and `response_format`. Codex mode keeps its
existing OpenAI-compatible passthrough routes.

## Usage Accounting

When Codex/OpenAI Responses or Chat/Completions streams return usage metadata,
codex2claudecode preserves input, output, cached-input, and reasoning-output
token counts through the canonical response layer. Claude `/v1/messages`
responses split cached input into `cache_read_input_tokens` and keep uncached
input in `input_tokens`, matching Claude's usage shape.

Kiro streaming responses usually do not expose the same cache breakdown. For
Kiro, codex2claudecode uses Kiro's session `usage` event for output tokens and
forwards input, cache, and server-tool usage fields when Kiro includes them in
an object-shaped `usage` event. If Kiro does not return concrete input tokens,
`contextUsagePercentage` is used as the session input estimate when available.

## Kiro Payload Limit

Kiro requests are preflight-checked before sending upstream. The default body
limit is `1_200_000` bytes, matching the observed safe range before Kiro starts
returning opaque `400 Improperly formed request` errors. When a request exceeds
the limit, the gateway removes the oldest conversation history until the payload
fits and emits a visible warning in the response for non-Claude clients.

If a Claude Code request exceeds Kiro's byte limit, the gateway returns a
Claude-style context-window error instead of trimming the history itself,
allowing Claude Code to run its own recovery compact.

You can override the limit with either:

```sh
KIRO_PAYLOAD_SIZE_LIMIT_BYTES=900000
KIRO_MAX_PAYLOAD_SIZE_MB=1.2
```

## Models and Reasoning

For Kiro, model names are fetched from Kiro's `ListAvailableModels` endpoint and
cached briefly. If that endpoint is unavailable, codex2claudecode falls back to a
small known-supported list so Claude Code still has selectable models.

GPT-5 models can include a suffix for reasoning effort:

```text
gpt-5.4
gpt-5.4_high
gpt-5.4_xhigh
gpt-5.4-mini_low
```

Suffixes are mapped to the OpenAI Responses `reasoning.effort` field:

```text
none, low, medium (default), high, xhigh
```

If no suffix is supplied for a GPT-5 model, `medium` is used.

## Development

```sh
bun install
bun run start
bun run start -- --port 8786
bun run check
bun run test
bun run coverage
```

`bun run typecheck` runs the strict source config first, then a test config that
relaxes `noImplicitAny` for terse test doubles such as inline `fetch` mocks.

`bun run coverage` uses Vitest + Istanbul to report line, branch, function, and
statement coverage.

Live smoke test using `auth-codex.json`:

```sh
bun run test:live
```

## License

MIT. See [LICENSE](./LICENSE).

## Notes

- `auth-codex.json` and `kiro-state.json` contain secrets. Do not commit them.
- `.account-info.json` and `.claude-env.json` do not contain OAuth tokens but may contain email/account metadata.

## Author

alvin0 <chaulamdinhai@gmail.com>
