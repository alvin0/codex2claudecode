// `bun scripts/codex-models-probe.ts` — lists the models the connected Codex account actually
// offers, so a model id used by the live harness is measured rather than guessed from a display
// name (Requirement 4: probe before relying on a cell).
//
// Why this exists: `test/native/cases.ts` has to name a concrete Codex model id. The account's
// plan can change which ids are served, and a UI label like "GPT-5.3-Codex-Spark" is a display
// name, not necessarily the API id. `CodexStandaloneClient.modelsRaw()` is a GET against
// `CODEX_MODELS_ENDPOINT`, so this costs no inference and no credits.
//
// Credential discipline copied verbatim from `scripts/codex-sampling-probe.ts`: the account is
// resolved into a temp copy via `copyNativeCredentials("codex")`, the real files are only read,
// and a credential whose access token is close to expiry is refused rather than refreshed inside
// a copy that is then discarded (§10.8 finding B).
import { writeTextFile } from "../src/core/bun-fs"
import { redactSensitiveText } from "../src/core/debug-capture"
import { joinPath, makeDir } from "../src/core/paths"
import { accessTokenExpiresAt, readAuthFileData, selectAuthEntry } from "../src/upstream/codex/auth"
import { CodexStandaloneClient } from "../src/upstream/codex/client"
import { DEFAULT_CODEX_CLI_AUTH_FILE, readCodexCliAuthTokens } from "../src/upstream/codex/codex-auth"

import type { NativeCredentialCopy } from "../test/native/credentials"
import { copyNativeCredentials } from "../test/native/credentials"
import { nativeMatrixOutputDir } from "../test/native/matrix-source"

const REFRESH_MARGIN_MS = 120_000

/**
 * Copy of `REASONING_MODEL_PATTERN` (`src/core/reasoning.ts:37`), which is module-private. Copied
 * rather than exported so this probe changes no module surface and no baseline; if the source regex
 * ever moves, this line is the only thing to re-sync.
 */
const REASONING_MODEL_PATTERN = /^(gpt-5(?:\.[^_]+)?)(?:_(none|low|medium|high|xhigh|max|ultra))?$/

const report: string[] = []

async function main() {
  const credentials = await copyNativeCredentials("codex")
  try {
    const credential = await resolveProbeCredential(credentials)
    const client = await CodexStandaloneClient.fromAuthFile(credential.authFile)

    say(`credential copy: ${credential.authFile}`)
    say(`credential source (read-only): ${credential.description}`)
    say(`account: ${credential.accountId ?? "unknown"}`)
    say(`access token expires: ${credential.expiresAt ? new Date(credential.expiresAt).toISOString() : "unknown"}`)
    say("")

    const response = await client.modelsRaw({ signal: AbortSignal.timeout(60_000) })
    const text = await response.text()
    say(`GET codex/models → status ${response.status}`)
    say("")
    say("response body (verbatim, redacted):")
    say("")
    say("```json")
    say(redactSensitiveText(pretty(text)))
    say("```")
    say("")

    for (const id of modelIds(text)) {
      say(`- \`${id}\` — REASONING_MODEL_PATTERN: ${REASONING_MODEL_PATTERN.test(id) ? "MATCHES" : "does NOT match"}`)
    }
    say("")
  } finally {
    await credentials.cleanup().catch(() => {})
    await writeReport()
  }
}

function pretty(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** Every string that looks like a model identifier field, in document order, deduplicated. */
function modelIds(text: string): string[] {
  const ids: string[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (!value || typeof value !== "object") return
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "id" || key === "model" || key === "slug" || key === "model_id") && typeof entry === "string") {
        if (!ids.includes(entry)) ids.push(entry)
      }
      walk(entry)
    }
  }
  try {
    walk(JSON.parse(text))
  } catch {
    // Non-JSON body: nothing to enumerate, the verbatim body above is the record.
  }
  return ids
}

interface ProbeCredential {
  authFile: string
  description: string
  accountId?: string
  expiresAt?: number
}

async function resolveProbeCredential(credentials: NativeCredentialCopy): Promise<ProbeCredential> {
  const copy = await inspectAuthFile(credentials.authFile)
  if (copy && isUsable(copy.expiresAt)) {
    return { authFile: credentials.authFile, description: `harness copy of ${credentials.sourceAuthFile}`, ...copy }
  }
  const snapshot = await readCodexCliAuthTokens()
  if (!isUsable(snapshot.expiresAt)) {
    throw new Error(
      `No Codex credential with a live access token: ${credentials.sourceAuthFile} is unusable and `
      + `${DEFAULT_CODEX_CLI_AUTH_FILE} expires `
      + `${snapshot.expiresAt ? new Date(snapshot.expiresAt).toISOString() : "at an unknown time"}.`,
    )
  }
  const authFile = joinPath(credentials.dir, "auth-codex.json")
  await writeTextFile(
    authFile,
    `${JSON.stringify([{ type: "oauth", access: snapshot.accessToken, refresh: snapshot.refreshToken, expires: snapshot.expiresAt, accountId: snapshot.accountId }], null, 2)}\n`,
    { mode: 0o600 },
  )
  return {
    authFile,
    description: `read-only copy of ${DEFAULT_CODEX_CLI_AUTH_FILE}`,
    accountId: snapshot.accountId,
    expiresAt: snapshot.expiresAt,
  }
}

async function inspectAuthFile(file: string) {
  try {
    const data = await readAuthFileData(file)
    const selected = selectAuthEntry(data.data, process.env.CODEX_AUTH_ACCOUNT, file)
    return {
      accountId: selected.auth.accountId,
      expiresAt: selected.auth.expires ?? accessTokenExpiresAt(selected.auth.access),
    }
  } catch {
    return undefined
  }
}

function isUsable(expiresAt?: number) {
  return expiresAt !== undefined && expiresAt - REFRESH_MARGIN_MS > Date.now()
}

function say(line: string) {
  console.log(line)
  report.push(line)
}

async function writeReport() {
  const dir = nativeMatrixOutputDir()
  const file = joinPath(dir, "codex-models-probe.md")
  await makeDir(dir)
  await writeTextFile(file, `# Codex available models probe\n\n${report.join("\n")}\n`)
  console.log(`\nwrote ${file}`)
}

await main()

export {}
