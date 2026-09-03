// `bun run probe:codex:effort` — task 3.1 / M1b of the `native-api-mode` plan
// (Requirements 4.3, 4.5).
//
// Sends ONE identical prompt to Codex four times and counts what comes back. Nothing under
// `src/` is touched and no gateway behaviour changes: this script only measures. Turning the
// numbers into a capability cell is task 3.2's job.
//
// The four bodies differ in exactly one place:
//
//   1. `reasoning_effort: "low"`                                  (flat, what the gateway emits today)
//   2. `reasoning_effort: "xhigh"`                                (flat, same shape, top of the enum)
//   3. `reasoning: { effort: "xhigh", summary: "auto" }`           (nested, the Responses API shape)
//   4. run 3 plus `include: ["reasoning.encrypted_content"]`      (Requirement 4.5)
//
// Two rules shape the implementation:
//
//   1. **The headers are the product's, not the script's.** `CodexStandaloneClient` builds the
//      URL, the `Authorization` refresh, `originator`, `user-agent` and `ChatGPT-Account-Id`.
//      The probe injects a `fetch` that records what the client built and forwards it, so the
//      endpoint and header set come from the owning module rather than a hand-written copy.
//   2. **The body is the probe's, and it has to be.** `CodexStandaloneClient.request()` runs
//      every body through `normalizeReasoningBody()`, which *deletes* `reasoning_effort` and —
//      only for models matching its `gpt-5` pattern — re-emits it as `reasoning: { effort }`.
//      That rewrite is the exact thing under test, so the injected `fetch` swaps the normalized
//      body for the probe's raw bytes before the request leaves. The normalized body the product
//      *would* have sent is recorded next to it, because the difference is itself a measurement.
//
// Credentials are read from a copy: `copyNativeCredentials("codex")` resolves the live account
// into a temp directory, so no real credential file is ever written (Requirement 24.11).
//
// That copy is not always usable, and the probe checks *before* spending a call rather than
// discovering it as a 401. The harness deliberately throws its copy away, so a refresh performed
// inside a copy rotates the upstream refresh token while the real file keeps the consumed one —
// after which that account answers `refresh_token_reused` forever. When the copy's access token
// has already expired, the probe therefore falls back to a read-only copy of the Codex CLI auth
// file, whose access token is still live, and names the fallback in the report. Both paths point
// `CodexStandaloneClient` at a file inside the temp directory, so nothing real is ever written.
//
// Output goes to stdout and to `$NATIVE_TRANSCRIPT_DIR/codex-effort-probe.md` (default
// `.native-transcripts/`, gitignored). Bodies are passed through `redactSensitiveText`, header
// *values* are never printed — only names — and `encrypted_content` is reported as a length,
// never as a value.
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
 * Overridable because provider catalogs move. Must be a model whose enum contains `xhigh`.
 *
 * Moved off `gpt-5.4-mini` for the same reason as `NATIVE_CODEX_MODEL` in `test/native/cases.ts`:
 * the account is now restricted to `GPT-5.3-Codex-Spark`, whose measured id is
 * `gpt-5.3-codex-spark` (`bun scripts/codex-models-probe.ts`). Its
 * `supported_reasoning_levels` are `low, medium, high, xhigh`, so the `xhigh` requirement above
 * still holds; `max` is **not** offered on this model, unlike `gpt-reserve`.
 */
const MODEL = process.env.CODEX_EFFORT_PROBE_MODEL ?? "gpt-5.3-codex-spark"

/** `xhigh` can think for a long time, so the ceiling is generous. */
const TIMEOUT_MS = Number(process.env.CODEX_EFFORT_PROBE_TIMEOUT_MS ?? 300_000)

/**
 * One prompt, identical across all four runs (Requirement 4.3). It has enough depth to make
 * reasoning summary output plausible, and a hard word cap so the *answer* stays short — the
 * comparison is about reasoning volume, not prose volume.
 */
