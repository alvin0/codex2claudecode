/**
 * Kiro-side MCP toolset emulation (task 35.1, Requirements 22.1–22.4, 22.6, 22.7).
 *
 * Kiro's own `/mcp` endpoint serves exactly one tool — `web_search` — and cannot be handed a
 * client-declared toolset (spike §9.1, §9.2), so `KIRO_CAPABILITIES.features.mcpToolset` is
 * `"emulate"`: the gateway discovers the client's servers itself, exposes their tools as ordinary
 * function tools, and executes the calls the model makes. This module is that bridge. It owns no
 * protocol: `src/core/mcp/toolset.ts` does the expansion and the execution, and everything here is
 * Kiro-shaped glue around it.
 *
 * The shape mirrors {@link maybeHandleKiroServerTool} in `./web-search.ts`, because the interception
 * point is the same one:
 *
 * 1. {@link createKiroMcpSession} runs **before the payload is built**, so the expanded function
 *    tools can be appended to the tool list the payload carries.
 * 2. {@link KiroMcpSession.handleToolCall} runs **mid-stream** on each model-emitted call. A call
 *    whose name this session exposed is executed and replaced by an
 *    `mcp_tool_use` / `mcp_tool_result` pair; every other call is passed through verbatim as
 *    `tool_call_done`, exactly as the web-search handler passes through a non-`web_search` name.
 * 3. {@link KiroMcpSession.serverToolUseDelta} reports the completed-call count for the terminal
 *    `usage` event — one increment per completed call, no more (Requirement 22.3).
 *
 * ## Why the block writer lives here
 *
 * The pair of blocks is byte-identical to what `codexMcpToClaudeBlocks()` produces, and it is
 * produced from the same input vocabulary: {@link mcpCallOutputItem} builds the `mcp_call` output
 * item that function consumes, and {@link mcpCallItemToBlocks} is that function's algorithm.
 * The import that would have made this literal reuse is forbidden —
 * `src/inbound/claude/mcp.ts` is inbound, and `test/architecture.property.test.ts`'s
 * `upstream-no-inbound` row fails any `src/upstream/` → `src/inbound/` edge, with an allowlist that
 * may only shrink. `src/upstream/codex/parse.ts` already keeps its own copy (`mcpBlocks()`) for the
 * same reason, and `./web-search.ts` keeps `webSearchBlocks()` for the same reason. So the
 * equivalence is enforced where it *can* be enforced: `mcp-toolset.property.test.ts` asserts, over
 * generated outcomes, that {@link kiroMcpBlocks} equals `codexMcpToClaudeBlocks()` on the same item.
 * Collapsing the three copies means hoisting one writer behind a core seam, which is a change to
 * `src/core/` and `src/inbound/` and is not this task's.
 *
 * ## Security boundaries
 *
 * - **Egress confinement (Requirement 22.6).** Server URLs come from the request's own `mcp` tools
 *   and from nothing else: {@link kiroMcpToolsets} is the only URL source, and
 *   {@link KiroMcpSession.serverUrls} is derived from its output. {@link confineFetch} then wraps the
 *   `fetch` handed to the core client and refuses any request whose URL is not in that set, so an
 *   injected transport cannot widen the boundary either.
 * - **Approval (Requirement 23).** {@link resolveKiroMcpApproval} runs before expansion and is the
 *   only interpreter of `require_approval` on this side. A toolset that needs an approval is
 *   withheld from expansion, from the egress allowlist, and from execution; the decision travels on
 *   the request's {@link FeatureDecisions}, so a refusal is the same 400 channel as every other Kiro
 *   refusal and this module gains no second one. No code path here writes a field naming an
 *   approval: `approval_request_id` appears on an `mcp_tool_use` block only when the *input item*
 *   already carried one (see {@link mcpCallItemToBlocks}), and {@link mcpCallOutputItem} — the only
 *   producer of the items this module writes — never sets it. A gateway-produced block therefore
 *   cannot carry an approval the user did not give.
 * - **Redaction (Requirement 22.7).** Every notice detail and every failure payload leaving this
 *   module passes through `redact()` from `./errors.ts`, whose `SECRET_KEYS` set names
 *   `authorization` and `mcp_authorization` (task 34.1). The client's own credential values are
 *   additionally replaced by literal match, since a remote server may echo one back in a body where
 *   no key name appears.
 */

