// `bun run probe:codex:sampling` — measurement for the Codex `sampling` and `outputLength`
// capability cells (Requirement 4: probe every unmeasured cell before relying on it).
//
// Why this probe exists. Run_Record 16 recorded the live gate answering
// `400 {"detail":"Unsupported parameter: temperature"}` and
// `400 {"detail":"Unsupported parameter: max_output_tokens"}` once task 15.1 started emitting
// those fields. That makes `features.sampling: "native"` and `features.outputLength: "native"` in
// `src/upstream/codex/capabilities.ts` unmeasured claims — and RR16 carried item 1 says the fix is
// a decision, not a mechanical edit. This script supplies the number that decision needs and
// nothing else: it changes no capability, no requirement, no live case, no `src/` behaviour.
//
// Design, following §10 (`scripts/codex-effort-probe.ts`) with the minimum number of live calls:
//
//   1. control     — no candidate field at all, so "what does this endpoint do unconstrained"
//                    has an answer to compare against.
//   2. temperature — alone.
//   3. top_p       — alone.
//   4. max_output_tokens — alone.
//   5. composite   — every field that survived runs 2–4, together, to check they compose. Skipped
//                    entirely when nothing survived, which costs zero calls.
//
// One field per run is what makes the result readable: a body carrying all three and answering
// `Unsupported parameter: temperature` says nothing about `top_p`, because this endpoint names only
// the first offender it finds. Per-field acceptance needs per-field runs.
//
// A rejected field is then re-tried once on a second model. That is not extra spend in any
// meaningful sense — a rejection is a 400 before the model runs, so it bills nothing — and it is
// the only way to separate "this endpoint refuses the parameter" from "this model refuses the
// parameter", which are different cells: the first is `degrade` for everyone, the second is a
// per-model split the matrix has no way to express.
//
// Two rules inherited verbatim from the effort probe:
//
//   1. **The headers and URL are the product's, not the script's.** `CodexStandaloneClient` builds
//      them; the injected `fetch` records and forwards.
//   2. **The body is the probe's.** `CodexStandaloneClient.request()` runs every body through
//      `normalizeReasoningBody()`, which rewrites `model` and injects `reasoning`. Here that
//      rewrite is noise rather than the subject, so the injected `fetch` swaps in the probe's raw
//      bytes and records what the product would have sent next to it. Holding `reasoning` constant
//      across all runs is what keeps "exactly one field differs" true.
//
// Acceptance is not the whole question. A 200 can still mean the parameter was swallowed and
// ignored, which is `degrade`, not `native`. So each run records the endpoint's own echo of
// `temperature` / `top_p` / `max_output_tokens` from `response.created` and from the terminal
// event, and the `max_output_tokens` run uses a deliberately tiny limit against a prompt that wants
// a long answer — if the limit is honoured the stream ends `incomplete` with
// `incomplete_details.reason: "max_output_tokens"`, and if it is ignored the full answer arrives.
//
// Credentials come from a copy: `copyNativeCredentials("codex")` resolves the live account into a
// temp directory, and `~/.aws/sso/cache/kiro-auth-token.json` is never opened at all. Bodies pass
// through `redactSensitiveText`, and header *values* are never printed — only names.
//
// Output goes to stdout and to `$NATIVE_TRANSCRIPT_DIR/codex-sampling-probe.md` (default
// `.native-transcripts/`, gitignored). Writing the research section is the caller's job.
import { writeTextFile } from "../src/core/bun-fs"
import { redactSensitiveText } from "../src/core/debug-capture"
import { joinPath, makeDir } from "../src/core/paths"
import { consumeCodexSse, parseSseJson } from "../src/core/sse"
import type { JsonObject } from "../src/core/types"
import { accessTokenExpiresAt, readAuthFileData, selectAuthEntry } from "../src/upstream/codex/auth"
import { CodexStandaloneClient } from "../src/upstream/codex/client"
import { DEFAULT_CODEX_CLI_AUTH_FILE, readCodexCliAuthTokens } from "../src/upstream/codex/codex-auth"
import { DEFAULT_CODEX_ENDPOINT } from "../src/upstream/codex/constants"