const PROMPT = process.env.CODEX_EFFORT_PROBE_PROMPT
  ?? "Three unlabelled switches outside a sealed windowless room each control exactly one of three "
    + "incandescent bulbs inside it. You may flip the switches freely from outside, but you may open "
    + "the door and enter exactly once, after which no switch may be touched again. Give a procedure "
    + "that identifies which switch controls which bulb, and prove it distinguishes all three. Then "
    + "state the smallest number of bulbs for which the same trick stops working, and why. "
    + "Answer in at most 120 words."

const INSTRUCTIONS = "You are a careful reasoner. Answer the user directly and respect any length limit."

/** A token this close to expiry would trigger a refresh, which is the thing to avoid. */
const REFRESH_MARGIN_MS = 120_000

interface ProbeRun {
  id: string
  label: string
  /** The one field that differs between runs. */
  reasoningField: JsonObject
  include?: string[]
}

const RUNS: ProbeRun[] = [
  { id: "1-flat-low", label: 'reasoning_effort: "low"', reasoningField: { reasoning_effort: "low" } },
  { id: "2-flat-xhigh", label: 'reasoning_effort: "xhigh"', reasoningField: { reasoning_effort: "xhigh" } },
  {
    id: "3-nested-xhigh",
    label: 'reasoning: { effort: "xhigh", summary: "auto" }',
    reasoningField: { reasoning: { effort: "xhigh", summary: "auto" } },
  },
  {
    id: "4-nested-xhigh-include",
    label: 'reasoning: { effort: "xhigh", summary: "auto" } + include: ["reasoning.encrypted_content"]',
    reasoningField: { reasoning: { effort: "xhigh", summary: "auto" } },
    include: ["reasoning.encrypted_content"],
  },
  // Beyond the three bodies Requirement 4.3 names. Added after the first run measured
  // `400 {"detail":"Unsupported parameter: reasoning_effort"}` for BOTH flat bodies: with the flat
  // form rejected outright, low vs xhigh cannot be compared in that shape at all, and the only way
  // to answer Requirement 4.4's "does effort change anything" is to vary effort in the shape the
  // API does accept. This is the low end of that comparison.
  {
    id: "5-nested-low-control",
    label: 'control: reasoning: { effort: "low", summary: "auto" }',
    reasoningField: { reasoning: { effort: "low", summary: "auto" } },
  },
]

interface RunResult {
  run: ProbeRun
  sentBody: string
  /** What `normalizeReasoningBody()` would have put on the wire for the same input. */
  normalizedBody?: string
  status?: number
  error?: string
  durationMs: number
  eventCounts: Record<string, number>
  reasoningSummaryDeltas: number
  reasoningSummaryChars: number
  reasoningTextDeltas: number
  outputTextDeltaChars: number
  /** `response.output_text.done` — the authoritative full answer text. */
  outputTextDoneChars: number
  finalOutputChars: number
  terminalOutputItemTypes: string[]
  /** Echo of what the API says it accepted, read off `response.created` and `response.completed`. */
  createdEcho?: string
  completedEcho?: string
  usage?: string
  reasoningItems: number
  encryptedContentItems: number
  encryptedContentChars: number[]
  failures: string[]
}

/** Set immediately before each `client.proxy()` call; read by the injected `fetch`. */
let pendingBody: string | undefined
let observedUrl: string | undefined
let observedHeaderNames: string[] = []
let observedNormalizedBody: string | undefined
let upstreamCalls = 0

const report: string[] = []