import type { Canonical_Event, Canonical_FeatureNotice } from "../../core/canonical"
import type { FeatureDecisions } from "../../core/feature-decisions"
import type { McpToolCallOutcome } from "../../core/mcp/toolset"
import { executeMcpToolCall, expandMcpToolsets, type McpClientLike } from "../../core/mcp/toolset"
import type { McpAuth } from "../../core/mcp/client"
import type { McpToolNameMap } from "../../core/mcp/naming"
import type { McpRequireApproval, McpToolsetSpec } from "../../core/mcp/types"
import type { JsonObject } from "../../core/types"

import { KIRO_MCP_APPROVAL_REQUIRED_POLICY, KIRO_MCP_APPROVAL_SELECTIVE_POLICY } from "./capabilities"
import { TOOL_NAME_MAX_LENGTH } from "./constants"
import { redact } from "./errors"

/**
 * The name ceiling handed to the core mangler.
 *
 * Core refuses to default it (a default would be a provider fact living in core), and Kiro's
 * ceiling is the one `validateToolNames()` in `./payload.ts` already enforces — so an expanded MCP
 * tool cannot be the thing that trips `ToolNameTooLongError`.
 */
export const KIRO_MCP_TOOL_NAME_MAX_LENGTH = TOOL_NAME_MAX_LENGTH

/** A model-emitted tool call, in the three fields `./parse.ts` hands to a server-tool handler. */
export interface KiroMcpToolCall {
  callId: string
  name: string
  arguments: string
}

/** Turns an `mcp_call` output item into content blocks. Signature of `codexMcpToClaudeBlocks()`. */
export type McpBlockWriter = (item: unknown, fallbackOutput?: unknown) => JsonObject[]

export interface KiroMcpSessionOptions {
  fetch?: typeof fetch
  /** Request-scoped abort signal. A failure caused by it is rethrown rather than contained. */
  signal?: AbortSignal
  timeoutMs?: number
  /** Perform the MCP handshake before `tools/list`. Defaults to core's default (`true`). */
  initialize?: boolean
  /** Client factory, for tests and for a transport Kiro supplies itself. */
  createClient?: (spec: McpToolsetSpec, auth: McpAuth) => McpClientLike
  /** Fresh authorization for a 401/403, supplied by whoever owns the credential. */
  onUnauthorized?: (spec: McpToolsetSpec) => Promise<string | undefined>
  /** Overrides {@link KIRO_MCP_TOOL_NAME_MAX_LENGTH}; present so a test can pin a small ceiling. */
  maxNameLength?: number
  /**
   * Block writer. Defaults to {@link mcpCallItemToBlocks}. The seam exists so the shared writer can
   * be injected once it lives behind a core seam, without touching the call site again.
   */
  toBlocks?: McpBlockWriter
  /** Id source for the emitted `mcp_call`, so a test can pin it. */
  callId?: () => string
  /**
   * The request's feature-decision collector, for the approval split (Requirement 23).
   *
   * Handed in rather than created here, because the 400 a `require_approval: "always"` toolset earns
   * has to be the *same* 400 channel as every other Kiro degradation: one collector per request, one
   * `firstRejection()` at the call site, `NATIVE_STRICT` interpreted in the one function that reads
   * it. Passing it is how the client hears about a withheld toolset — the withholding itself happens
   * either way (see {@link resolveKiroMcpApproval}).
   */
  decisions?: FeatureDecisions
}

