/**
 * MCP toolset expansion and tool-call execution (Requirement 21).
 *
 * Two entry points, and the split between them is the whole design:
 *
 * - {@link expandMcpToolsets} turns declared toolsets into ordinary function
 *   tools the upstream can accept, and **returns** its failures as
 *   {@link Canonical_FeatureNotice} values instead of throwing. One unreachable
 *   server therefore costs its own tools and nothing else — the request keeps
 *   going (Requirement 21.3).
 * - {@link executeMcpToolCall} runs a model-emitted call. Returning `undefined`
 *   is a routing answer rather than a failure: the name was never exposed by
 *   this map, so the call is not an MCP call and the caller forwards it to the
 *   client as an ordinary tool call (Requirement 21.5).
 *
 * This module is part of `src/core/mcp/` and so imports nothing from
 * `src/inbound/` or `src/upstream/`, names no provider, and hardcodes no
 * name-length ceiling — the ceiling arrives in
 * {@link McpExpansionDeps.maxNameLength}, because it is a fact about the active
 * upstream and core does not know which one is active (Requirements 20.7, 21.4).
 *
 * The outcome of an executed call is deliberately *not* a set of content blocks
 * despite the design sketch's `{ blocks, isError }`: block shapes belong to an
 * inbound API, and building them here would put inbound vocabulary in core. The
 * upstream-side bridge (task 35.1) maps {@link McpToolCallOutcome} onto its own
 * block writer, which already exists there.
 */

import type { Canonical_FeatureNotice } from "../canonical"
import type { JsonObject } from "../types"

import { McpClient, type McpAuth } from "./client"
import { isMcpProtocolError, type McpErrorCategory } from "./errors"
import { createMcpToolNameMap, type McpToolIdentity, type McpToolNameMap } from "./naming"
import type { McpRemoteTool, McpToolsetSpec } from "./types"

/** The feature every notice from this module reports. */
const MCP_FEATURE = "mcpToolset" as const

/**
 * The protocol surface expansion and execution actually need.
 *
 * Narrower than {@link McpClient} on purpose: a test — or an upstream that
 * already owns a connection — can supply its own implementation without
 * standing up HTTP.
 */
export interface McpClientLike {
  initialize(): Promise<void>
  listTools(): Promise<McpRemoteTool[]>
  callTool(name: string, args: unknown): Promise<McpCallOutcomeSource>
}

/** What {@link McpClientLike.callTool} resolves to; matches `McpCallResult`. */
export interface McpCallOutcomeSource {
  content: unknown
  isError: boolean
}

/** Transport-level wiring shared by expansion and execution. */
export interface McpConnectionDeps {
  fetch?: typeof fetch
  /** Abort signal for every request made through these deps. */
  signal?: AbortSignal
  /** Per-request timeout, forwarded to the client. */
  timeoutMs?: number
  /**
   * Called once on a 401/403 for `spec`, to obtain fresh authorization. The
   * hook keeps credential handling with whoever owns the credential; this
   * module reads none itself (Requirement 20.2).
   */
  onUnauthorized?: (spec: McpToolsetSpec) => Promise<string | undefined>
  /** Client factory, for tests and for an upstream with its own transport. */
  createClient?: (spec: McpToolsetSpec, auth: McpAuth) => McpClientLike
  /** Whether to perform the MCP handshake before `tools/list`. Defaults to `true`. */
  initialize?: boolean
}

export interface McpExpansionDeps extends McpConnectionDeps {
  /**
   * The active upstream's tool-name ceiling. Required, and never defaulted here:
   * a default would be a provider fact living in core.
   */
  maxNameLength: number
  /** An existing map to extend, so two expansions can share one reverse map. */
  map?: McpToolNameMap
}

export interface McpExecutionDeps extends McpConnectionDeps {
  /**
   * The toolsets this map was built from. Execution needs them for the
   * authorization and headers of the server a resolved call belongs to.
   */
  specs: readonly McpToolsetSpec[]
}

export interface McpExpansion {
  /** Function tools, in toolset order then server-advertised order. */
  tools: JsonObject[]
  /** The reverse map, for {@link executeMcpToolCall}. */
  map: McpToolNameMap
  /** One notice per dropped toolset. Empty when every toolset expanded. */
  notices: Canonical_FeatureNotice[]
}

