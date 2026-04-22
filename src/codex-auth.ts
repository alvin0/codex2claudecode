import { readFile, writeFile } from "node:fs/promises"

import { extractAccountId } from "./auth"
import { expandHome } from "./paths"

export const DEFAULT_CODEX_CLI_AUTH_FILE = "~/.codex/auth.json"

export interface CodexCliAuthFile {
  auth_mode?: string
  tokens?: {
    access_token?: string
    refresh_token?: string
    account_id?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export async function readCodexCliAuthFile(path = DEFAULT_CODEX_CLI_AUTH_FILE) {
  return JSON.parse(await readFile(expandHome(path), "utf8")) as CodexCliAuthFile
}

export function codexCliAuthAccountId(auth: CodexCliAuthFile) {
  return cleanToken(auth.tokens?.account_id) || extractAccountId({
    access_token: cleanToken(auth.tokens?.access_token),
    refresh_token: cleanToken(auth.tokens?.refresh_token),
  })
}

export async function syncCodexCliAuthTokens(input: { accountId?: string; accessToken: string; refreshToken: string; path?: string }) {
  if (!input.accountId) return false

  let auth: CodexCliAuthFile
  try {
    auth = await readCodexCliAuthFile(input.path)
  } catch {
    return false
  }

  if (auth.auth_mode && auth.auth_mode !== "chatgpt") return false
  if (!auth.tokens) return false
  if (codexCliAuthAccountId(auth) !== input.accountId) return false

  await writeFile(
    expandHome(input.path ?? DEFAULT_CODEX_CLI_AUTH_FILE),
    `${JSON.stringify({
      ...auth,
      tokens: {
        ...auth.tokens,
        account_id: input.accountId,
        access_token: input.accessToken,
        refresh_token: input.refreshToken,
      },
    } satisfies CodexCliAuthFile, null, 2)}\n`,
  )

  return true
}

function cleanToken(value?: string) {
  return (value ?? "").trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, "")
}