/**
 * Everything runs inside `main()` rather than at module top level: a top-level `await` executes
 * before the `const` declarations further down the file are initialized, so a helper reached from
 * there hits a temporal-dead-zone `ReferenceError` mid-stream. Calling `main()` from the bottom
 * removes that whole failure mode.
 */
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
    say(`model: ${MODEL}`)
    say(`timeout: ${TIMEOUT_MS} ms`)
    say("")
    say(`prompt (identical in all ${RUNS.length} runs):`)
    say("")
    say("```")
    say(PROMPT)
    say("```")
    say("")

    await reportModelCatalog(client)

    const results: RunResult[] = []
    for (const run of RUNS) {
      results.push(await measureRun(client, run))
    }

    say(`endpoint: ${observedUrl ?? "unknown"}`)
    say(`headers built by CodexStandaloneClient: ${observedHeaderNames.join(", ") || "none captured"}`)
    say("")

    renderSummary(results)
  } finally {
    await credentials.cleanup().catch(() => {})
    await writeReport()
  }
}

interface ProbeCredential {
  authFile: string
  description: string
  accountId?: string
  expiresAt?: number
}

/**
 * Prefers the harness copy and only falls back when its access token is already dead, so the
 * common case stays on the documented path and the fallback is visible in the report.
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

function probeBody(run: ProbeRun): JsonObject {
  return {
    model: MODEL,
    ...run.reasoningField,
    instructions: INSTRUCTIONS,
    input: [{ role: "user", content: [{ type: "input_text", text: PROMPT }] }],
    // Unchanged from what `canonicalToCodexBody()` emits today — Requirement 4.5 keeps `store`
    // out of this task.
    store: false,
    // Run_Record 3 measured `400 {"detail":"Stream must be set to true"}` on the non-streaming
    // path, and the events being counted only exist on the stream.
    stream: true,
    ...(run.include ? { include: run.include } : {}),
  }
}

async function measureRun(client: CodexStandaloneClient, run: ProbeRun): Promise<RunResult> {
  const body = JSON.stringify(probeBody(run))
  const result: RunResult = {
    run,
    sentBody: body,
    durationMs: 0,
    eventCounts: {},
    reasoningSummaryDeltas: 0,
    reasoningSummaryChars: 0,
    reasoningTextDeltas: 0,
    outputTextDeltaChars: 0,
    outputTextDoneChars: 0,
    finalOutputChars: 0,
    terminalOutputItemTypes: [],
    reasoningItems: 0,
    encryptedContentItems: 0,
    encryptedContentChars: [],
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
      result.failures.push(`HTTP ${response.status}: ${redactSensitiveText((await response.text()).slice(0, 2000))}`)
    } else {
      await consumeCodexSse(response.body, (event) => applyEvent(event.data, result))
    }
  } catch (error) {
    result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
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

  if (type === "response.reasoning_summary_text.delta") {
    result.reasoningSummaryDeltas += 1
    if (typeof data.delta === "string") result.reasoningSummaryChars += data.delta.length
    return
  }
  if (type === "response.reasoning_text.delta") {
    result.reasoningTextDeltas += 1
    return
  }
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
  if (type === "response.output_item.done") {
    scanOutputItems([data.item], result)
    return
  }
  if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
    const response = asObject(data.response)
    result.completedEcho = echoOf(response)
    if (response.usage !== undefined) result.usage = compact(response.usage)
    if (Array.isArray(response.output)) {
      result.finalOutputChars = finalOutputChars(response.output)
      result.terminalOutputItemTypes = response.output.map((item) => String(asObject(item).type ?? "(untyped)"))
      scanOutputItems(response.output, result)
    }
    if (type !== "response.completed") result.failures.push(`${type}: ${compact(response.error ?? response.incomplete_details) ?? "no detail"}`)
    return
  }
  if (type === "error") result.failures.push(`error event: ${compact(data) ?? ""}`)
}

/** What the API says it accepted for this request — the direct answer to "was the field honoured". */
function echoOf(response: JsonObject) {
  return compact({
    model: response.model,
    reasoning: response.reasoning,
    reasoning_effort: response.reasoning_effort,
    include: response.include,
    store: response.store,
    status: response.status,
  })
}

/** Assistant-visible answer length, taken from the authoritative final output items. */
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

/**
 * Requirement 4.5: does `include: ["reasoning.encrypted_content"]` make `encrypted_content`
 * appear in the output items? Only the *length* is recorded — the value never reaches the report.
 * Counted per distinct item id so `output_item.done` and `response.completed` cannot double-count.
 */