import type { NativeCredentialCopy } from "../test/native/credentials"
import { copyNativeCredentials } from "../test/native/credentials"
import { nativeMatrixOutputDir } from "../test/native/matrix-source"

/**
 * The model the live cases actually use, minus the `_low` effort suffix
 * `normalizeReasoningModel()` strips (`NATIVE_CODEX_MODEL` in `test/native/cases.ts` is
 * `gpt-5.3-codex-spark_low`). Probing the gate's own model is the point — a result on some other
 * model would not explain the gate, which is exactly why this default has to follow
 * `NATIVE_CODEX_MODEL` rather than stay pinned to the model an earlier run happened to use. The
 * account is now restricted to `GPT-5.3-Codex-Spark`; the id below is its measured `slug`, from
 * `bun scripts/codex-models-probe.ts`, not a transliteration of the display name.
 */
const MODEL = process.env.CODEX_SAMPLING_PROBE_MODEL ?? "gpt-5.3-codex-spark"

/**
 * Second model, used only to re-test fields the primary model rejected. Set it empty to skip that
 * phase, which is what a follow-up run does once the primary model has already answered.
 *
 * The first run pointed this at `gpt-5-codex`, because §10.3 flagged it as the model *outside*
 * `normalizeReasoningModel()`'s regex and so the likeliest place a per-model split would surface.
 * All three attempts came back `400 {"detail":"The 'gpt-5-codex' model is not supported when using
 * Codex with a ChatGPT account."}` — a model-availability rejection that never reached parameter
 * validation, so it attributes nothing. `ListAvailableModels` on this account offers `gpt-5.6-sol`,
 * `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-reserve`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` and
 * `codex-auto-review` — a list this run re-measured verbatim, now also carrying
 * `gpt-5.3-codex-spark`.
 *
 * Now defaults to **empty**, i.e. phase 3 is off. The account is restricted to
 * `GPT-5.3-Codex-Spark`, so any second model would answer with a model-availability rejection
 * before parameter validation — the exact outcome the paragraph above records for `gpt-5-codex`,
 * and one that attributes nothing. Set `CODEX_SAMPLING_PROBE_MODEL_B` to re-enable it if a second
 * model becomes permitted.
 */
const FALLBACK_MODEL = process.env.CODEX_SAMPLING_PROBE_MODEL_B ?? ""

const TIMEOUT_MS = Number(process.env.CODEX_SAMPLING_PROBE_TIMEOUT_MS ?? 180_000)

/**
 * One prompt, identical in every run. It has to want an answer long enough that a small
 * `max_output_tokens` visibly truncates it — otherwise "limit honoured" and "limit ignored" produce
 * the same short reply and the run measures nothing. Primes are cheap to generate and need no
 * reasoning, which keeps the control run's spend near the floor.
 */
const PROMPT = process.env.CODEX_SAMPLING_PROBE_PROMPT
  ?? "List the first 40 prime numbers as a plain comma-separated sequence. No commentary, no explanation."

const INSTRUCTIONS = "Answer directly and follow the requested format exactly."

/**
 * Held constant across every run so it cannot be confused for the variable under test. `low`
 * because reasoning volume is not being measured here and it is the cheapest level.
 */
const REASONING: JsonObject = { effort: "low" }

/**
 * Small on purpose: the Responses API floor is 16, and the closer the limit sits to the floor the
 * more unmistakable a truncation is against a 40-number answer.
 */
const MAX_OUTPUT_TOKENS = Number(process.env.CODEX_SAMPLING_PROBE_MAX_OUTPUT_TOKENS ?? 16)

