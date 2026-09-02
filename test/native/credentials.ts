// Role: copy the connected account credentials into a temp directory and point the
// provider manager at the copies (Requirement 24.11). The originals — above all
// `~/.aws/sso/cache/kiro-auth-token.json` — are read and never written.
//
// Two things make that guarantee hold rather than merely intend it:
//   1. the copy keeps the source file name, so provider-state semantics survive, and
//   2. every `sourceAuthFile` / `sourceAccountKey` link is stripped from the copy, which is
//      what `syncKiroSourceAuth()` and `syncCodexCliAuthTokens()` follow to write back.
//
// Stripping the links means the copy has to stand on its own, so a linked Kiro account is
// resolved through `pullKiroSourceAuth()` first — see `inlineKiroSourceCredentials()`.
//
// Codex needs the same treatment for a different reason — see `inlineCodexCliCredentials()`.
import { existsSync } from "node:fs"

import { fileStat, makeTempDir, pathExists, readTextFile, removePath, writeTextFile } from "../../src/core/bun-fs"
import { defaultAuthFile, expandHome, bunPath as path, tempDir } from "../../src/core/paths"
import { isProviderStatePath, providerStatePath } from "../../src/core/provider-state"
import type { JsonObject } from "../../src/core/types"
import { providerHasConnectedAccounts, resolveProviderAuthFile } from "../../src/app/provider-runtime"
import { accessTokenExpiresAt, selectAuthEntry } from "../../src/upstream/codex/auth"
import { DEFAULT_CODEX_CLI_AUTH_FILE, readCodexCliAuthTokens } from "../../src/upstream/codex/codex-auth"
import { REFRESH_SAFETY_MARGIN_MS } from "../../src/upstream/codex/constants"
import type { AuthFileContent, AuthFileData } from "../../src/upstream/codex/types"
import { kiroAuthEntries, pullKiroSourceAuth, readKiroAuthFileSelection } from "../../src/upstream/kiro/account-store"
import { KIRO_AUTH_TOKEN_CLI_PATH, KIRO_AUTH_TOKEN_PATH } from "../../src/upstream/kiro/constants"
import type { KiroAuthTokenFile } from "../../src/upstream/kiro/types"

import type { NativeUpstreamKind } from "./types"

/** Keys the providers follow to write refreshed tokens back into a source file. */
const SOURCE_LINK_KEYS = ["sourceAuthFile", "sourceAccountIndex", "sourceAccountKey"] as const

/** Sibling files the providers read next to a standalone auth file. */
const SIBLING_FILES = [".account-info.json", ".codex-config.json"] as const

/** Kiro account files the harness falls back to when provider state holds no usable entry. */
const KIRO_CREDENTIAL_FALLBACKS = [expandHome(KIRO_AUTH_TOKEN_PATH), expandHome(KIRO_AUTH_TOKEN_CLI_PATH)] as const

/**
 * Files the harness must leave byte-for-byte untouched (Requirement 24.11).
 *
 * The two Codex entries are here because `inlineCodexCliCredentials()` reads
 * `~/.codex/auth.json`, and a read is only provably a read if a test compares the hash and mtime
 * before and after. `~/.codex2claudecode/provider-state.json` is the file every resolved source
 * currently comes from, for both upstreams.
 */
export const NATIVE_PROTECTED_CREDENTIAL_FILES = [
  ...KIRO_CREDENTIAL_FALLBACKS,
  expandHome(DEFAULT_CODEX_CLI_AUTH_FILE),
  providerStatePath(),
].filter((file, index, files) => files.indexOf(file) === index) as readonly string[]

/**
 * A Codex access token closer to expiry than this makes `CodexStandaloneClient` refresh, and a
 * refresh inside a copy that is then discarded burns the account's refresh token for good
 * (`.omc/research/kiro-wire-spike.md` §10.8 finding B). The margin is well above the client's own
 * `REFRESH_SAFETY_MARGIN_MS` so the harness declines a credential the client would try to rotate,
 * rather than discovering the rotation afterwards.
 */
const CODEX_USABLE_TOKEN_MARGIN_MS = Math.max(REFRESH_SAFETY_MARGIN_MS * 4, 120_000)

/** File name of the read-only Codex CLI auth copy placed inside the temp directory. */
const CODEX_CLI_COPY_NAME = "codex-cli-auth.json"