export interface KiroMcpSession {
  /** Expanded function tools, to append to the payload's tool list. */
  readonly tools: JsonObject[]
  /** One notice per dropped toolset, redacted. Empty when every toolset expanded. */
  readonly notices: Canonical_FeatureNotice[]
  /**
   * The client-declared server URLs this session may reach, and the only ones it will.
   *
   * A toolset withheld by the approval split (Requirement 23) is *not* in here: it was excluded
   * before the allowlist was built, so it is unreachable rather than merely unexpanded.
   */
  readonly serverUrls: ReadonlySet<string>
  /** Completed MCP calls so far — the value Requirement 22.3 counts. */
  readonly mcpCalls: number
  /** Whether this session exposed any tool at all; `false` means there is nothing to intercept. */
  readonly active: boolean
  /** True when `name` is one of the expanded MCP names, i.e. when this session would intercept it. */
  handles(name: string): boolean
  /**
   * Handle one model-emitted call.
   *
   * Yields exactly one event: `server_tool_block` carrying the `mcp_tool_use` / `mcp_tool_result`
   * pair for a call this session exposed, or `tool_call_done` passing a non-MCP call through
   * untouched. A server-side failure is contained — the result block carries `is_error: true` — so
   * the caller's stream always reaches its terminal event (Requirement 22.4). Only a
   * caller-initiated abort escapes.
   */
  handleToolCall(call: KiroMcpToolCall): AsyncIterable<Canonical_Event>
  /** The `serverToolUse` delta for the terminal `usage` event, or `undefined` when no call ran. */
  serverToolUseDelta(): { mcpCalls: number } | undefined
}

// ---------------------------------------------------------------------------
// Toolset discovery — the only URL source (Requirement 22.6)
// ---------------------------------------------------------------------------

/**
 * The `mcp` toolsets declared on a canonical request's tool list.
 *
 * The inbound Claude converter already emits `McpToolsetSpec` field-for-field
 * (`claudeMcpToolsetToResponsesTool()`), so this reads the tools rather than translating them. A
 * `server_url` is kept only when it is a non-empty string that parses as `http(s)`: a spec whose
 * endpoint cannot be reached is dropped by core with a notice, and a non-HTTP scheme is not an
 * egress target this gateway offers.
 */
export function kiroMcpToolsets(tools: JsonObject[] = []): McpToolsetSpec[] {
  return tools.flatMap((tool) => {
    if (!tool || tool.type !== "mcp") return []
    const serverLabel = typeof tool.server_label === "string" ? tool.server_label : undefined
    if (!serverLabel) return []
    const serverUrl = httpUrl(tool.server_url)
    return [
      {
        type: "mcp" as const,
        server_label: serverLabel,
        ...(serverUrl ? { server_url: serverUrl } : {}),
        ...(typeof tool.connector_id === "string" ? { connector_id: tool.connector_id } : {}),
        ...(stringArray(tool.allowed_tools) ? { allowed_tools: stringArray(tool.allowed_tools) } : {}),
        ...(stringArray(tool.tool_names) ? { tool_names: stringArray(tool.tool_names) } : {}),
        ...(typeof tool.authorization === "string" ? { authorization: tool.authorization } : {}),
        ...(stringRecord(tool.headers) ? { headers: stringRecord(tool.headers) } : {}),
        ...(requireApproval(tool.require_approval) ? { require_approval: requireApproval(tool.require_approval)! } : {}),
      },
    ]
  })
}

/**
 * The `require_approval` value on a declared toolset, in {@link McpRequireApproval} shape.
 *
 * Read here rather than assumed absent, because the approval policy is the one field on an `mcp`
 * tool that decides whether the toolset may run at all (Requirement 23). The inbound Claude
 * converter already validates the shape and throws on anything else, so a value arriving in another
 * shape came from a path that did not go through that converter; an unrecognised shape is *not*
 * dropped, it is normalised to the strictest recognised form (`{}`, an object with no exemption)
 * so it lands on the withholding branch rather than on the executing one.
 */