/** Same values the `sampling-degrade` live case sends, so the probe explains that case directly. */
const TEMPERATURE = 0.2
const TOP_P = 0.9

/** The three fields `codexSamplingFields()` (`src/upstream/codex/sampling.ts`) can emit. */
const ALL_CANDIDATE_FIELDS = ["temperature", "top_p", "max_output_tokens"] as const
type CandidateField = (typeof ALL_CANDIDATE_FIELDS)[number]

/**
 * Narrowing knob, added after the first run. Once all three fields are measured as rejected on one
 * model, confirming the rejection is endpoint-level rather than model-level needs **one** field on
 * **one** more model, not another full sweep. Restricting the set is what keeps the follow-up at two
 * calls instead of five.
 */
const CANDIDATE_FIELDS: readonly CandidateField[] = (() => {
  const requested = process.env.CODEX_SAMPLING_PROBE_FIELDS?.split(",").map((field) => field.trim()).filter(Boolean)
  if (!requested?.length) return ALL_CANDIDATE_FIELDS
  const unknown = requested.filter((field) => !(ALL_CANDIDATE_FIELDS as readonly string[]).includes(field))
  if (unknown.length) throw new Error(`Unknown candidate field(s): ${unknown.join(", ")}`)
  return requested as CandidateField[]
})()

const CANDIDATE_VALUES: Record<CandidateField, JsonObject> = {
  temperature: { temperature: TEMPERATURE },
  top_p: { top_p: TOP_P },
  max_output_tokens: { max_output_tokens: MAX_OUTPUT_TOKENS },
}

interface ProbeRun {
  id: string
  label: string
  model: string
  /** The candidate field(s) this run carries. Empty for the control. */
  fields: JsonObject
  /** Which cell this run informs, for the report. */
  subject: CandidateField | "control" | "composite"
}

interface RunResult {
  run: ProbeRun
  sentBody: string
  /** What `normalizeReasoningBody()` would have put on the wire for the same input. */
  normalizedBody?: string
  status?: number
  /** Verbatim response body for a non-2xx, redacted but not reworded. */
  errorBody?: string
  transportError?: string
  durationMs: number
  eventCounts: Record<string, number>
  outputTextDoneChars: number
  outputTextDeltaChars: number
  finalOutputChars: number
  /** The endpoint's echo of the candidate parameters — the accepted-vs-ignored signal. */
  createdEcho?: string
  terminalEcho?: string
  terminalType?: string
  incompleteReason?: string
  usage?: string
  failures: string[]
}

/** Set immediately before each `client.proxy()` call; read by the injected `fetch`. */
let pendingBody: string | undefined
let observedUrl: string | undefined
let observedHeaderNames: string[] = []
let observedNormalizedBody: string | undefined
let upstreamCalls = 0

const report: string[] = []