export interface NativeCredentialCopy {
  upstream: NativeUpstreamKind
  /** The account file that was read. Never opened for writing. */
  sourceAuthFile: string
  /** The copy the gateway is pointed at. */
  authFile: string
  /** Set when the copy is a provider-state file, so the runtime reads config from the copy too. */
  providerConfigPath?: string
  /**
   * Human-readable trail of how the credential in the copy was resolved, when it took anything
   * beyond a straight copy. Reported so a red case is read as credential expiry rather than as a
   * fidelity regression.
   */
  notes: string[]
  dir: string
  cleanup: () => Promise<void>
}

export interface CredentialFingerprint {
  path: string
  exists: boolean
  size?: number
  mtimeMs?: number
  sha256?: string
}

/** Candidate account files for an upstream, most-specific first. */
export function nativeCredentialCandidates(upstream: NativeUpstreamKind): string[] {
  const managed = resolveProviderAuthFile(upstream)
  const fallbacks = upstream === "kiro" ? KIRO_CREDENTIAL_FALLBACKS : [defaultAuthFile()]
  return [managed, ...fallbacks].filter((file, index, files) => files.indexOf(file) === index)
}

/**
 * Sync existence check for the skip decision, matching the `existsSync` pattern of
 * `test/live.test.ts` (Requirement 24.2). Says nothing about account contents. Called
 * without an argument it asks whether any connected account file exists at all; the live
 * test narrows per case with the case's own upstream.
 */
export function hasNativeCredentialFile(upstream?: NativeUpstreamKind): boolean {
  const upstreams: NativeUpstreamKind[] = upstream ? [upstream] : ["kiro", "codex"]
  return upstreams.some((mode) => nativeCredentialCandidates(mode).some((file) => existsSync(file)))
}

/** Parses the candidate files and reports whether one of them actually holds an account. */
export async function hasConnectedAccount(upstream?: NativeUpstreamKind): Promise<boolean> {
  const upstreams: NativeUpstreamKind[] = upstream ? [upstream] : ["kiro", "codex"]
  for (const mode of upstreams) {
    if (await resolveNativeCredentialSource(mode)) return true
  }
  return false
}

export async function connectedNativeUpstreams(): Promise<NativeUpstreamKind[]> {
  const upstreams: NativeUpstreamKind[] = ["kiro", "codex"]
  const connected: NativeUpstreamKind[] = []
  for (const mode of upstreams) {
    if (await resolveNativeCredentialSource(mode)) connected.push(mode)
  }
  return connected
}

/** First candidate file that holds at least one connected account the harness can actually use. */
export async function resolveNativeCredentialSource(upstream: NativeUpstreamKind): Promise<string | undefined> {
  for (const candidate of nativeCredentialCandidates(upstream)) {
    if (!(await pathExists(candidate))) continue
    if (!(await providerHasConnectedAccounts(upstream, { authFile: candidate }))) continue
    if (upstream === "kiro" && !(await kiroCandidateIsReachable(candidate))) continue
    return candidate
  }
  return undefined
}

/**
 * `providerHasConnectedAccounts()` answers "is an entry present", not "can it be used". A Kiro
 * entry in `provider-state.json` can be a link whose `sourceAuthFile` target no longer exists —
 * a leftover from an earlier bootstrap run, carrying placeholder tokens. The runtime repairs that
 * by reconnecting the standalone auth file into provider state, which is a write the harness must
 * not make, so the harness skips the candidate and falls through to the standalone file instead.
 * A live link stays eligible: `inlineKiroSourceCredentials()` resolves it into the copy.
 */
async function kiroCandidateIsReachable(candidate: string): Promise<boolean> {
  const selection = await readKiroAuthFileSelection(candidate).catch(() => undefined)
  if (!selection) return false
  const entries = kiroAuthEntries(selection.data)
  const reachable = await Promise.all(
    entries.map(async (entry) => !entry.sourceAuthFile || (await pathExists(expandHome(entry.sourceAuthFile)))),
  )
  return reachable.some(Boolean)
}

export interface CopyNativeCredentialsOptions {
  /** Copy this file instead of the resolved account file. Used by the offline tests. */
  sourceAuthFile?: string
}

