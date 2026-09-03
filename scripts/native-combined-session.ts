// `bun run probe:native:combined` — the missing measurement of task 37.2 criterion (c)
// (Requirement 29.4): **one** `/v1/messages` request to Kiro that carries a stated effort level,
// client function tools, a prompt that makes the model reach for web search, and an MCP toolset
// pointed at the loopback fixture — all four in the same session — measured for a declared policy
// outcome on every unsupported feature and **zero client-visible errors**.
//
// Why this is a script and not a fifteenth Live_Case: `NATIVE_LIVE_CASE_IDS` holds exactly the
// fourteen ids Requirement 24.1 fixes, and `harness.property.test.ts` (Property 35) asserts that
// count. The registry is the harness's own contract; a plan-closing measurement is not the place to
// change it. So this script reuses the harness plumbing — `credentials.ts` (Requirement 24.11, the
// real account files are never written), `mcp-fixture.ts` (Requirement 24.10, loopback only),
// `gateway.ts` (the real runtime on an ephemeral port, `logBody` + sync request logs),
// `response-capture.ts`, and the same assertion constructors the cases use — and adds no plumbing
// of its own. Nothing under `src/` is touched and no gateway behaviour changes: this only measures.
//
// Honest-reporting rule, written here because it is the point of the exercise: the web-search half
// depends on the model choosing to search. If it does not search, this script says so and reports
// the criterion as a **partial** measurement rather than as met. A session where one of the four
// never fired is a partial measurement and is recorded as one.
//
// Output goes to stdout and to `$NATIVE_TRANSCRIPT_DIR/native-combined-session.md` (default
// `.native-transcripts/`, gitignored). Every body is passed through `redactSensitiveText`.
import { writeTextFile } from "../src/core/bun-fs"
import { redactSensitiveText } from "../src/core/debug-capture"
import { joinPath, makeDir } from "../src/core/paths"
import type { JsonObject } from "../src/core/types"

import {
  expectBlockType,
  expectServerToolCount,
  expectServerToolResultsArePaired,
  expectStatus,
  expectUpstreamEffortIn,
  expectUpstreamEffortPresent,
} from "../test/native/assertions"
import {
  KIRO_EFFORT_LEVELS,
  NATIVE_KIRO_MODEL,
  NATIVE_MCP_SERVER_NAME,
  type NativeLiveCaseId,
} from "../test/native/cases"
import { copyNativeCredentials, protectedCredentialFingerprints } from "../test/native/credentials"
import { startNativeGateway } from "../test/native/gateway"
import { nativeMatrixOutputDir } from "../test/native/matrix-source"
import { startNativeMcpFixture } from "../test/native/mcp-fixture"
import {
  blockTypes,
  errorMessage,
  featureNotices,
  isJsonObject,
  serverToolCount,
  toolUseNames,
  upstreamEffortLevel,
} from "../test/native/observation"
import { captureNativeObservation } from "../test/native/response-capture"
import type { NativeLiveAssertion, NativeLiveObservation } from "../test/native/types"

/**
 * A label, not a registry id. `NativeLiveObservation.caseId` is typed to the fourteen registered
 * ids on purpose (a rename must fail loudly), and this session is deliberately **not** one of them,
 * so the label is cast once, here, and used only for transcript text.
 */
const SESSION_LABEL = "combined-session" as unknown as NativeLiveCaseId

/**
 * In `KIRO_EFFORT_LEVELS` and **not** the model's published default (`high`), so a level observed on
 * the upstream payload proves the *client's stated* effort was carried rather than the model default
 * that `effort-default` already measures.
 */
const STATED_EFFORT = process.env.NATIVE_COMBINED_EFFORT ?? "xhigh"

/**
 * Names both jobs in one turn. The web-search half is phrased the way `web-search-native` phrases
 * it — a fact the model cannot answer from its weights — because that case measured this model
 * reaching for its native search on exactly that shape of question.
 */