async function main() {
  const credentials = await copyNativeCredentials("codex")
  try {
    const credential = await resolveProbeCredential(credentials)
    const client = await CodexStandaloneClient.fromAuthFile(credential.authFile, {
      fetch: probeFetch as unknown as typeof fetch,
    })

    say(`credential copy: ${credential.authFile}`)
    say(`credential source (read-only): ${credential.description}`)
    say(`account: ${credential.accountId ?? "unknown"}`)
    say(`access token expires: ${credential.expiresAt ? new Date(credential.expiresAt).toISOString() : "unknown"}`)
    say(`primary model: ${MODEL}`)
    say(`fallback model (rejected fields only): ${FALLBACK_MODEL}`)
    say(`constant reasoning field (all runs): ${JSON.stringify(REASONING)}`)
    say(`timeout: ${TIMEOUT_MS} ms`)
    say("")
    say("prompt (identical in every run):")
    say("")
    say("```")
    say(PROMPT)
    say("```")
    say("")

    // Phase 1: control first, so the per-field runs have a baseline to be read against.
    const results: RunResult[] = []
    results.push(await measureRun(client, {
      id: "1-control",
      label: "no candidate field",
      model: MODEL,
      fields: {},
      subject: "control",
    }))

    for (const [index, field] of CANDIDATE_FIELDS.entries()) {
      results.push(await measureRun(client, {
        id: `${index + 2}-${field}`,
        label: `${field} only — ${JSON.stringify(CANDIDATE_VALUES[field])}`,
        model: MODEL,
        fields: CANDIDATE_VALUES[field],
        subject: field,
      }))
    }

    const accepted = CANDIDATE_FIELDS.filter((field) => isAccepted(results, field))
    const rejected = CANDIDATE_FIELDS.filter((field) => !isAccepted(results, field))

    // Phase 2: composite. Only worth a call when at least two fields survived — one surviving
    // field composes with nothing, and its single-field run already measured it.
    if (accepted.length > 1) {
      results.push(await measureRun(client, {
        id: "5-composite",
        label: `every accepted field together — ${accepted.join(", ")}`,
        model: MODEL,
        fields: Object.assign({}, ...accepted.map((field) => CANDIDATE_VALUES[field])) as JsonObject,
        subject: "composite",
      }))
    } else {
      say(`## run 5-composite — skipped`)
      say("")
      say(
        accepted.length === 0
          ? `Zero fields accepted on ${MODEL}, so there is nothing to compose. No call spent.`
          : `Only \`${accepted[0]}\` accepted on ${MODEL}; a single field composes with nothing and its own run already measured it. No call spent.`,
      )
      say("")
    }

    // Phase 3: re-test each rejected field on a second model. A rejection is a 400 before the
    // model runs, so this is close to free, and it is the only thing that separates an
    // endpoint-level refusal from a model-level one.
    const fallbackResults: RunResult[] = []
    for (const [index, field] of (FALLBACK_MODEL ? rejected : []).entries()) {
      fallbackResults.push(await measureRun(client, {
        id: `6.${index + 1}-${field}-${FALLBACK_MODEL}`,
        label: `${field} only on ${FALLBACK_MODEL} — ${JSON.stringify(CANDIDATE_VALUES[field])}`,
        model: FALLBACK_MODEL,
        fields: CANDIDATE_VALUES[field],
        subject: field,
      }))
    }
    if (rejected.length === 0 || !FALLBACK_MODEL) {
      say("## phase 3 — skipped")
      say("")
      say(
        rejected.length === 0
          ? `Every candidate field was accepted on ${MODEL}, so there is no rejection to attribute to a model. No call spent.`
          : "Second model disabled by `CODEX_SAMPLING_PROBE_MODEL_B=`. No call spent.",
      )
      say("")
    }

    say(`endpoint: ${observedUrl ?? "unknown"}`)
    say(`headers built by CodexStandaloneClient: ${observedHeaderNames.join(", ") || "none captured"}`)
    say("")

    renderSummary(results, fallbackResults)
  } finally {
    await credentials.cleanup().catch(() => {})
    await writeReport()
  }
}

/** A run counts as acceptance only on a 2xx. Everything else — 400, transport error — is not. */
function isAccepted(results: RunResult[], field: CandidateField) {
  const result = results.find((entry) => entry.run.subject === field && entry.run.model === MODEL)
  return result?.status !== undefined && result.status >= 200 && result.status < 300
}

interface ProbeCredential {
  authFile: string
  description: string
  accountId?: string
  expiresAt?: number
}

/** A token this close to expiry would trigger a refresh, which is the thing to avoid. */
const REFRESH_MARGIN_MS = 120_000

/**
 * Prefers the harness copy and only falls back when its access token is already dead, so the
 * common case stays on the documented path and the fallback is visible in the report. Identical in
 * intent to the effort probe's helper, and for the identical reason: a refresh performed inside a
 * copy that is then discarded rotates the upstream refresh token while the real file keeps the
 * consumed one (§10.8 finding B).
 */