export async function copyNativeCredentials(
  upstream: NativeUpstreamKind,
  options: CopyNativeCredentialsOptions = {},
): Promise<NativeCredentialCopy> {
  const sourceAuthFile = options.sourceAuthFile
    ? expandHome(options.sourceAuthFile)
    : await resolveNativeCredentialSource(upstream)
  if (!sourceAuthFile) {
    throw new Error(`No connected ${upstream} account found in ${nativeCredentialCandidates(upstream).join(", ")}`)
  }

  const dir = await makeTempDir(path.join(tempDir(), "native-live-credentials-"))
  const fileName = baseName(sourceAuthFile)
  const authFile = path.join(dir, fileName)
  const providerState = isProviderStatePath(sourceAuthFile)
  const parsed = parseJson(await readTextFile(sourceAuthFile), sourceAuthFile)
  const inlined = upstream === "kiro" ? await inlineKiroSourceCredentials(sourceAuthFile, parsed) : parsed

  // Link stripping happens before the Codex step, not after: the fallback deliberately *adds* one
  // link back, pointing inside `dir`, and a later strip would remove it again.
  const stripped = providerState ? providerStateCopy(upstream, inlined) : stripSourceLinks(inlined)
  const resolved = upstream === "codex"
    ? await inlineCodexCliCredentials(dir, sourceAuthFile, providerState, stripped)
    : { payload: stripped, notes: [] as string[] }

  await writeTextFile(authFile, `${JSON.stringify(resolved.payload, null, 2)}\n`, { mode: 0o600 })

  if (!providerState) await copySiblings(sourceAuthFile, dir)

  return {
    upstream,
    sourceAuthFile,
    authFile,
    ...(providerState ? { providerConfigPath: authFile } : {}),
    notes: resolved.notes,
    dir,
    cleanup: () => removePath(dir, { recursive: true, force: true }),
  }
}

interface ResolvedCredentialPayload {
  payload: unknown
  notes: string[]
}

/**
 * The Codex counterpart of `inlineKiroSourceCredentials()`, solving the same problem — the copy
 * has to stand on its own — from the opposite direction.
 *
 * Kiro's copy fails because the live tokens are behind a link the copy is not allowed to keep.
 * Codex's copy fails because the tokens are *in* the entry but already expired, and the only way
 * to renew them is a refresh: the upstream rotates the refresh token, the copy receives the new
 * one, and then the copy is thrown away while the real file keeps the consumed token. That account
 * answers `refresh_token_reused` from then on. So a refresh inside a copy is not an option, and an
 * expired entry cannot be repaired — it can only be replaced by an entry that is already live
 * (`.omc/research/kiro-wire-spike.md` §10.8 finding B).
 *
 * `~/.codex/auth.json` holds such an entry. `pullCodexCliAuthTokens()` correctly refuses to use it
 * at runtime, because its account id differs from the account in provider state and silently
 * swapping accounts under a user is wrong. For a measurement harness the trade is the other way
 * round: any live Codex account measures Codex fidelity equally well, and the alternative is a
 * blocked gate. The swap is therefore explicit, recorded in `notes`, and never inferred.
 *
 * Three properties keep this read-only with respect to every real file:
 *
 *   1. `~/.codex/auth.json` is read through `readCodexCliAuthTokens()` and never written. Both it
 *      and `~/.codex2claudecode/provider-state.json` are in `NATIVE_PROTECTED_CREDENTIAL_FILES`,
 *      so the guard case in `live.test.ts` compares their hash and mtime across the whole run.
 *   2. The replacement entry carries `sourceAuthFile` pointing at a copy of the CLI file inside
 *      `dir`. That is the one path `CodexStandaloneClient` follows both to read a source before a
 *      refresh and to write refreshed tokens back (`syncCodexCliAuthTokens({ path: sourceAuthFile
 *      ?? codexAuthFile })`). Left unset, that write-back would default to the real
 *      `~/.codex/auth.json` and would match on account id. Pointed at the temp copy, it cannot.
 *   3. The fallback is taken only when the CLI token stays live past
 *      `CODEX_USABLE_TOKEN_MARGIN_MS`, which is well beyond the client's own refresh margin — so
 *      no refresh is attempted during the run and no token is rotated in the first place.
 *
 * When neither entry is usable the payload is returned unchanged with a note saying so. The cases
 * then fail on auth, which is the honest outcome; inventing a credential is not.
 */
