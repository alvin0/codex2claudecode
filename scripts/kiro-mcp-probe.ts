// `bun run probe:kiro:mcp` — task 2.1 / M1 of the `native-api-mode` plan (Requirement 4.1).
//
// Sends a real JSON-RPC `initialize` to Kiro `POST /mcp`, then `tools/list`, and records the
// raw answers. Nothing under `src/` is touched and no gateway behaviour changes: this script
// only measures. Turning the answer into a capability cell is task 2.2's job.
//
// Two rules shape the implementation:
//
//   1. **The headers are the product's, not the script's.** `mcpHeaders()` is private to
//      `Kiro_Client`, so instead of restating it the script drives one `callMcpWebSearch()`
//      through an injected `fetch` that captures the outgoing request and answers with a stub.
//      Whatever `mcpHeaders()` produces — including a freshly refreshed `Authorization` — is
//      what the probe then sends, and the endpoint URL comes from the same capture rather than
//      from a hand-written string.
//   2. **Credentials are read from a copy.** `copyNativeCredentials("kiro")` resolves the live
//      account into a temp directory; `~/.aws/sso/cache/kiro-auth-token.json` is never written
//      (Requirement 24.11).
//
// Output goes to stdout and to `$NATIVE_TRANSCRIPT_DIR/kiro-mcp-probe.md` (default
// `.native-transcripts/`, gitignored). Every body is passed through `redactSensitiveText`, and
// header *values* are never printed — only names.
import { writeTextFile } from "../src/core/bun-fs"
import { redactSensitiveText } from "../src/core/debug-capture"
import { joinPath, makeDir } from "../src/core/paths"
import { Kiro_Auth_Manager } from "../src/upstream/kiro/auth"
import { Kiro_Client } from "../src/upstream/kiro/client"

import { copyNativeCredentials } from "../test/native/credentials"
import { nativeMatrixOutputDir } from "../test/native/matrix-source"

/** Handshake versions to try, newest first. The server's answer decides which one it speaks. */
const PROTOCOL_VERSIONS = (process.env.KIRO_MCP_PROBE_PROTOCOL_VERSIONS ?? "2025-06-18,2025-03-26,2024-11-05")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)

const TIMEOUT_MS = Number(process.env.KIRO_MCP_PROBE_TIMEOUT_MS ?? 60_000)
const CLIENT_INFO = { name: "codex2claudecode-native-probe", version: "0.3.2" }

/** Enough of a web_search answer for `parseMcpWebSearchResults()` to accept the stub. */
const CAPTURE_STUB_BODY = JSON.stringify({
  id: "capture",
  jsonrpc: "2.0",
  result: { content: [{ type: "text", text: "{}" }] },
})

interface McpTemplate {
  url: string
  headers: Headers
}

interface ProbeExchange {
  label: string
  request: unknown
  status?: number
  ok: boolean
  responseHeaders: Record<string, string>
  body: string
  error?: string
}

const report: string[] = []

const credentials = await copyNativeCredentials("kiro")
try {
  const auth = await Kiro_Auth_Manager.fromAuthFile(credentials.authFile)

  say(`credential copy: ${credentials.authFile}`)
  say(`source (read-only): ${credentials.sourceAuthFile}`)
  say(`auth type: ${auth.getAuthType()}`)
  say("")

  const template = await captureMcpTemplate(auth)
  say(`endpoint: ${template.url}`)
  say(`headers from mcpHeaders(): ${headerNames(template.headers).join(", ")}`)
  say("")

  const initialize = await probeInitialize(auth, template)
  const initializeResult = jsonRpcResult(initialize.exchange.body)

  const toolsList = await sendJsonRpc(auth, template, "tools-list", {
    id: "probe-tools-list",
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
  })
  report.push(renderExchange(toolsList))

  // A session id in the initialize response headers means the endpoint is stateful, in which
  // case the plain `mcpHeaders()` call above is expected to fail. Only then is a second,
  // clearly-labelled attempt worth making — the header is measured, not invented.
  const sessionId = initialize.exchange.responseHeaders["mcp-session-id"]
  let sessionToolsList: ProbeExchange | undefined
  if (!isSuccessfulJsonRpc(toolsList) && sessionId) {
    const sessionHeaders = new Headers(template.headers)
    sessionHeaders.set("mcp-session-id", sessionId)
    sessionToolsList = await sendJsonRpc(
      auth,
      { url: template.url, headers: sessionHeaders },
      "tools-list (retry with mcp-session-id from initialize)",
      { id: "probe-tools-list-session", jsonrpc: "2.0", method: "tools/list", params: {} },
    )
    report.push(renderExchange(sessionToolsList))
  }

  const toolsResult = jsonRpcResult(sessionToolsList?.body ?? toolsList.body)
  const tools = readTools(toolsResult)

  say("## summary")
  say("")
  say(`initialize: ${describeOutcome(initialize.exchange)}${initialize.protocolVersion ? ` (sent protocolVersion ${initialize.protocolVersion})` : ""}`)
  say(`protocolVersion returned: ${stringField(initializeResult, "protocolVersion") ?? "none"}`)
  say(`serverInfo: ${compact(initializeResult?.serverInfo) ?? "none"}`)
  say(`capabilities: ${compact(initializeResult?.capabilities) ?? "none"}`)
  say(`tools/list: ${describeOutcome(sessionToolsList ?? toolsList)}`)
  say(`tools returned: ${tools ? tools.length : "none"}`)
  if (tools) for (const tool of tools) say(`  - ${toolLine(tool)}`)

  const fetchTools = (tools ?? []).filter(isFetchLikeTool)
  say("")
  say(
    tools === undefined
      ? "server-side fetch tool: UNKNOWN — tools/list did not return a tool list"
      : fetchTools.length
        ? `server-side fetch tool: YES — ${fetchTools.map((tool) => toolName(tool)).join(", ")}`
        : "server-side fetch tool: NO — no returned tool looks like a fetch/URL reader",
  )

  if (probeUnlistedFetchEnabled()) await probeUnlistedFetchTools(auth, template, tools)
} finally {
  await credentials.cleanup().catch(() => {})
  await writeReport()
}