async function resolveProbeCredential(credentials: NativeCredentialCopy): Promise<ProbeCredential> {
  const copy = await inspectAuthFile(credentials.authFile)
  if (copy && isUsable(copy.expiresAt)) {
    return { authFile: credentials.authFile, description: `harness copy of ${credentials.sourceAuthFile}`, ...copy }
  }

  const reason = copy
    ? `access token expired ${copy.expiresAt ? new Date(copy.expiresAt).toISOString() : "at an unknown time"}, and refreshing it would need a refresh token the harness copy cannot rotate`
    : "no usable oauth entry"
  const snapshot = await readCodexCliAuthTokens()
  if (!isUsable(snapshot.expiresAt)) {
    throw new Error(
      `No Codex credential with a live access token: ${credentials.sourceAuthFile} has ${reason}, `
      + `and ${DEFAULT_CODEX_CLI_AUTH_FILE} expires ${snapshot.expiresAt ? new Date(snapshot.expiresAt).toISOString() : "at an unknown time"}. `
      + "Reconnect the Codex account, then re-run the probe.",
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
    description: `read-only copy of ${DEFAULT_CODEX_CLI_AUTH_FILE} — fell back because ${credentials.sourceAuthFile} has ${reason}`,
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

/**
 * Records the request `CodexStandaloneClient` built, then replaces the body with the probe's raw
 * bytes for the one POST under test. Every other request the client makes — above all the OAuth
 * refresh — is forwarded untouched.
 */
function probeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== DEFAULT_CODEX_ENDPOINT || pendingBody === undefined) return fetch(input as RequestInfo, init)

  upstreamCalls += 1
  observedUrl = url
  observedHeaderNames = [...new Headers(init?.headers).keys()].sort()
  observedNormalizedBody = typeof init?.body === "string" ? init.body : undefined
  return fetch(url, { ...init, body: pendingBody })
}

/**
 * Everything outside `run.fields` is byte-identical between runs. `stream: true` because
 * Run_Record 3 measured `400 {"detail":"Stream must be set to true"}` on the non-streaming path.
 */
function probeBody(run: ProbeRun): JsonObject {
  return {
    model: run.model,
    reasoning: REASONING,
    instructions: INSTRUCTIONS,
    input: [{ role: "user", content: [{ type: "input_text", text: PROMPT }] }],
    store: false,
    stream: true,
    ...run.fields,
  }
}

async function measureRun(client: CodexStandaloneClient, run: ProbeRun): Promise<RunResult> {
  const body = JSON.stringify(probeBody(run))
  const result: RunResult = {
    run,
    sentBody: body,
    durationMs: 0,
    eventCounts: {},
    outputTextDoneChars: 0,
    outputTextDeltaChars: 0,
    finalOutputChars: 0,
    failures: [],
  }

  const started = Date.now()
  pendingBody = body
  observedNormalizedBody = undefined
  try {
    const response = await client.proxy(probeBody(run), { signal: AbortSignal.timeout(TIMEOUT_MS) })
    result.status = response.status
    result.normalizedBody = observedNormalizedBody

    if (!response.ok) {
      // Verbatim, because the exact wording is the measurement: RR16 quotes
      // `{"detail":"Unsupported parameter: temperature"}` and the field name inside it is what
      // attributes the rejection.
      result.errorBody = redactSensitiveText((await response.text()).slice(0, 2000))
      result.failures.push(`HTTP ${response.status}: ${result.errorBody}`)
    } else {
      await consumeCodexSse(response.body, (event) => applyEvent(event.data, result))
    }
  } catch (error) {
    result.transportError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    result.normalizedBody = observedNormalizedBody
  } finally {
    pendingBody = undefined
    result.durationMs = Date.now() - started
  }

  report.push(renderRun(result))
  return result
}

function applyEvent(raw: string, result: RunResult) {
  const data = parseSseJson({ data: raw })
  if (!data) return
  const type = typeof data.type === "string" ? data.type : "(untyped)"
  result.eventCounts[type] = (result.eventCounts[type] ?? 0) + 1

  if (type === "response.output_text.delta" && typeof data.delta === "string") {
    result.outputTextDeltaChars += data.delta.length
    return
  }
  if (type === "response.output_text.done" && typeof data.text === "string") {
    result.outputTextDoneChars += data.text.length
    return
  }
  if (type === "response.created") {
    result.createdEcho = echoOf(asObject(data.response))
    return
  }
  if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
    const response = asObject(data.response)
    result.terminalType = type
    result.terminalEcho = echoOf(response)
    if (response.usage !== undefined) result.usage = compact(response.usage)
    if (Array.isArray(response.output)) result.finalOutputChars = finalOutputChars(response.output)
    const details = asObject(response.incomplete_details)
    if (typeof details.reason === "string") result.incompleteReason = details.reason
    if (type === "response.failed") {
      result.failures.push(`${type}: ${compact(response.error) ?? "no detail"}`)
    }
    return
  }
  if (type === "error") result.failures.push(`error event: ${compact(data) ?? ""}`)
}