function requireApproval(value: unknown): McpRequireApproval | undefined {
  if (value === undefined || value === null) return undefined
  if (value === "always" || value === "never") return value
  if (typeof value !== "object" || Array.isArray(value)) return {}
  const object = value as { read_only?: unknown; tool_names?: unknown }
  return {
    ...(typeof object.read_only === "boolean" ? { read_only: object.read_only } : {}),
    ...(stringArray(object.tool_names) ? { tool_names: stringArray(object.tool_names)! } : {}),
  }
}

/** Whether this request declares any MCP toolset. The predicate the flag gate branches on. */
export function requestDeclaresMcpToolsets(tools: JsonObject[] = []): boolean {
  return tools.some((tool) => Boolean(tool) && tool.type === "mcp")
}

/**
 * The egress allowlist: the declared `server_url` values, and nothing derived from anywhere else.
 *
 * Normalized through `URL` so `https://h/mcp` and `https://h/mcp` spelled with a default port
 * compare equal — the confinement check must not be defeatable by an equivalent spelling, nor
 * pass one by accident.
 */
export function kiroMcpServerUrls(specs: readonly McpToolsetSpec[]): Set<string> {
  const urls = new Set<string>()
  for (const spec of specs) {
    const normalized = normalizeUrl(spec.server_url)
    if (normalized) urls.add(normalized)
  }
  return urls
}

/**
 * A `fetch` that refuses any URL outside `allowed`.
 *
 * The structural guarantee is already there — every URL the core client sees comes from a spec this
 * request declared — so this is the guarantee made *checkable*, and the thing that keeps an injected
 * transport honest. The refusal is a thrown `Error`, which core contains as a `transport` failure:
 * an out-of-boundary URL degrades the toolset instead of failing the request.
 *
 * ## Redirects are not followed
 *
 * Checking the requested URL is not enough on its own. `fetch` follows redirects by default, so a
 * declared server answering `302 Location: https://elsewhere/` would have this gateway repeat the
 * request — **including the `authorization` header** — against a host the client never declared, and
 * the check above would never see that URL. `redirect: "manual"` is therefore forced on every
 * request: the 3xx comes back as an ordinary non-OK response, core turns it into an
 * {@link McpProtocolError}, and the toolset degrades with a notice. A server that wants to move its
 * endpoint has to be declared at its new URL, which is exactly what Requirement 22.6 says.
 */
export function confineFetch(fetchFn: typeof fetch, allowed: ReadonlySet<string>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const requested = requestUrl(input)
    const normalized = normalizeUrl(requested)
    if (!normalized || !allowed.has(normalized)) {
      throw new Error(
        `MCP egress refused: ${JSON.stringify(redact(requested))} is not a server URL declared in mcp_servers`,
      )
    }
    return fetchFn(input, { ...(init ?? {}), redirect: "manual" })
  }) as typeof fetch
}

// ---------------------------------------------------------------------------
// Approval (Requirement 23)
// ---------------------------------------------------------------------------

/**
 * What one toolset's `require_approval` value asks of the gateway.
 *
 * Four kinds rather than the two literals plus "an object", because the two objects behave
 * identically here and the absent case behaves identically to `"never"` — an omitted policy is not
 * a request for approval.
 *
 * - `unrestricted` — absent, or `"never"`: the client states the calls need no approval, so the
 *   toolset runs normally (Requirement 23.2).
 * - `required` — `"always"`: every call needs an approval that cannot be obtained here
 *   (Requirement 23.1).
 * - `selective` — either object form: *some* calls need approval, and which ones depends on a
 *   reading of the selection (Requirement 23.3).
 */
export type KiroMcpApprovalKind = "unrestricted" | "required" | "selective"

/** {@link KiroMcpApprovalKind} for one value. Total: every value maps to exactly one kind. */
export function kiroMcpApprovalKind(value: McpRequireApproval | undefined): KiroMcpApprovalKind {
  if (value === undefined) return "unrestricted"
  if (value === "never") return "unrestricted"
  if (value === "always") return "required"
  return "selective"
}

export interface KiroMcpApprovalResolution {
  /** Toolsets that may be expanded and executed: exactly the `unrestricted` ones. */
  allowed: McpToolsetSpec[]
  /** Toolsets withheld, with the kind that withheld each. Never contacted, never expanded. */
  withheld: Array<{ spec: McpToolsetSpec; kind: Exclude<KiroMcpApprovalKind, "unrestricted"> }>
}