/** A model-emitted tool call, in the two fields routing needs. */
export interface McpToolCallRequest {
  name: string
  /** Arguments as the model emitted them: a JSON string or an already-parsed value. */
  arguments?: unknown
}

export interface McpToolCallOutcome {
  /** The server and remote tool the exposed name resolved to. */
  identity: McpToolIdentity
  /** The name the model called, i.e. the exposed name. */
  exposedName: string
  /** Arguments as passed to the server, after parsing a JSON string. */
  arguments: unknown
  /** The call's payload, or the failure message when `isError` is set. */
  content: unknown
  isError: boolean
  /** Present only on failure; lets a caller distinguish auth from transport. */
  errorCategory?: McpErrorCategory
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/**
 * Expand every declared toolset into function tools.
 *
 * Filtering: when a toolset names tools through `allowed_tools` or `tool_names`,
 * only those names are expanded (Requirement 21.2); with neither set, every tool
 * the server advertises is. The two lists are treated as one selection set —
 * they are mutually exclusive at the inbound boundary, and taking their union
 * here means a spec that somehow carries both still expands a well-defined set
 * rather than silently dropping half of it.
 *
 * Failure: a toolset with no reachable `server_url`, or whose `tools/list`
 * fails for any reason, contributes zero tools and exactly one notice. Nothing
 * throws — except a caller-initiated abort, which is the caller's own signal
 * coming back and must not be swallowed.
 */
export async function expandMcpToolsets(
  specs: readonly McpToolsetSpec[],
  deps: McpExpansionDeps,
): Promise<McpExpansion> {
  const map = deps.map ?? createMcpToolNameMap({ maxNameLength: deps.maxNameLength })
  const tools: JsonObject[] = []
  const notices: Canonical_FeatureNotice[] = []
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const serverUrl = spec.server_url?.trim()
    if (!serverUrl) {
      // A `connector_id`-addressed toolset has no endpoint to reach, so it is
      // dropped the same way an unreachable one is: a notice, not an error.
      notices.push(
        notice(
          spec,
          `MCP toolset ${describe(spec)} declares no server_url, so its tools were not made available for this request.`,
        ),
      )
      continue
    }

    let remoteTools: McpRemoteTool[]
    try {
      const client = clientFor(spec, serverUrl, deps)
      if (deps.initialize !== false) await client.initialize()
      remoteTools = await client.listTools()
    } catch (error) {
      if (isCallerAbort(error, deps.signal)) throw error
      notices.push(
        notice(
          spec,
          `MCP toolset ${describe(spec)} could not list its tools (${categoryOf(error)}), so its tools were not made ` +
            `available for this request: ${redact(messageOf(error), spec)}`,
        ),
      )
      continue
    }

    const selection = selectionSet(spec)
    for (const remote of remoteTools) {
      if (selection && !selection.has(remote.name)) continue
      const exposedName = map.exposedName({
        serverLabel: spec.server_label,
        serverUrl,
        toolName: remote.name,
      })
      // A repeated toolset resolves to the same identity and therefore the same
      // exposed name; the tool list must still carry it once.
      if (seenNames.has(exposedName)) continue
      seenNames.add(exposedName)
      tools.push(functionTool(exposedName, remote))
    }
  }

  return { tools, map, notices }
}

/**
 * The names this toolset restricts itself to, or `undefined` for "everything the
 * server advertises". An explicitly empty list is not a restriction: the inbound
 * converter omits empty lists, so an empty array here carries no intent.
 */
function selectionSet(spec: McpToolsetSpec): Set<string> | undefined {
  const named = [...(spec.allowed_tools ?? []), ...(spec.tool_names ?? [])].filter(
    (name) => typeof name === "string" && name.length > 0,
  )
  return named.length > 0 ? new Set(named) : undefined
}

/**
 * One expanded tool, in the canonical function tool shape
 * (`type`/`name`/`parameters`/`strict`, with `description` when the server gave
 * one). `parameters` defaults `type` and `properties` under the server's schema,
 * so a server that publishes a partial schema still yields a valid function
 * tool; anything the schema does declare wins.
 */