async function inlineCodexCliCredentials(
  dir: string,
  sourceAuthFile: string,
  providerState: boolean,
  payload: unknown,
): Promise<ResolvedCredentialPayload> {
  const entries = codexEntries(providerState, payload)
  const current = codexSelectedEntry(entries, sourceAuthFile)
  const currentExpiresAt = current ? current.expires ?? accessTokenExpiresAt(current.access) : undefined
  if (current && isCodexTokenUsable(currentExpiresAt)) return { payload, notes: [] }

  const reason = current
    ? `${sourceAuthFile} holds a Codex access token that expired ${describeExpiry(currentExpiresAt)}, and refreshing it inside a discarded copy would burn the account's refresh token`
    : `${sourceAuthFile} holds no usable Codex oauth entry`

  const snapshot = await readCodexCliAuthTokens().catch(() => undefined)
  if (!snapshot || !isCodexTokenUsable(snapshot.expiresAt)) {
    return {
      payload,
      notes: [
        `codex credential unusable: ${reason}; ${DEFAULT_CODEX_CLI_AUTH_FILE} `
        + `${snapshot ? `expires ${describeExpiry(snapshot.expiresAt)}` : "is unreadable or not a chatgpt auth file"}. `
        + "Reconnect the Codex account to unblock the codex live cases.",
      ],
    }
  }

  // The write-back sink, inside the temp directory. Same shape as the real CLI file so
  // `pullCodexCliAuthTokens()` can parse it, and same content, so `codexSourceAuthChanged()`
  // reports no change and nothing is applied from it.
  const cliCopy = path.join(dir, CODEX_CLI_COPY_NAME)
  await writeTextFile(
    cliCopy,
    `${JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        ...(snapshot.accountId ? { account_id: snapshot.accountId } : {}),
        access_token: snapshot.accessToken,
        refresh_token: snapshot.refreshToken,
      },
    }, null, 2)}\n`,
    { mode: 0o600 },
  )

  const replacement: AuthFileContent = {
    type: "oauth",
    access: snapshot.accessToken,
    refresh: snapshot.refreshToken,
    ...(snapshot.expiresAt === undefined ? {} : { expires: snapshot.expiresAt }),
    ...(snapshot.accountId ? { accountId: snapshot.accountId, sourceAccountKey: snapshot.accountId } : {}),
    sourceAuthFile: cliCopy,
  }

  return {
    payload: withCodexEntries(providerState, payload, [replacement]),
    notes: [
      `codex credential substituted: ${reason}. Replaced with a read-only copy of `
      + `${DEFAULT_CODEX_CLI_AUTH_FILE} (a different account, access token live until `
      + `${describeExpiry(snapshot.expiresAt)}); write-back redirected to ${cliCopy}.`,
    ],
  }
}

/** The Codex oauth entries inside a copy payload, whichever of the two shapes it has. */
function codexEntries(providerState: boolean, payload: unknown): AuthFileData {
  const data = providerState ? asObject(asObject(payload).codex).data : payload
  if (Array.isArray(data)) return data as AuthFileData
  return isObject(data) ? [data as unknown as AuthFileContent] : []
}

function withCodexEntries(providerState: boolean, payload: unknown, entries: AuthFileContent[]): unknown {
  if (!providerState) return entries
  const state = asObject(payload)
  return { ...state, codex: { ...asObject(state.codex), data: entries } }
}

/** Mirrors `selectAuthEntry()` so the harness inspects the entry the client will actually pick. */
function codexSelectedEntry(entries: AuthFileData, sourceAuthFile: string): AuthFileContent | undefined {
  try {
    return selectAuthEntry(entries, process.env.CODEX_AUTH_ACCOUNT, sourceAuthFile).auth
  } catch {
    return undefined
  }
}

function isCodexTokenUsable(expiresAt?: number) {
  return expiresAt !== undefined && expiresAt - CODEX_USABLE_TOKEN_MARGIN_MS > Date.now()
}

function describeExpiry(expiresAt?: number) {
  return expiresAt === undefined ? "at an unknown time" : new Date(expiresAt).toISOString()
}