/**
 * Split the declared toolsets by approval policy, recording each non-`unrestricted` one as a
 * feature decision.
 *
 * **This is the only place in the Kiro upstream that interprets `require_approval`**, and it holds
 * no error channel of its own: a `required` toolset becomes a 400 by going through
 * `FeatureDecisions.resolveWithPolicy()` → `resolveFeature()` with the cell declared in
 * `./capabilities.ts`, exactly like every other Kiro degradation. So `NATIVE_STRICT`, the
 * first-rejection ordering, notice dedup, and `resolvedFeatures()` all behave here as they behave
 * everywhere else, and the caller's single existing `firstRejection()` bail point is the only place
 * that turns this into a response. Nothing here builds a message, compares a policy, or reads the
 * environment.
 *
 * ## The most restrictive interpretation, and why it is the whole toolset
 *
 * `McpRequireApproval`'s object form carries `read_only` and `tool_names` with no statement of
 * polarity, and both readings are live:
 *
 * - `tool_names` as *the tools that need approval* — then the rest may run.
 * - `tool_names` as *the tools exempt from approval* — then everything else needs it.
 *
 * The tools that may run without approval under **both** readings is the intersection, and the
 * intersection is empty. `read_only: true` is the same argument with a second gap on top: whether a
 * remote tool is read-only is not something `tools/list` states in any form this gateway can trust,
 * so no tool can be *shown* to be exempt. The most restrictive interpretation is therefore that
 * every tool on that server requires approval — and since no approval can be obtained, the whole
 * toolset is withheld and a notice says so (Requirement 23.3).
 *
 * ## Zero automatic approvals
 *
 * Structural, not a promise: `allowed` contains only `unrestricted` toolsets, and every other code
 * path in this module — expansion, egress allowlist, execution — is fed from `allowed`. There is no
 * branch that marks a call approved, no field named for approval is ever written (see
 * {@link mcpCallOutputItem}), and a withheld server is never contacted at all, so there is nothing
 * for an approval to attach to (Requirement 23.4).
 *
 * `decisions` is optional only so that a caller inspecting the split — a test, or a call site that
 * has not built its collector yet — can do so without one. The *withholding* does not depend on it,
 * so a missing collector can cost the client the report but can never cost it the protection.
 */
export function resolveKiroMcpApproval(
  specs: readonly McpToolsetSpec[],
  decisions?: FeatureDecisions,
): KiroMcpApprovalResolution {
  const allowed: McpToolsetSpec[] = []
  const withheld: KiroMcpApprovalResolution["withheld"] = []

  for (const spec of specs) {
    const kind = kiroMcpApprovalKind(spec.require_approval)
    if (kind === "unrestricted") {
      allowed.push(spec)
      continue
    }

    withheld.push({ spec, kind })
    decisions?.resolveWithPolicy(
      "mcpToolset",
      kind === "required" ? KIRO_MCP_APPROVAL_REQUIRED_POLICY : KIRO_MCP_APPROVAL_SELECTIVE_POLICY,
      redactSpecSecrets(approvalDetail(spec, kind), specs),
      APPROVAL_ALTERNATIVE,
    )
  }

  return { allowed, withheld }
}

/**
 * What the client should send instead, used verbatim in the notice's sibling 400.
 *
 * Names `require_approval: "never"` literally, which is what Requirement 23.1 asks the rejection to
 * carry: the client is not being told approvals are unsupported in the abstract, it is being told
 * the one value under which this toolset runs.
 */
const APPROVAL_ALTERNATIVE =
  'require_approval: "never" for that server, which states the calls need no approval, or an upstream that can ask you to approve each call'

/**
 * The `detail` for a withheld toolset: what was asked, why it cannot happen, and what was done.
 *
 * Prose about client intent only — no inbound wire vocabulary and no rendered warning text, which is
 * `src/inbound/<provider>/`'s to author (Requirement 9.5). `require_approval` is named because it is
 * the client's own field name in its own request, not a wire detail of this upstream.
 */