/**
 * What the API says it accepted for this request. This is the accepted-versus-ignored discriminator:
 * a 200 whose echo shows the endpoint's default rather than the value sent is `degrade`, not
 * `native`. RR16 warns that a field appearing in the *response* object is not evidence it was
 * accepted as a *request* parameter, so the echo is only ever read next to the status.
 */
function echoOf(response: JsonObject) {
  return compact({
    model: response.model,
    temperature: response.temperature,
    top_p: response.top_p,
    max_output_tokens: response.max_output_tokens,
    status: response.status,
  })
}

function finalOutputChars(output: unknown[]) {
  let chars = 0
  for (const item of output) {
    const outputItem = asObject(item)
    if (outputItem.type !== "message" || !Array.isArray(outputItem.content)) continue
    for (const block of outputItem.content) {
      const content = asObject(block)
      if (content.type === "output_text" && typeof content.text === "string") chars += content.text.length
    }
  }
  return chars
}

function renderRun(result: RunResult) {
  const lines = [
    `## run ${result.run.id} — ${result.run.label}`,
    "",
    `subject: ${result.run.subject} · model: ${result.run.model}`,
    "",
    "body sent (verbatim bytes on the wire):",
    "",
    "```json",
    redactSensitiveText(JSON.stringify(JSON.parse(result.sentBody), null, 2)),
    "```",
    "",
    result.normalizedBody
      ? `body \`normalizeReasoningBody()\` would have sent instead: \`${redactSensitiveText(result.normalizedBody).replace(/\\n/g, " ").slice(0, 400)}\``
      : "body `normalizeReasoningBody()` would have sent instead: not captured",
    "",
    result.transportError ? `transport error: ${result.transportError}` : `status: ${result.status}`,
    `duration: ${result.durationMs} ms`,
    "",
    result.errorBody ? `response body (verbatim): \`${result.errorBody}\`` : "response body: streamed",
    "",
    `terminal event: ${result.terminalType ?? "none"}`,
    `incomplete reason: ${result.incompleteReason ?? "none"}`,
    `output length — \`response.output_text.done\` characters: ${result.outputTextDoneChars}`,
    `output length — summed \`response.output_text.delta\` characters: ${result.outputTextDeltaChars}`,
    `output length — from terminal \`response.output\` message items: ${result.finalOutputChars}`,
    "",
    `accepted (from \`response.created\`): ${result.createdEcho ?? "none"}`,
    `accepted (from terminal event): ${result.terminalEcho ?? "none"}`,
    `usage: ${result.usage ?? "none"}`,
    "",
    "event type counts:",
    "",
    "```",
    ...Object.entries(result.eventCounts)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([type, count]) => `${count.toString().padStart(4)}  ${type}`),
    "```",
  ]

  if (result.failures.length) lines.push("", "failures:", "", ...result.failures.map((failure) => `- ${failure}`))

  const rendered = lines.join("\n")
  console.log(rendered)
  console.log("")
  return rendered
}

