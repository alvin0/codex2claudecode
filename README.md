# codex2claudecode

[![Publish to npm](https://github.com/alvin0/codex2claudecode/actions/workflows/publish.yml/badge.svg)](https://github.com/alvin0/codex2claudecode/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/codex2claudecode.svg)](https://www.npmjs.com/package/codex2claudecode)

Run OpenAI Codex/ChatGPT account credentials behind a local Claude-compatible API for Claude Code.

![codex2claudecode overview](https://cdn.jsdelivr.net/npm/codex2claudecode@latest/images/overview.png)

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

### Runtime Requirement

The runtime is Bun-only. Starting with the Bun migration, the packaged CLI
requires Bun `>=1.3.0` to execute the application. The `npx` entry point is a
compatibility launcher: it checks for Bun, falls back to the npm-published Bun
package when possible, and prints installation instructions if no usable Bun is
available.

Existing Node-only installations should install Bun before upgrading:

```sh
curl -fsSL https://bun.sh/install | bash
```

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
export ANTHROPIC_API_KEY=""
export ANTHROPIC_MODEL="gpt-5.4"
export ANTHROPIC_DEFAULT_OPUS_MODEL="gpt-5.4_high"
export ANTHROPIC_DEFAULT_SONNET_MODEL="gpt-5.3-codex_high"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="gpt-5.4-mini_high"
```

PowerShell:

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
$env:ANTHROPIC_API_KEY=""
$env:ANTHROPIC_MODEL="gpt-5.4"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL="gpt-5.4_high"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL="gpt-5.3-codex_high"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="gpt-5.4-mini_high"
```

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
Other top-level settings in `~/.claude/settings.json` are preserved. Built-in
defaults, locked env values, and editable env keys are defined in
`src/claude-code-env.config.ts`.

## UI Commands

```text
/connect          Add or update an account for the active provider
/account          Switch active provider account
/limits           Show active provider account limits
/logs             Show recent runtime request logs
/set-claude-env   Edit Claude Code environment exports
/unset-claude-env Remove Claude Code environment variables
/quit             Quit codex2claudecode
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
POST /v1/messages
POST /v1/messages/count_tokens
POST /v1/responses
POST /v1/chat/completions
GET  /usage
GET  /environments
GET  /health
```

## Kiro Payload Limit

Kiro requests are preflight-checked before sending upstream. The default body
limit is `1_200_000` bytes, matching the observed safe range before Kiro starts
returning opaque `400 Improperly formed request` errors. When a request exceeds
the limit, the gateway removes the oldest conversation history until the payload
fits and emits a visible warning in the response.

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

From this repository:

```sh
cd standalone
bun install
bun run start
bun run start -- --port 8786
bun run check
bun run test
bun run coverage
```

`bun run typecheck` runs the strict source config first. It then runs a test
config that keeps strict null and structural checks but relaxes `noImplicitAny`
for terse test doubles such as inline `fetch` mocks.

Current deterministic test status:

```text
bun run check
PASS - typecheck + Bun bundle

bun run test
PASS - 515 pass, 1 filtered out, 0 fail
```

Live smoke test using `auth-codex.json`:

```sh
bun run test:live
```

The publish workflow also runs:

```text
bun install --frozen-lockfile
bun run check
bun run test
npm pack --dry-run
npm publish --access public --provenance
```

## CI Evidence

GitHub Actions workflow:

```text
https://github.com/alvin0/codex2claudecode/actions/workflows/publish.yml
```

Every publish run uploads an artifact named `npm-publish-evidence` containing:

```text
check.log
test.log
npm-pack.log
```

Use those artifacts as release evidence that the package was built, tested, and dry-packed before publishing.

## License

MIT. See [LICENSE](./LICENSE).

## Notes

- `auth-codex.json` and `kiro-state.json` contain secrets. Do not commit them.
- `.account-info.json` and `.claude-env.json` do not contain OAuth tokens, but may contain email/account metadata.
- Bun currently reports line/function coverage. Branch coverage is covered by deterministic tests but is not reported by Bun text/lcov output.

## Author

alvin0 <chaulamdinhai@gmail.com>