/**
 * Runs one `callMcpWebSearch()` against a stub `fetch` purely to observe the request
 * `Kiro_Client` builds for `POST /mcp`: the exact `mcpHeaders()` set and the exact URL.
 */
async function captureMcpTemplate(auth: Kiro_Auth_Manager): Promise<McpTemplate> {
  let captured: McpTemplate | undefined
  const client = new Kiro_Client(auth, {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), headers: new Headers(init?.headers) }
      return Promise.resolve(new Response(CAPTURE_STUB_BODY, { status: 200, headers: { "content-type": "application/json" } }))
    }) as unknown as typeof fetch,
  })

  await client.callMcpWebSearch("mcp header capture")
  if (!captured) throw new Error("Kiro_Client issued no MCP request, so no header set could be captured")
  return captured
}

/** `initialize` across the candidate protocol versions, stopping at the first one accepted. */
async function probeInitialize(auth: Kiro_Auth_Manager, template: McpTemplate) {
  let last: { exchange: ProbeExchange; protocolVersion: string } | undefined

  for (const protocolVersion of PROTOCOL_VERSIONS) {
    const exchange = await sendJsonRpc(auth, template, `initialize (protocolVersion ${protocolVersion})`, {
      id: `probe-initialize-${protocolVersion}`,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: CLIENT_INFO },
    })
    report.push(renderExchange(exchange))
    last = { exchange, protocolVersion }
    if (isSuccessfulJsonRpc(exchange)) break
  }

  if (!last) throw new Error("No protocol version was configured for the initialize probe")
  return last
}

function probeUnlistedFetchEnabled(env: Record<string, string | undefined> = process.env) {
  return ["1", "true", "yes", "on"].includes((env.KIRO_MCP_PROBE_UNLISTED ?? "").trim().toLowerCase())
}

/**
 * Off by default and outside Requirement 4.1, which settles the `webFetch` cell from `tools/list`
 * alone. It exists because the returned `web_search` description tells the model to "use web_fetch
 * ... for more detailed content from a specific webpage" while `tools/list` advertises no such
 * tool. Calling the unadvertised names turns that into a measurement: either the server answers,
 * or it names the tool as unknown.
 */
async function probeUnlistedFetchTools(auth: Kiro_Auth_Manager, template: McpTemplate, tools: unknown[] | undefined) {
  const advertised = new Set((tools ?? []).map((tool) => toolName(tool)))
  const candidates = ["web_fetch", "webFetch", "fetch"].filter((name) => !advertised.has(name))

  say("")
  say("## unlisted fetch tool probe (KIRO_MCP_PROBE_UNLISTED)")
  for (const name of candidates) {
    const exchange = await sendJsonRpc(auth, template, `tools/call ${name}`, {
      id: `probe-unlisted-${name}`,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name, arguments: { url: "https://example.com" } },
    })
    report.push(renderExchange(exchange))
    say(`${name}: ${isSuccessfulJsonRpc(exchange) ? "ANSWERED" : `rejected — ${describeOutcome(exchange)}`}`)
  }
}