function approvalDetail(spec: McpToolsetSpec, kind: Exclude<KiroMcpApprovalKind, "unrestricted">): string {
  const server = JSON.stringify(spec.server_label)
  if (kind === "required") {
    return (
      `MCP toolset ${server} asks for your approval before each tool call, and this gateway is one-way — a request ` +
      `arrives and a stream goes back, with no channel on which to ask you — so no call to that server can be approved ` +
      `and none was attempted`
    )
  }
  return (
    `MCP toolset ${server} selects which tool calls need your approval, and this gateway has no channel on which to ask ` +
    `you for one; the selection can be read as naming the tools that need approval or as naming the ones exempt from it, ` +
    `so the most restrictive reading was taken — every tool on that server is treated as needing approval, and none of ` +
    `its tools were made available for this request`
  )
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Expand every declared toolset and return the session that intercepts its calls.
 *
 * Called before the payload is built. Expansion never throws for an unreachable server: core
 * returns a notice per dropped toolset and the request continues with whatever expanded
 * (Requirement 21.3), which is why this returns a session rather than a result union.
 *
 * A request with no `mcp` tool produces an inert session — no tools, no notices, `handles()` false
 * for every name — so the call site needs no second branch beyond the flag gate. A request whose
 * every toolset is withheld by {@link resolveKiroMcpApproval} produces the same inert session, and
 * the reason it is inert travels on `options.decisions` rather than on the session: a `"always"`
 * toolset is a 400 the call site raises from `decisions.firstRejection()`, at the same point it
 * raises every other one.
 */
export async function createKiroMcpSession(
  tools: JsonObject[] = [],
  options: KiroMcpSessionOptions = {},
): Promise<KiroMcpSession> {
  const declared = kiroMcpToolsets(tools)
  // The approval split runs *before* anything is expanded or contacted, so a toolset needing an
  // approval this gateway cannot obtain never reaches the network at all (Requirement 23.4).
  const { allowed: specs } = resolveKiroMcpApproval(declared, options.decisions)
  const serverUrls = kiroMcpServerUrls(specs)
  const toBlocks = options.toBlocks ?? mcpCallItemToBlocks
  const nextCallId = options.callId ?? (() => `mcp_${crypto.randomUUID().replace(/-/g, "")}`)

  const connection = {
    fetch: confineFetch(options.fetch ?? fetch, serverUrls),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.initialize !== undefined ? { initialize: options.initialize } : {}),
    ...(options.createClient ? { createClient: options.createClient } : {}),
    ...(options.onUnauthorized ? { onUnauthorized: options.onUnauthorized } : {}),
  }

  const expansion = specs.length
    ? await expandMcpToolsets(specs, {
        ...connection,
        maxNameLength: options.maxNameLength ?? KIRO_MCP_TOOL_NAME_MAX_LENGTH,
      })
    : undefined

  const map: McpToolNameMap | undefined = expansion?.map
  const tools_ = expansion?.tools ?? []
  const notices = (expansion?.notices ?? []).map((notice) => redactNotice(notice, specs))
  let mcpCalls = 0

  const session: KiroMcpSession = {
    tools: tools_,
    notices,
    serverUrls,
    get mcpCalls() {
      return mcpCalls
    },
    get active() {
      return tools_.length > 0
    },
    handles(name: string) {
      return Boolean(map?.resolve(name))
    },
    handleToolCall(call: KiroMcpToolCall): AsyncIterable<Canonical_Event> {
      return handle(call)
    },
    serverToolUseDelta() {
      return mcpCalls ? { mcpCalls } : undefined
    },
  }

  async function* handle(call: KiroMcpToolCall): AsyncIterable<Canonical_Event> {
    if (!map?.resolve(call.name)) {
      yield passThrough(call)
      return
    }

    let outcome: McpToolCallOutcome | undefined
    try {
      outcome = await executeMcpToolCall(map, { name: call.name, arguments: call.arguments }, { ...connection, specs })
    } catch (error) {
      // Core rethrows only a caller-initiated abort; anything else reaching here came from an
      // injected transport and is contained the same way a server failure is, so the caller's
      // stream still reaches its terminal event (Requirement 22.4).
      if (isCallerAbort(error, options.signal)) throw error
      outcome = {
        identity: { serverLabel: "unknown", serverUrl: "", toolName: call.name },
        exposedName: call.name,
        arguments: parsedArguments(call.arguments),
        content: redactSpecSecrets(messageOf(error), specs),
        isError: true,
        errorCategory: "transport",
      }
    }

    // `undefined` cannot happen after the `resolve()` guard above, but it is core's documented
    // "not an MCP call" answer, so it routes to the pass-through rather than to a throw.
    if (!outcome) {
      yield passThrough(call)
      return
    }

    // Counted once here, on the single path that completes a call, so the counter cannot drift from
    // the number of emitted result blocks (Requirement 22.3).
    mcpCalls += 1
    yield { type: "server_tool_block", blocks: kiroMcpBlocks(outcome, { id: nextCallId(), specs, toBlocks }) }
  }

  return session
}