const seenEncryptedItems = new Map<RunResult, Set<string>>()

function scanOutputItems(items: unknown[], result: RunResult) {
  const seen = seenEncryptedItems.get(result) ?? new Set<string>()
  seenEncryptedItems.set(result, seen)

  for (const item of items) {
    const outputItem = asObject(item)
    if (outputItem.type !== "reasoning") continue
    const id = typeof outputItem.id === "string" ? outputItem.id : JSON.stringify(outputItem).slice(0, 64)
    if (seen.has(id)) continue
    seen.add(id)
    result.reasoningItems += 1
    if (typeof outputItem.encrypted_content === "string" && outputItem.encrypted_content.length > 0) {
      result.encryptedContentItems += 1
      result.encryptedContentChars.push(outputItem.encrypted_content.length)
    }
  }
}

/** Model catalog, so the report says whether the probed model advertises `xhigh` at all. */
async function reportModelCatalog(client: CodexStandaloneClient) {
  try {
    const response = await client.modelsRaw({ signal: AbortSignal.timeout(30_000) })
    const parsed = parseJson(await response.text())
    const models = Array.isArray(asObject(parsed).models) ? (asObject(parsed).models as unknown[]) : []
    const match = models.find((model) => asObject(model).slug === MODEL || asObject(model).id === MODEL)
    say(`model catalog: ${response.status}, ${models.length} models`)
    say(`  ${MODEL}: ${match ? compact(reasoningLevels(asObject(match))) : "not listed"}`)
  } catch (error) {
    say(`model catalog: unavailable (${error instanceof Error ? error.message : String(error)})`)
  }
  say("")
}

function reasoningLevels(model: JsonObject) {
  const levels = model.supported_reasoning_efforts ?? model.supported_reasoning_levels ?? model.reasoning_efforts
  return { slug: model.slug ?? model.id, levels: levels ?? "not advertised" }
}