function functionTool(exposedName: string, remote: McpRemoteTool): JsonObject {
  return {
    type: "function",
    name: exposedName,
    ...(remote.description ? { description: remote.description } : {}),
    parameters: { type: "object", properties: {}, ...(remote.inputSchema ?? {}) },
    strict: false,
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute a model-emitted tool call against the server it belongs to.
 *
 * `undefined` means the name is not one this map exposed — an ordinary client
 * tool call, which the caller forwards untouched (Requirement 21.5). Two servers
 * exposing the same remote tool name resolve to different identities, so each
 * call reaches its own server.
 *
 * A server-side failure is *contained*: the outcome carries `isError: true` and
 * the failure message, so the model can see what went wrong and the stream still
 * reaches its terminal event. A caller-initiated abort is rethrown.
 */
export async function executeMcpToolCall(
  map: McpToolNameMap,
  call: McpToolCallRequest,
  deps: McpExecutionDeps,
): Promise<McpToolCallOutcome | undefined> {
  const identity = map.resolve(call.name)
  if (!identity) return undefined

  const args = parseArguments(call.arguments)
  const spec = findSpec(deps.specs, identity)
  if (!spec) {
    return {
      identity,
      exposedName: call.name,
      arguments: args,
      content: `No MCP toolset is registered for server ${identity.serverLabel}.`,
      isError: true,
      errorCategory: "protocol",
    }
  }

  try {
    const client = clientFor(spec, identity.serverUrl, deps)
    if (deps.initialize !== false) await client.initialize()
    const result = await client.callTool(identity.toolName, args)
    return {
      identity,
      exposedName: call.name,
      arguments: args,
      content: result.content,
      isError: result.isError,
    }
  } catch (error) {
    if (isCallerAbort(error, deps.signal)) throw error
    return {
      identity,
      exposedName: call.name,
      arguments: args,
      content: redact(messageOf(error), spec),
      isError: true,
      errorCategory: categoryOf(error),
    }
  }
}

/** The toolset a resolved identity came from, matched on URL and label. */
function findSpec(
  specs: readonly McpToolsetSpec[],
  identity: McpToolIdentity,
): McpToolsetSpec | undefined {
  return specs.find(
    (spec) =>
      spec.server_url?.trim() === identity.serverUrl && spec.server_label === identity.serverLabel,
  )
}

/** Model arguments arrive as a JSON string on most wires and as a value on some. */
function parseArguments(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {}
  if (args.trim() === "") return {}
  try {
    return JSON.parse(args) as unknown
  } catch {
    // Unparseable arguments are the model's text, forwarded as-is rather than
    // rejected here: the server is the authority on its own argument shape.
    return args
  }
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function clientFor(spec: McpToolsetSpec, serverUrl: string, deps: McpConnectionDeps): McpClientLike {
  const auth: McpAuth = {
    ...(spec.authorization ? { authorization: spec.authorization } : {}),
    ...(spec.headers ? { headers: spec.headers } : {}),
  }
  if (deps.createClient) return deps.createClient(spec, auth)
  return new McpClient(serverUrl, auth, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.onUnauthorized ? { onUnauthorized: () => deps.onUnauthorized!(spec) } : {}),
  })
}

/**
 * A dropped-toolset notice.
 *
 * `policy` is `degrade` because the client asked for tools it did not get; the
 * `detail` describes what happened in protocol terms only. No inbound wire
 * vocabulary and no rendered client-facing prose appears here — an inbound
 * provider decides how to present this (Requirement 9.5).
 */
function notice(spec: McpToolsetSpec, detail: string): Canonical_FeatureNotice {
  return { feature: MCP_FEATURE, policy: "degrade", detail: redact(detail, spec) }
}

/** A label safe to put in a notice: the client's own server label, quoted. */
function describe(spec: McpToolsetSpec): string {
  return JSON.stringify(spec.server_label)
}

function categoryOf(error: unknown): McpErrorCategory {
  return isMcpProtocolError(error) ? error.category : "transport"
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Remove the toolset's own credential material from text that is about to leave
 * this module. A server is free to echo a header back in an error body, and a
 * notice reaches the client verbatim.
 */
function redact(text: string, spec: McpToolsetSpec): string {
  let out = text
  const secrets = [spec.authorization, ...Object.values(spec.headers ?? {})]
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join("[REDACTED]")
  }
  return out
}

/**
 * Whether this error is the caller's own abort coming back. Only then does the
 * failure escape: everything else is contained as a notice or an error outcome.
 */
function isCallerAbort(error: unknown, signal?: AbortSignal): boolean {
  const isAbort = (error instanceof DOMException || error instanceof Error) && error.name === "AbortError"
  return isAbort && signal?.aborted === true
}