function renderSummary(results: RunResult[], fallbackResults: RunResult[]) {
  say("## summary — per-field acceptance")
  say("")
  say("| run | subject | model | field(s) sent | status | verbatim body | terminal | output chars | ms |")
  say("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
  for (const result of [...results, ...fallbackResults]) {
    say(
      `| ${result.run.id} | ${result.run.subject} | \`${result.run.model}\` `
      + `| \`${JSON.stringify(result.run.fields)}\` `
      + `| ${result.transportError ? `error (${result.transportError})` : result.status} `
      + `| ${result.errorBody ? `\`${result.errorBody.replace(/\n/g, " ")}\`` : "—"} `
      + `| ${result.terminalType ?? "none"}${result.incompleteReason ? ` (${result.incompleteReason})` : ""} `
      + `| ${result.outputTextDoneChars} | ${result.durationMs} |`,
    )
  }
  say("")

  say("## echo comparison — accepted, or accepted-and-ignored")
  say("")
  for (const result of [...results, ...fallbackResults]) {
    say(`- ${result.run.id}: created echo ${result.createdEcho ?? "none"}`)
  }
  say("")

  const control = results.find((result) => result.run.subject === "control")
  const limit = results.find((result) => result.run.subject === "max_output_tokens" && result.run.model === MODEL)
  if (control && limit) {
    say(
      `\`max_output_tokens: ${MAX_OUTPUT_TOKENS}\` versus control on output length: `
      + `${limit.outputTextDoneChars} vs ${control.outputTextDoneChars} characters, `
      + `terminal ${limit.terminalType ?? "none"}${limit.incompleteReason ? ` (${limit.incompleteReason})` : ""} `
      + `vs ${control.terminalType ?? "none"}. A limit that is accepted-but-ignored looks like the control; `
      + "a limit that is honoured truncates.",
    )
    say("")
  }

  for (const field of CANDIDATE_FIELDS) {
    const primary = results.find((result) => result.run.subject === field && result.run.model === MODEL)
    const fallback = fallbackResults.find((result) => result.run.subject === field)
    say(
      `- \`${field}\`: ${MODEL} → ${primary?.transportError ?? primary?.status ?? "not run"}`
      + (primary?.errorBody ? ` \`${primary.errorBody.replace(/\n/g, " ")}\`` : "")
      + (fallback ? `; ${FALLBACK_MODEL} → ${fallback.transportError ?? fallback.status}${fallback.errorBody ? ` \`${fallback.errorBody.replace(/\n/g, " ")}\`` : ""}` : ""),
    )
  }
  say("")

  say(`upstream POSTs issued by this probe: ${upstreamCalls}`)
  say("")
  say("Turning these numbers into capability cells is the caller's job, not this script's. This")
  say("script changes no declaration, no requirement, no live case and no `src/` behaviour.")
}

function say(line: string) {
  console.log(line)
  report.push(line)
}

async function writeReport() {
  const dir = nativeMatrixOutputDir()
  // Overridable so a narrowed follow-up run does not overwrite the full sweep's transcript.
  const file = joinPath(dir, process.env.CODEX_SAMPLING_PROBE_REPORT ?? "codex-sampling-probe.md")
  await makeDir(dir)
  await writeTextFile(file, `# Codex sampling parameter acceptance probe — \`temperature\`, \`top_p\`, \`max_output_tokens\`\n\n${report.join("\n")}\n`)
  console.log(`\nwrote ${file}`)
}

function compact(value: unknown) {
  if (value === undefined) return undefined
  return redactSensitiveText(JSON.stringify(value))
}

function asObject(value: unknown): JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {}
}

await main()

export {}