function passThrough(call: KiroMcpToolCall): Canonical_Event {
  return { type: "tool_call_done", callId: call.callId, name: call.name, arguments: call.arguments }
}

// ---------------------------------------------------------------------------
// Outcome → `mcp_call` item → blocks
// ---------------------------------------------------------------------------

export interface McpBlockOptions {
  /** The `mcp_tool_use` id, and the `mcp_tool_result.tool_use_id` that must match it. */
  id?: string
  /** Toolsets whose credential values are stripped from the emitted payload (Requirement 22.7). */
  specs?: readonly McpToolsetSpec[]
  toBlocks?: McpBlockWriter
}

/**
 * The `mcp_call` output item for an executed call.
 *
 * This is the Responses-shaped interchange item `codexMcpToClaudeBlocks()` reads, which is what
 * makes the block pair below identical to the one the Codex path already emits rather than merely
 * similar. `name` is the *remote* tool name, not the mangled exposed name: the exposed name is a
 * wire detail of how the tool was offered to the model, and the client asked about
 * `server_name` + `name`.
 *
 * No `approval_request_id` is set, and setting one would be the defect Requirement 23.4 names:
 * {@link mcpCallItemToBlocks} forwards that field whenever it finds it, so writing one here would put
 * an approval reference on a block for a call nobody approved. The reader keeps the field for items
 * that arrive from an upstream already carrying one; this producer has no approval to reference.
 */
export function mcpCallOutputItem(outcome: McpToolCallOutcome, options: McpBlockOptions = {}): JsonObject {
  const specs = options.specs ?? []
  return {
    type: "mcp_call",
    id: options.id ?? `mcp_${crypto.randomUUID().replace(/-/g, "")}`,
    name: outcome.identity.toolName,
    server_label: outcome.identity.serverLabel,
    arguments: JSON.stringify(outcome.arguments ?? {}),
    output: redactDeep(outcome.content, specs),
    status: outcome.isError ? "failed" : "completed",
  }
}

/**
 * The `mcp_tool_use` / `mcp_tool_result` pair for an executed call.
 *
 * A failed call yields `is_error: true` and the failure message as the result content — the model
 * sees what went wrong and the turn continues (Requirement 22.4).
 */
export function kiroMcpBlocks(outcome: McpToolCallOutcome, options: McpBlockOptions = {}): JsonObject[] {
  const write = options.toBlocks ?? mcpCallItemToBlocks
  return write(mcpCallOutputItem(outcome, options))
}

/**
 * `codexMcpToClaudeBlocks()`'s algorithm for an `mcp_call` item, kept here because the import that
 * would reuse it crosses the `upstream → inbound` boundary. Equality with that function is asserted
 * over generated items in `test/upstream/kiro/mcp-toolset.property.test.ts`; treat any divergence
 * there as a defect in this copy, never as a reason to relax the assertion.
 */
