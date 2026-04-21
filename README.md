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
instructions if Bun is missing.

Run with Bun:

```sh
bunx codex2claudecode
```

Use a custom port:

```sh
npx codex2claudecode --port 8786
bunx codex2claudecode -p 8786
```

## Connect an Account

Open the UI and run:

```text
/connect
```

You can choose:

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
/connect          Add or update a Codex account
/account          Switch active Codex account
/limits           Show Codex account and model limits
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

## Models and Reasoning

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

Current deterministic test status:

```text
bun run check
PASS - Bundled 163 modules

bun run test
PASS - 43 pass, 1 filtered out, 0 fail
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

- `auth-codex.json` contains secrets. Do not commit it.
- `.account-info.json` and `.claude-env.json` do not contain OAuth tokens, but may contain email/account metadata.
- Bun currently reports line/function coverage. Branch coverage is covered by deterministic tests but is not reported by Bun text/lcov output.

## Author

alvin0 <chaulamdinhai@gmail.com>
