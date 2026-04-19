# codex2claudecode

[![Publish to npm](https://github.com/alvin0/codex2claudecode/actions/workflows/publish.yml/badge.svg)](https://github.com/alvin0/codex2claudecode/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/codex2claudecode.svg)](https://www.npmjs.com/package/codex2claudecode)

Run OpenAI Codex/ChatGPT account credentials behind a local Claude-compatible API for Claude Code.

![codex2claudecode overview](https://cdn.jsdelivr.net/npm/codex2claudecode@latest/images/overview.png)

## Quick Start

Run with npm:

```sh
npx codex2claudecode
```

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
export ANTHROPIC_AUTH_TOKEN=""
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_API_KEY=""
export ANTHROPIC_DEFAULT_OPUS_MODEL="gpt-5.4_high"
export ANTHROPIC_DEFAULT_SONNET_MODEL="gpt-5.3-codex_high"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="gpt-5.4-mini_high"
```

PowerShell:

```powershell
$env:ANTHROPIC_AUTH_TOKEN=""
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
$env:ANTHROPIC_API_KEY=""
$env:ANTHROPIC_DEFAULT_OPUS_MODEL="gpt-5.4_high"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL="gpt-5.3-codex_high"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="gpt-5.4-mini_high"
```

The UI command:

```text
/set-claude-env
```

lets you edit the three default model values and echoes shell-specific commands. The app auto-detects the current shell:

```text
sh/bash/zsh/dash/ksh -> export ...
PowerShell           -> $env:...
```

Unsupported shells show a warning in the UI instead of printing commands that may not work. If detection is wrong, override it:

```sh
CODEX2CLAUDECODE_SHELL=posix npx codex2claudecode
CODEX2CLAUDECODE_SHELL=powershell npx codex2claudecode
```

`ANTHROPIC_BASE_URL` is always generated from the active host/port.

## UI Commands

```text
/connect          Add or update a Codex account
/account          Switch active Codex account
/limits           Show Codex account and model limits
/logs             Show recent runtime request logs
/set-claude-env   Edit Claude Code environment exports
/quit             Quit codex2claudecode
```

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