export function mcpCallItemToBlocks(item: unknown, fallbackOutput?: unknown): JsonObject[] {
  if (!item || typeof item !== "object") return []
  const outputItem = item as {
    type?: unknown
    output?: unknown
    id?: unknown
    name?: unknown
    arguments?: unknown
    server_label?: unknown
    status?: unknown
    error?: unknown
    approval_request_id?: unknown
  }
  if (outputItem.type !== "mcp_call") return []

  const id = typeof outputItem.id === "string" ? outputItem.id : `mcp_${crypto.randomUUID().replace(/-/g, "")}`
  return [
    {
      type: "mcp_tool_use",
      id,
      name: typeof outputItem.name === "string" ? outputItem.name : "unknown",
      server_name: typeof outputItem.server_label === "string" ? outputItem.server_label : "unknown",
      input: parseJsonObject(typeof outputItem.arguments === "string" ? outputItem.arguments : "{}"),
      ...(typeof outputItem.approval_request_id === "string" ? { approval_request_id: outputItem.approval_request_id } : {}),
    },
    {
      type: "mcp_tool_result",
      tool_use_id: id,
      is_error: outputItem.status === "failed" || Boolean(outputItem.error),
      content: mcpOutputToClaudeContent(outputItem.output ?? fallbackOutput),
    },
  ]
}

function mcpOutputToClaudeContent(output: unknown): JsonObject[] {
  if (typeof output === "string") return [{ type: "text", text: output }]
  if (Array.isArray(output)) {
    return output.flatMap((item) => {
      if (typeof item === "string") return [{ type: "text", text: item }]
      if (!item || typeof item !== "object") return []
      const part = item as { type?: unknown; text?: unknown }
      if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }]
      return [{ type: "text", text: JSON.stringify(item) }]
    })
  }
  if (output && typeof output === "object") return [{ type: "text", text: JSON.stringify(output) }]
  return []
}

function parseJsonObject(value: string): JsonObject {
  try {
    return JSON.parse(value) as JsonObject
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Redaction (Requirement 22.7)
// ---------------------------------------------------------------------------

/**
 * Redact text leaving this module.
 *
 * Two passes, because they catch different things: `redact()` from `./errors.ts` rewrites
 * `authorization`-keyed values whatever they are (its `SECRET_KEYS` set, extended in task 34.1),
 * and the literal pass catches a credential a remote server echoed back with no key name attached.
 */
function redactSpecSecrets(text: string, specs: readonly McpToolsetSpec[]): string {
  let out = redact(text)
  for (const spec of specs) {
    for (const secret of [spec.authorization, ...Object.values(spec.headers ?? {})]) {
      if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join("[redacted]")
    }
  }
  return out
}

/** {@link redactSpecSecrets} applied to every string inside a payload of arbitrary shape. */
function redactDeep(value: unknown, specs: readonly McpToolsetSpec[]): unknown {
  if (typeof value === "string") return redactSpecSecrets(value, specs)
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, specs))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, specs)]))
  }
  return value
}

/** Core already redacts a notice against its own spec; this adds Kiro's key-name pass. */
function redactNotice(notice: Canonical_FeatureNotice, specs: readonly McpToolsetSpec[]): Canonical_FeatureNotice {
  return { ...notice, detail: redactSpecSecrets(notice.detail, specs) }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    const url = new URL(trimmed)
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : undefined
  } catch {
    return undefined
  }
}

function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  try {
    return new URL(value.trim()).toString()
  } catch {
    return undefined
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return (input as Request).url ?? String(input)
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const names = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  return names.length ? names : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return entries.length ? Object.fromEntries(entries) : undefined
}

function parsedArguments(value: string): unknown {
  if (!value.trim()) return {}
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isCallerAbort(error: unknown, signal?: AbortSignal): boolean {
  const isAbort = (error instanceof DOMException || error instanceof Error) && error.name === "AbortError"
  return isAbort && signal?.aborted === true
}