/** One real request, with the same `403 → refresh → retry once` branch `requestMcpOnce()` uses. */
async function sendJsonRpc(auth: Kiro_Auth_Manager, template: McpTemplate, label: string, request: unknown): Promise<ProbeExchange> {
  const body = JSON.stringify(request)
  const send = async () => {
    const headers = new Headers(template.headers)
    headers.set("Authorization", `Bearer ${await auth.getAccessToken()}`)
    return fetch(template.url, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
  }

  try {
    let response = await send()
    if (response.status === 403) {
      await auth.refresh()
      response = await send()
    }
    return {
      label,
      request,
      status: response.status,
      ok: response.ok,
      responseHeaders: headerMap(response.headers),
      body: await response.text(),
    }
  } catch (error) {
    return {
      label,
      request,
      ok: false,
      responseHeaders: {},
      body: "",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  }
}

function renderExchange(exchange: ProbeExchange) {
  const lines = [
    `## ${exchange.label}`,
    "",
    "request body:",
    "",
    "```json",
    redactSensitiveText(JSON.stringify(exchange.request, null, 2)),
    "```",
    "",
    exchange.error ? `transport error: ${exchange.error}` : `status: ${exchange.status}`,
  ]

  if (Object.keys(exchange.responseHeaders).length) {
    lines.push("", "response headers:", "", "```", ...Object.entries(exchange.responseHeaders).map(([name, value]) => `${name}: ${value}`), "```")
  }
  if (exchange.body) {
    lines.push("", "response body (raw):", "", "```json", redactSensitiveText(exchange.body), "```")
  }

  const rendered = lines.join("\n")
  console.log(rendered)
  console.log("")
  return rendered
}

function say(line: string) {
  console.log(line)
  report.push(line)
}

async function writeReport() {
  const dir = nativeMatrixOutputDir()
  const file = joinPath(dir, "kiro-mcp-probe.md")
  await makeDir(dir)
  await writeTextFile(file, `# Kiro POST /mcp probe — initialize + tools/list\n\n${report.join("\n")}\n`)
  console.log(`\nwrote ${file}`)
}

function jsonRpcResult(body: string): Record<string, unknown> | undefined {
  const parsed = parseJson(body)
  if (!isRecord(parsed)) return undefined
  return isRecord(parsed.result) ? parsed.result : undefined
}

function isSuccessfulJsonRpc(exchange: ProbeExchange) {
  if (!exchange.ok) return false
  const parsed = parseJson(exchange.body)
  return isRecord(parsed) && !hasJsonRpcError(parsed) && parsed.result !== undefined
}

/** Kiro sends `"error": null` on success, so absence means `undefined` **or** `null`. */
function hasJsonRpcError(parsed: Record<string, unknown>) {
  return parsed.error !== undefined && parsed.error !== null
}

function readTools(result: Record<string, unknown> | undefined) {
  if (!result || !Array.isArray(result.tools)) return undefined
  return result.tools
}

function isFetchLikeTool(tool: unknown) {
  const name = toolName(tool)
  const description = isRecord(tool) && typeof tool.description === "string" ? tool.description : ""
  return /fetch|url|browse|crawl|scrape|read_page|http/i.test(name) || /\bfetch(es|ing)?\b.*\burl\b/i.test(description)
}

function toolName(tool: unknown) {
  return isRecord(tool) && typeof tool.name === "string" ? tool.name : ""
}

function toolLine(tool: unknown) {
  if (!isRecord(tool)) return JSON.stringify(tool)
  const description = typeof tool.description === "string" ? tool.description.replace(/\s+/g, " ") : ""
  const schema = tool.inputSchema ?? tool.input_schema
  return [
    toolName(tool) || "(unnamed)",
    description ? ` — ${description.slice(0, 200)}${description.length > 200 ? "…" : ""}` : "",
    schema ? ` | inputSchema: ${compact(schema)}` : "",
  ].join("")
}

function describeOutcome(exchange: ProbeExchange) {
  if (exchange.error) return `transport error (${exchange.error})`
  const parsed = parseJson(exchange.body)
  const rpcError = isRecord(parsed) && hasJsonRpcError(parsed) ? ` JSON-RPC error ${compact(parsed.error)}` : ""
  return `${exchange.status}${rpcError}`
}

function stringField(value: Record<string, unknown> | undefined, key: string) {
  const field = value?.[key]
  return typeof field === "string" ? field : undefined
}

function compact(value: unknown) {
  if (value === undefined) return undefined
  return redactSensitiveText(JSON.stringify(value))
}

function headerNames(headers: Headers) {
  return [...headers.keys()].sort()
}

function headerMap(headers: Headers) {
  return Object.fromEntries([...headers.entries()].map(([name, value]) => [name, redactSensitiveText(value)]))
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export {}