const PROMPT = process.env.NATIVE_COMBINED_PROMPT
  ?? [
    "Do both of these in this one reply.",
    "1. Look up on the web what the current stable Bun release version is.",
    `2. Call the ${NATIVE_MCP_SERVER_NAME} echo tool with the text ping.`,
    "Then reply with the version number and the echo result.",
  ].join(" ")

const TIMEOUT_MS = Number(process.env.NATIVE_COMBINED_TIMEOUT_MS ?? 180_000)

/** A client function tool: declared by the client, never executed by the gateway. */
const CLIENT_TOOL_NAME = "record_finding"

const report: string[] = []

const before = await protectedCredentialFingerprints()
const startedAt = new Date().toISOString()
say(`# Combined Claude Code session — one request, four features`)
say("")
say(`started: ${startedAt}`)
say(`model: ${NATIVE_KIRO_MODEL}`)
say(`stated effort: ${STATED_EFFORT} (in enum [${KIRO_EFFORT_LEVELS.join(", ")}], not the published default)`)
say("")

const credentials = await copyNativeCredentials("kiro")
const fixture = await startNativeMcpFixture()
let gateway: Awaited<ReturnType<typeof startNativeGateway>> | undefined

try {
  for (const note of credentials.notes) console.warn(`combined-session credential: ${note}`)
  say(`credential copy: ${credentials.authFile}`)
  say(`source (read-only): ${credentials.sourceAuthFile}`)
  say(`mcp fixture: ${fixture.url}`)
  say("")

  gateway = await startNativeGateway({
    upstream: "kiro",
    // Only the flag the MCP toolset needs. Every other native flag is cleared by the gateway, so a
    // shell value cannot change what this measures — in particular `KIRO_WEB_SEARCH_HEURISTICS`
    // stays off, so any search in the answer is one the model emitted.
    flags: { NATIVE_MCP_EMULATION: "1" },
    credentials,
  })

  const body = combinedBody(fixture.url)
  say("## client request")
  say("")
  say(`POST /v1/messages -> ${gateway.url}`)
  say("")
  say("```json")
  say(redactSensitiveText(JSON.stringify(body, null, 2)))
  say("```")
  say("")

  const windowOpened = new Date().toISOString()
  const response = await gateway.post("/v1/messages", body, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  const clientBody = await response.text()
  const requestLog = await gateway
    .waitForLog({ predicate: (entry) => entry.path === "/v1/messages", timeoutMs: 30_000 })
    .catch(() => undefined)
  const windowClosed = new Date().toISOString()

  const observation = captureNativeObservation({
    caseId: SESSION_LABEL,
    response,
    clientBody,
    logs: gateway.logs,
    ...(requestLog ? { requestLog } : {}),
  })

  say(`live window: ${windowOpened} -> ${windowClosed}`)
  say("")
  reportSession(observation, fixture.methodSequence(), fixture.toolCallNames())

  say("## client response (raw, redacted)")
  say("")
  say("```json")
  say(redactSensitiveText(clientBody))
  say("```")
  say("")

  const upstream = requestLog?.proxy?.requestBody
  say("## upstream request body (raw, redacted)")
  say("")
  say("```json")
  say(upstream ? redactSensitiveText(upstream) : "(no upstream request body was captured)")
  say("```")
} finally {
  await gateway?.stop().catch(() => {})
  await fixture.stop().catch(() => {})
  await credentials.cleanup().catch(() => {})

  const after = await protectedCredentialFingerprints()
  say("")
  say("## protected credential files")
  say("")
  for (const [index, entry] of after.entries()) {
    const previous = before[index]
    const unchanged = previous?.exists === entry.exists && previous?.sha256 === entry.sha256 && previous?.mtimeMs === entry.mtimeMs
    say(`${entry.exists ? "" : "(absent) "}${entry.path}: ${unchanged ? "unchanged" : "CHANGED"}${entry.exists ? ` — ${entry.sha256?.slice(0, 16)} / ${new Date(entry.mtimeMs ?? 0).toISOString()}` : ""}`)
  }
  await writeReport()
}

/** The one request: stated effort + client function tools + a web-search prompt + an MCP toolset. */
function combinedBody(mcpServerUrl: string): JsonObject {
  return {
    model: NATIVE_KIRO_MODEL,
    max_tokens: 2048,
    stream: false,
    output_config: { effort: STATED_EFFORT },
    mcp_servers: [{ name: NATIVE_MCP_SERVER_NAME, type: "url", url: mcpServerUrl }],
    tools: [
      {
        name: CLIENT_TOOL_NAME,
        description: "Records a finding the client will store. The client executes this, not the gateway.",
        input_schema: {
          type: "object",
          properties: { finding: { type: "string", description: "The finding to record." } },
          required: ["finding"],
        },
      },
      { type: "mcp_toolset", mcp_server_name: NATIVE_MCP_SERVER_NAME, require_approval: "never" },
    ],
    messages: [{ role: "user", content: PROMPT }],
  }
}

/** Everything the criterion asks to be reported, each half named separately. */
function reportSession(
  observation: NativeLiveObservation,
  mcpMethods: readonly string[],
  mcpToolCalls: readonly string[],
) {
  const types = blockTypes(observation)
  const notices = featureNotices(observation)
  const effort = upstreamEffortLevel(observation)
  const upstreamToolNames = upstreamToolSpecificationNames(observation)
  const searched = types.includes("server_tool_use") || types.includes("web_search_tool_result")
  const mcpExecuted = mcpToolCalls.length > 0
  const clientErrors = clientVisibleErrors(observation)

  say("## measured")
  say("")
  say(`status: ${observation.status}`)
  say(`upstream request count: ${observation.upstreamRequestCount ?? "(not counted)"}`)
  say(`effort on the upstream payload: ${effort ?? "(none)"}${effort === STATED_EFFORT ? " — equals the stated level" : ""}`)
  say(`tool names on the upstream payload: ${upstreamToolNames.length ? upstreamToolNames.join(", ") : "(none)"}`)
  say(`client function tool '${CLIENT_TOOL_NAME}' present upstream: ${upstreamToolNames.includes(CLIENT_TOOL_NAME) ? "yes" : "no"}`)
  say(`content block types: ${types.length ? types.join(", ") : "(none)"}`)
  say(`tool_use / mcp_tool_use / server_tool_use names: ${toolUseNames(observation).join(", ") || "(none)"}`)
  say(`web search emitted by the model: ${searched ? "yes" : "NO — the model did not reach for search on this prompt"}`)
  say(`web_search_tool_result blocks paired with server_tool_use: ${pairing(types)}`)
  say(`usage.server_tool_use.web_search_requests: ${countOf(observation, "web_search_requests")}`)
  say(`usage.server_tool_use.mcp_calls: ${countOf(observation, "mcp_calls")}`)
  say(`mcp fixture methods: ${mcpMethods.join(", ") || "(none)"}`)
  say(`mcp fixture tool calls: ${mcpToolCalls.join(", ") || "(none)"}`)
  say(`feature notices: ${notices.length ? notices.map((notice) => `${notice.feature}=${notice.policy ?? "?"}`).join(", ") : "(none)"}`)
  for (const notice of notices) say(`  - ${notice.feature}: ${notice.detail ?? "(no detail)"}`)
  say(`client-visible errors: ${clientErrors.length ? clientErrors.join(" | ") : "none"}`)
  say("")

  say("## assertions")
  say("")
  const assertions: NativeLiveAssertion[] = [
    expectStatus(200),
    expectUpstreamEffortPresent(),
    expectUpstreamEffortIn(KIRO_EFFORT_LEVELS),
    expectServerToolResultsArePaired(),
    expectBlockType("mcp_tool_result"),
    expectServerToolCount("mcp_calls", 1),
  ]
  for (const assertion of assertions) {
    const result = evaluate(assertion, observation)
    say(`- [${result.ok ? "pass" : "fail"}] ${assertion.id} — ${assertion.description}${result.ok ? "" : `: ${result.detail}`}`)
  }
  say("")

  say("## verdict on 37.2 criterion (c)")
  say("")
  const fourFeatures = [
    ["stated effort reached the upstream payload", effort === STATED_EFFORT],
    ["client function tools reached the upstream payload", upstreamToolNames.includes(CLIENT_TOOL_NAME)],
    ["the model emitted a web search", searched],
    ["the MCP toolset executed against the fixture", mcpExecuted],
  ] as const
  for (const [claim, held] of fourFeatures) say(`- ${held ? "held" : "NOT observed"}: ${claim}`)
  say(`- ${clientErrors.length ? "NOT held" : "held"}: zero client-visible errors`)
  say("")
  const allFour = fourFeatures.every(([, held]) => held)
  say(
    allFour && !clientErrors.length
      ? "COMPLETE: all four features fired in one session with zero client-visible errors."
      : "PARTIAL: at least one of the four never fired in this session, so this is a partial measurement of criterion (c), not a pass.",
  )
  say("")
}

function evaluate(assertion: NativeLiveAssertion, observation: NativeLiveObservation) {
  try {
    return assertion.evaluate(observation)
  } catch (error) {
    return { ok: false as const, detail: `assertion threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function pairing(types: readonly string[]) {
  const results = types.filter((type) => type === "web_search_tool_result" || type === "web_fetch_tool_result").length
  const uses = types.filter((type) => type === "server_tool_use").length
  if (!results) return "(no server tool results to pair)"
  return `${results} result(s) against ${uses} server_tool_use block(s) — ${uses >= results ? "paired" : "UNPAIRED"}`
}

function countOf(observation: NativeLiveObservation, key: "web_search_requests" | "mcp_calls") {
  return serverToolCount(observation, key)
}

/** Every `toolSpecification.name` in the upstream payload, at any depth (`src/upstream/kiro/payload.ts`). */
function upstreamToolSpecificationNames(observation: NativeLiveObservation): string[] {
  if (!observation.upstreamRequestBody) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(observation.upstreamRequestBody)
  } catch {
    return []
  }

  const names: string[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry)
      return
    }
    if (!isJsonObject(value)) return
    const spec = value.toolSpecification
    if (isJsonObject(spec) && typeof spec.name === "string") names.push(spec.name)
    for (const entry of Object.values(value)) walk(entry)
  }
  walk(parsed)
  return [...new Set(names)]
}

/**
 * What a Claude Code user would see as an error: a non-2xx, an `error` envelope, or a result block
 * the gateway marked failed. Model prose is never read (Requirement 24.8).
 */
function clientVisibleErrors(observation: NativeLiveObservation): string[] {
  const found: string[] = []
  if (observation.status < 200 || observation.status >= 300) found.push(`status ${observation.status}`)
  const message = observation.status >= 400 ? errorMessage(observation) : undefined
  if (message) found.push(`error message: ${message.slice(0, 300)}`)
  if (isJsonObject(observation.clientJson?.error)) found.push("body carries an `error` envelope")

  const content = Array.isArray(observation.clientJson?.content) ? observation.clientJson.content : []
  for (const block of content) {
    if (!isJsonObject(block)) continue
    if (block.is_error === true) found.push(`${String(block.type ?? "block")} carries is_error: true`)
  }
  return found
}

function say(line: string) {
  console.log(line)
  report.push(line)
}

async function writeReport() {
  const dir = nativeMatrixOutputDir()
  const file = joinPath(dir, "native-combined-session.md")
  await makeDir(dir)
  await writeTextFile(file, `${report.join("\n")}\n`)
  console.log(`\nwrote ${file}`)
}

export {}
