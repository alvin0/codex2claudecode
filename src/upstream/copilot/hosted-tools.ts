import type { Canonical_Request } from "../../core/canonical"
import { isCanonicalWebFetchTool, isCanonicalWebFetchToolType } from "../../core/canonical-tools"
import type { FeatureDecisions } from "../../core/feature-decisions"
import { resolveHostedToolPolicy } from "../../core/feature-policy"
import type { ProviderFeature } from "../../core/provider-capabilities"
import type { JsonObject } from "../../core/types"
import { COPILOT_CAPABILITIES, COPILOT_UNDECLARED_HOSTED_TOOL_POLICY } from "./capabilities"

/**
 * Hosted tool handling for the Copilot upstream, read from the declared matrix.
 *
 * Requirements 19.2 through 19.5. Every hosted tool type the request carries is looked up in
 * `COPILOT_CAPABILITIES.hostedTools` through `resolveHostedToolPolicy()` and handed to
 * {@link FeatureDecisions}; a type absent from that map falls back to
 * `COPILOT_UNDECLARED_HOSTED_TOOL_POLICY`, which reports and completes rather than throwing.
 *
 * **No provider-name comparison anywhere on this path** (Requirement 19.5). The only inputs are the
 * request's tool list and this directory's own declaration — no provider identifier, no
 * `providerKind`, no model name. The reason a `code_interpreter` tool is forwarded here and refused
 * on Kiro is a difference between two `capabilities.ts` cells, not a branch.
 *
 * **Why this is a separate file from `../codex/hosted-tools.ts`.** Same shape, deliberately not
 * shared: the type names are one upstream's wire vocabulary, the prose in a notice is the wording
 * that upstream owes its clients, and a cross-provider import under `src/upstream/` is an edge the
 * architecture rules forbid. A shared helper would have to live in `src/core/`, which is the one
 * place a Responses type name may not go. `./features.ts` and `../codex/features.ts` are duplicated
 * for exactly this reason and this file follows them.
 *
 * The forward is a named function here — {@link forwardCopilotHostedTools} — the way it is in Codex's
 * module, and for the same single reason: this upstream posts a Responses body too, so it has no
 * fetch tool either, and a canonical fetch has to leave as a search. Every other type is identity,
 * which is Requirement 19.1's guarantee applied to the same wire vocabulary.
 */

/** The one tool type that is not a hosted tool — see `../codex/hosted-tools.ts` for the reasoning. */
const FUNCTION_TOOL_TYPE = "function"

/**
 * Which declared feature a hosted tool decision is recorded under.
 *
 * `Canonical_FeatureNotice.feature` is a {@link ProviderFeature}, so every hosted tool decision has
 * to name one of core's twelve. Two of the ten types have a feature of their own; the rest are
 * recorded under `mcpToolset`, the one member that means "a tool the upstream hosts and runs on the
 * client's behalf". The attribution matches `../codex/hosted-tools.ts` because it follows from
 * core's vocabulary rather than from anything either upstream measured.
 */
const HOSTED_TOOL_FEATURES: Readonly<Record<string, ProviderFeature>> = {
  web_search: "webSearch",
  web_search_preview: "webSearch",
}

/** The feature an undeclared type, or a declared one with no entry above, is recorded under. */
const DEFAULT_HOSTED_TOOL_FEATURE: ProviderFeature = "mcpToolset"

function hostedToolFeature(type: string): ProviderFeature {
  return Object.hasOwn(HOSTED_TOOL_FEATURES, type) ? HOSTED_TOOL_FEATURES[type]! : DEFAULT_HOSTED_TOOL_FEATURE
}

/** Whether this tool asks the upstream to run a tool of its own. */
export function isCopilotHostedTool(tool: JsonObject): boolean {
  return typeof tool.type === "string" && tool.type.length > 0 && tool.type !== FUNCTION_TOOL_TYPE
}

/** The hosted tool types this request carries, in the order they were sent, each once. */
export function copilotHostedToolTypes(tools: Canonical_Request["tools"]): string[] {
  const seen = new Set<string>()
  for (const tool of tools ?? []) {
    if (isCopilotHostedTool(tool)) seen.add(tool.type as string)
  }
  return [...seen]
}