/**
 * Keeps only the section for this upstream, drops the endpoint-proxy map so every endpoint
 * resolves to `self`, and strips source links. A harness run therefore exercises exactly one
 * upstream regardless of how the developer's own gateway is configured.
 */
function providerStateCopy(upstream: NativeUpstreamKind, payload: unknown): JsonObject {
  const state = asObject(payload)
  const section = asObject(state[upstream])
  const { endpointProxy: _endpointProxy, ...rest } = section
  return {
    provider: upstream,
    [upstream]: {
      ...stripSourceLinks(rest),
      ...(section.data === undefined ? {} : { data: stripSourceLinks(section.data) }),
    },
  }
}

/**
 * A Kiro account in `provider-state.json` can be a *link* rather than a credential: the entry
 * holds placeholder tokens plus `sourceAuthFile` / `sourceAccountKey`, and the runtime pulls the
 * live tokens out of that file with `pullKiroSourceAuth()` before it calls the upstream
 * (`KiroAuthManager.refresh()` follows the same link). The copy strips those links so nothing can
 * write back — which on its own would hand the harness the placeholders and fail every Kiro case
 * with `Kiro Desktop Auth refresh failed: 401 Bad credentials`.
 *
 * So the pull happens here instead, before the links are stripped. `pullKiroSourceAuth()` only
 * reads, so the protected files stay byte-identical (Requirement 24.11), and the copy ends up
 * holding what the runtime would have used.
 */
async function inlineKiroSourceCredentials(sourceAuthFile: string, payload: unknown): Promise<unknown> {
  if (!isProviderStatePath(sourceAuthFile)) return pullKiroAccountData(sourceAuthFile, payload)

  const state = asObject(payload)
  const section = asObject(state.kiro)
  if (section.data === undefined) return payload
  return { ...state, kiro: { ...section, data: await pullKiroAccountData(sourceAuthFile, section.data) } }
}

/** Applies the pull across all three shapes a Kiro auth payload can take. */
async function pullKiroAccountData(authFile: string, data: unknown): Promise<unknown> {
  if (Array.isArray(data)) return Promise.all(data.map((account) => pullKiroAccount(authFile, account)))

  const section = asObject(data)
  if (Array.isArray(section.accounts)) {
    return { ...section, accounts: await Promise.all(section.accounts.map((account) => pullKiroAccount(authFile, account))) }
  }
  return pullKiroAccount(authFile, data)
}

async function pullKiroAccount(authFile: string, account: unknown): Promise<unknown> {
  if (!isObject(account) || typeof account.sourceAuthFile !== "string") return account
  // `undefined` means "source unchanged or unreadable", in which case the entry already carries
  // whatever the runtime would have used.
  const pulled = await pullKiroSourceAuth(authFile, account as unknown as KiroAuthTokenFile).catch(() => undefined)
  return pulled ?? account
}

function stripSourceLinks<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => stripSourceLinks(entry)) as unknown as T
  if (!isObject(value)) return value
  const next: JsonObject = {}
  for (const [key, entry] of Object.entries(value)) {
    if ((SOURCE_LINK_KEYS as readonly string[]).includes(key)) continue
    next[key] = stripSourceLinks(entry)
  }
  return next as unknown as T
}

async function copySiblings(sourceAuthFile: string, dir: string) {
  for (const sibling of SIBLING_FILES) {
    const file = path.join(path.dirname(sourceAuthFile), sibling)
    if (!(await pathExists(file))) continue
    await writeTextFile(path.join(dir, sibling), await readTextFile(file), { mode: 0o600 })
  }
}

/** Content hash plus mtime, so a test can prove a protected file was not touched. */
export async function credentialFingerprint(file: string): Promise<CredentialFingerprint> {
  if (!(await pathExists(file))) return { path: file, exists: false }
  const stat = await fileStat(file)
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(await readTextFile(file))
  return { path: file, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash.digest("hex") }
}

export async function protectedCredentialFingerprints(): Promise<CredentialFingerprint[]> {
  return Promise.all(NATIVE_PROTECTED_CREDENTIAL_FILES.map((file) => credentialFingerprint(file)))
}

function parseJson(raw: string, file: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Failed to parse ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {}
}

function baseName(file: string) {
  return file.split(/[\\/]/).filter(Boolean).at(-1) ?? file
}