function renderRun(result: RunResult) {
  const lines = [
    `## run ${result.run.id} — ${result.run.label}`,
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
    result.error ? `transport error: ${result.error}` : `status: ${result.status}`,
    `duration: ${result.durationMs} ms`,
    "",
    `\`response.reasoning_summary_text.delta\` count: **${result.reasoningSummaryDeltas}**`,
    `reasoning summary characters: ${result.reasoningSummaryChars}`,
    `\`response.reasoning_text.delta\` count: ${result.reasoningTextDeltas}`,
    `output length — \`response.output_text.done\` characters: **${result.outputTextDoneChars}**`,
    `output length — summed \`response.output_text.delta\` characters: ${result.outputTextDeltaChars}`,
    `output length — from terminal \`response.output\` message items: ${result.finalOutputChars}`,
    `terminal \`response.output\` item types: ${result.terminalOutputItemTypes.join(", ") || "none"}`,
    `reasoning output items: ${result.reasoningItems}`,
    `output items carrying \`encrypted_content\`: ${result.encryptedContentItems}`
      + (result.encryptedContentChars.length ? ` (lengths: ${result.encryptedContentChars.join(", ")})` : ""),
    "",
    `accepted (from \`response.created\`): ${result.createdEcho ?? "none"}`,
    `accepted (from terminal event): ${result.completedEcho ?? "none"}`,
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

function renderSummary(results: RunResult[]) {
  say("## summary")
  say("")
  say("| run | body | status | `reasoning_summary_text.delta` | summary chars | output chars | reasoning tokens | duration ms | encrypted_content items |")
  say("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
  for (const result of results) {
    say(
      `| ${result.run.id} | \`${result.run.label}\` | ${result.error ? `error (${result.error})` : result.status} `
      + `| ${result.reasoningSummaryDeltas} | ${result.reasoningSummaryChars} | ${result.outputTextDoneChars} `
      + `| ${reasoningTokens(result) ?? "—"} | ${result.durationMs} | ${result.encryptedContentItems} |`,
    )
  }
  say("")

  const low = results.find((result) => result.run.id === "1-flat-low")
  const high = results.find((result) => result.run.id === "2-flat-xhigh")
  const nested = results.find((result) => result.run.id === "3-nested-xhigh")
  const include = results.find((result) => result.run.id === "4-nested-xhigh-include")

  if (low && high) {
    say(
      `flat \`reasoning_effort\` low vs xhigh: ${low.reasoningSummaryDeltas} vs ${high.reasoningSummaryDeltas} delta events, `
      + `${low.reasoningSummaryChars} vs ${high.reasoningSummaryChars} summary chars, `
      + `${low.outputTextDoneChars} vs ${high.outputTextDoneChars} output chars, `
      + `${low.durationMs} vs ${high.durationMs} ms`,
    )
    say(`  accepted echo low:   ${low.createdEcho ?? "none"}`)
    say(`  accepted echo xhigh: ${high.createdEcho ?? "none"}`)
  }
  if (nested) {
    say(
      `nested \`reasoning: { effort: "xhigh", summary: "auto" }\`: ${nested.reasoningSummaryDeltas} delta events, `
      + `${nested.reasoningSummaryChars} summary chars, ${nested.outputTextDoneChars} output chars, ${nested.durationMs} ms`,
    )
    say(`  accepted echo nested: ${nested.createdEcho ?? "none"}`)
  }

  const control = results.find((result) => result.run.id === "5-nested-low-control")
  if (control && nested) {
    say("")
    say(
      `nested low vs nested xhigh: ${control.reasoningSummaryDeltas} vs ${nested.reasoningSummaryDeltas} delta events, `
      + `${control.reasoningSummaryChars} vs ${nested.reasoningSummaryChars} summary chars, `
      + `${control.outputTextDoneChars} vs ${nested.outputTextDoneChars} output chars, `
      + `${reasoningTokens(control) ?? "—"} vs ${reasoningTokens(nested) ?? "—"} reasoning tokens, `
      + `${control.durationMs} vs ${nested.durationMs} ms`,
    )
    say(`  accepted echo control: ${control.createdEcho ?? "none"}`)
  }
  if (include) {
    say("")
    say(
      `include: ["reasoning.encrypted_content"] → encrypted_content in output items: `
      + `${include.encryptedContentItems > 0 ? `YES — ${include.encryptedContentItems} item(s)` : "NO"} `
      + `(${include.reasoningItems} reasoning item(s) seen, store: false unchanged)`,
    )
    if (nested) {
      say(
        `  same body without \`include\`: ${nested.encryptedContentItems > 0 ? `${nested.encryptedContentItems} item(s) with encrypted_content` : "no encrypted_content"} `
        + `(${nested.reasoningItems} reasoning item(s) seen)`,
      )
    }
  }

  say("")
  say(`upstream POSTs issued by this probe: ${upstreamCalls}`)
  say("")
  say("Settling the Codex effort cell and appending the research section is task 3.2, not this script.")
}

function say(line: string) {
  console.log(line)
  report.push(line)
}

async function writeReport() {
  const dir = nativeMatrixOutputDir()
  const file = joinPath(dir, "codex-effort-probe.md")
  await makeDir(dir)
  await writeTextFile(file, `# Codex reasoning-effort probe — flat \`reasoning_effort\` vs nested \`reasoning.effort\`\n\n${report.join("\n")}\n`)
  console.log(`\nwrote ${file}`)
}

/** The upstream's own count of reasoning work, independent of how many summary events it chose to emit. */
function reasoningTokens(result: RunResult) {
  const usage = asObject(parseJson(result.usage ?? ""))
  const details = asObject(usage.output_tokens_details)
  return typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : undefined
}

function compact(value: unknown) {
  if (value === undefined) return undefined
  return redactSensitiveText(JSON.stringify(value))
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function asObject(value: unknown): JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {}
}

await main()

export {}