/**
 * The tool list as it goes on the wire.
 *
 * Identity for every type — see `../codex/hosted-tools.ts` for why that is the requirement — except
 * a canonical fetch, which this protocol cannot express and which therefore travels as a search,
 * scoping fields and all. That substitution is the declared `features.webFetch` cell, reported by
 * {@link resolveCopilotHostedTools} rather than performed in silence, and it produces the same bytes
 * this upstream received while the inbound layer was the one doing the swap.
 *
 * `undefined` in, `undefined` out, so an absent tool list stays absent rather than becoming an empty
 * array — the emit guard in `buildCopilotResponsesBody()` reads the difference.
 */
export function forwardCopilotHostedTools(tools: Canonical_Request["tools"]): JsonObject[] | undefined {
  if (!tools) return undefined
  const forwarded = tools.map((tool) => (isCanonicalWebFetchTool(tool) ? { ...tool, type: WEB_SEARCH_TOOL_TYPE } : tool))
  // At most one search on the wire: a client declaring both a search and a fetch would otherwise send
  // the same tool twice, where the inbound converter used to collapse the pair before this upstream
  // saw it. First entry wins, which keeps the client's order and its scoping fields.
  return forwarded.filter((tool, index) => tool.type !== WEB_SEARCH_TOOL_TYPE || forwarded.findIndex((item) => item.type === WEB_SEARCH_TOOL_TYPE) === index)
}

/**
 * This endpoint's own name for its search tool, and the target of the fetch substitution.
 *
 * Spelled here rather than imported from `src/core/`, for the reason the ten names in
 * `./capabilities.ts` are duplicated per upstream: a Responses hosted type name may not enter core.
 */
const WEB_SEARCH_TOOL_TYPE = "web_search"

/**
 * Resolve every hosted tool type this request carries against the declared matrix.
 *
 * Called from `./index.ts` rather than from `resolveCopilotFeatures()`, because the three features
 * these decisions land under are the three that `./features.ts` documents as decided while the tool
 * list is read (`test/upstream/no-silent-drop.test.ts` holds that attribution in both directions).
 */
export function resolveCopilotHostedTools(tools: Canonical_Request["tools"], decisions: FeatureDecisions): void {
  for (const type of copilotHostedToolTypes(tools)) {
    // The fetch type is not a `hostedTools` lookup and never will be: this protocol has no fetch
    // tool, so its outcome is the declared `features.webFetch` cell that the substitution in
    // `forwardCopilotHostedTools()` implements.
    if (isCanonicalWebFetchToolType(type)) {
      decisions.resolveWithPolicy("webFetch", COPILOT_CAPABILITIES.features.webFetch, substitutedFetchDetail(type), FETCH_ALTERNATIVE)
      continue
    }

    const declared = resolveHostedToolPolicy(COPILOT_CAPABILITIES.hostedTools, type)
    decisions.resolveWithPolicy(
      hostedToolFeature(type),
      declared ?? COPILOT_UNDECLARED_HOSTED_TOOL_POLICY,
      declared === undefined ? undeclaredDetail(type) : declaredDetail(type),
      declared === undefined ? UNDECLARED_ALTERNATIVE : DECLARED_ALTERNATIVE,
    )
  }
}

/**
 * What happened to a tool whose type this upstream declares.
 *
 * Unused on today's matrix — all ten declared types are handled natively here — and written anyway,
 * because this upstream's cells are the least measured in the tree and the first Run_Record against
 * GitHub's proxy could lower any of them. The wording has to exist before that happens.
 */
function declaredDetail(type: string): string {
  return `the '${type}' tool is one of the hosted tool types this upstream declares, so it is sent on with that type rather than reshaped into a function tool`
}

/** What happened to a tool whose type this upstream does not declare (Requirement 19.4). */
function undeclaredDetail(type: string): string {
  return `the '${type}' tool is not one of the hosted tool types this upstream declares, so it is sent on as written and may not be run at all`
}

/** What happened to a fetch tool — see `../codex/hosted-tools.ts` for the shared reasoning. */
function substitutedFetchDetail(type: string): string {
  return `this endpoint has no fetch tool of its own, so the '${type}' tool was sent as a web search instead; the domain and location scoping of the fetch was kept`
}

const DECLARED_ALTERNATIVE = "a client function tool, if the hosted version is not wanted"
const UNDECLARED_ALTERNATIVE = "one of the hosted tool types this upstream declares, or a client function tool"
const FETCH_ALTERNATIVE = "a client function tool that performs the fetch, or an upstream with a hosted fetch tool"
