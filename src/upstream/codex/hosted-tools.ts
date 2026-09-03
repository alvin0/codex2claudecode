import type { Canonical_Request } from "../../core/canonical"
import type { FeatureDecisions } from "../../core/feature-decisions"
import { resolveHostedToolPolicy } from "../../core/feature-policy"
import type { ProviderFeature } from "../../core/provider-capabilities"
import { isCanonicalWebFetchTool, isCanonicalWebFetchToolType } from "../../core/canonical-tools"
import type { JsonObject } from "../../core/types"
import { CODEX_CAPABILITIES, CODEX_UNDECLARED_HOSTED_TOOL_POLICY } from "./capabilities"

/**
 * Hosted tools on the Codex (OpenAI Responses) upstream: forwarded with their own `type`, and
 * their handling read from the declared matrix.
 *
 * Role, and only this role. This module answers two questions about the tool list and nothing
 * else:
 *
 * 1. **What goes on the wire** — {@link forwardCodexHostedTools}, the whole of Requirement 19.1.
 *    A hosted tool leaves exactly as it arrived, so it is never reshaped into the five-field
 *    function shape `claudeFunctionToolToResponsesTool()` (`src/inbound/claude/server-tools.ts`)
 *    produces. That converter is an inbound module this file may not import and does not need to:
 *    the guarantee is structural, not a comparison against what it would have built.
 * 2. **What the client is told** — {@link resolveCodexHostedTools}, the whole of Requirements 19.2
 *    through 19.5. Every hosted tool type the request carries is looked up in
 *    `CODEX_CAPABILITIES.hostedTools` through `resolveHostedToolPolicy()` and handed to
 *    {@link FeatureDecisions}. A type absent from that map falls back to
 *    `CODEX_UNDECLARED_HOSTED_TOOL_POLICY`, which reports and completes rather than throwing
 *    (Requirement 19.4).
 *
 * **No provider-name comparison anywhere on this path** (Requirement 19.5). Nothing below reads a
 * provider identifier, a `providerKind`, or a model name; the only inputs are the request's tool
 * list and this directory's own declaration. That is what makes the Codex and Kiro outcomes for
 * the same tool a diff between two `capabilities.ts` cells rather than a branch in shared code —
 * the same rule `./features.ts` follows for the request-shaped features.
 *
 * **Why this is not shared with the other upstreams.** `../copilot/hosted-tools.ts` is the same
 * shape and deliberately a separate file. The type names are one upstream's wire vocabulary, the
 * prose in a notice is the wording that upstream owes its clients, and a cross-provider import
 * under `src/upstream/` is an edge the architecture rules forbid. A shared helper would have to
 * live in `src/core/`, which is the one place a Responses type name may not go.
 */

/**
 * The one tool type that is not a hosted tool.
 *
 * A function tool is the client's own code, called back by the client; every other `type` in a
 * Responses tool list names a tool the upstream runs itself. So "hosted" is decided by exclusion
 * rather than by matching the ten declared names — a type nobody declared is still a hosted tool,
 * and Requirement 19.4 is precisely about telling the client what happened to it. Matching the
 * declared names instead would make an unlisted type invisible, which is the silent drop this
 * whole path exists to remove.
 */
const FUNCTION_TOOL_TYPE = "function"

/**
 * Which declared feature a hosted tool decision is recorded under.
 *
 * `Canonical_FeatureNotice.feature` is a {@link ProviderFeature}, so every hosted tool decision
 * has to name one of core's twelve. Two of the ten types have a feature of their own; the rest
 * are recorded under `mcpToolset`, the one member of the vocabulary that means "a tool the
 * upstream hosts and runs on the client's behalf".
 *
 * Rejected alternative: a thirteenth `ProviderFeature` for hosted tools. It would force a new
 * cell into all three `features` records plus the hand-written `DECLARED_POLICY_MATRIX` in
 * `test/upstream/capabilities.property.test.ts`, for a feature no upstream declares independently
 * of its `hostedTools` map — the map *is* the per-type declaration. If a later measurement makes
 * one of these types deserve its own cell, it gets one here first.
 *
 * Written as an explicit table rather than a regex on the name, so a reader sees the attribution
 * of every declared type at once and adding a type is a visible edit.
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
export function isCodexHostedTool(tool: JsonObject): boolean {
  return typeof tool.type === "string" && tool.type.length > 0 && tool.type !== FUNCTION_TOOL_TYPE
}

/**
 * The hosted tool types this request carries, in the order they were sent, each once.
 *
 * Deduped because two `web_search` tools are one decision about one type, and a client that sent
 * both should not be told the same thing twice. Order is the client's, so the notice sequence and
 * the rejection a client sees are stable for a given request rather than dependent on the shape of
 * the map.
 */
export function codexHostedToolTypes(tools: Canonical_Request["tools"]): string[] {
  const seen = new Set<string>()
  for (const tool of tools ?? []) {
    if (isCodexHostedTool(tool)) seen.add(tool.type as string)
  }
  return [...seen]
}

/**
 * The tool list as it goes on the wire, with every hosted tool keeping its original `type`.
 *
 * Requirement 19.1, and the reason it is a function rather than a comment on
 * `canonicalToCodexBody()`: the guarantee used to be incidental — `tools: request.tools` happened
 * to forward whatever it was given, so nothing failed if a converter were ever spliced onto the
 * path. Now the forward is named, and `test/upstream/hosted-tools.property.test.ts` holds it.
 *
 * The identity of each entry is preserved, not a copy of it: the strongest available statement of
 * "untouched" is that the object on the wire is the object the client sent. `undefined` in,
 * `undefined` out, so an absent tool list stays absent instead of becoming an empty array — the
 * emit guard in `canonicalToCodexBody()` reads the difference.
 */
export function forwardCodexHostedTools(tools: Canonical_Request["tools"]): JsonObject[] | undefined {
  if (!tools) return undefined
  return dedupeSearchTools(tools.map(forwardOneCodexTool))
}

/**
 * One tool, on its way to the wire.
 *
 * Identity for every type this endpoint has — whatever the client sent is what the upstream
 * receives — with exactly one exception, and the exception is the declared `features.webFetch` cell
 * rather than a new decision: this protocol has no fetch tool. The ten hosted type names in
 * Requirement 19.1 do not include one, so a canonical fetch is sent as a search, which is the same
 * bytes this upstream received before the canonical vocabulary could tell the two apart. What
 * changed is that the swap is now *reported* — `resolveCodexHostedTools()` records it under
 * `webFetch` — instead of happening invisibly inside an inbound converter, which is what made it
 * the silent substitution Requirement 10.1 forbids.
 *
 * The scoped fields ride along untouched, so a `filters` or `user_location` the client attached to
 * its fetch still narrows the search that replaces it. A copy rather than a mutation, because the
 * canonical request belongs to the caller and another upstream may read it after this one.
 */
function forwardOneCodexTool(tool: JsonObject): JsonObject {
  if (!isCanonicalWebFetchTool(tool)) return tool
  return { ...tool, type: WEB_SEARCH_TOOL_TYPE }
}

/**
 * At most one search tool on the wire.
 *
 * Needed only because of the substitution above: a client that declares both a search and a fetch
 * now sends two tools that arrive here as two searches, where the inbound converter used to collapse
 * them into one before this upstream ever saw them. The first entry wins, which keeps the client's
 * order and keeps the scoping fields of whichever tool it declared first — the same tool the old
 * inbound dedupe kept.
 *
 * Identity-preserving for every list that carries no duplicate, so the "the object on the wire is
 * the object the client sent" guarantee above still holds wherever there is nothing to collapse.
 */
function dedupeSearchTools(tools: JsonObject[]): JsonObject[] {
  return tools.filter((tool, index) => tool.type !== WEB_SEARCH_TOOL_TYPE || tools.findIndex((item) => item.type === WEB_SEARCH_TOOL_TYPE) === index)
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
 * Requirements 19.2 through 19.5. One `resolveWithPolicy()` per type, so the outcome a client
 * gets is the declared cell and nothing else: a reporting cell produces one notice, a refusing
 * cell produces the 400 the caller reads off `firstRejection()`, and a native cell produces
 * neither. Resolution never stops early, for the same reason `./features.ts` does not — the
 * account of what the request asked for stays complete even when it ends in a 400.
 *
 * Called from `./index.ts` rather than from `resolveCodexFeatures()`, because the three features
 * these decisions land under are the three that `./features.ts` documents as decided while the
 * tool list is read (`test/upstream/no-silent-drop.test.ts` holds that attribution in both
 * directions).
 */
export function resolveCodexHostedTools(tools: Canonical_Request["tools"], decisions: FeatureDecisions): void {
  for (const type of codexHostedToolTypes(tools)) {
    // A fetch is the one type whose outcome is not a `hostedTools` lookup: it is not one of the ten
    // and never will be, because this protocol has no fetch tool. Its policy is the declared
    // `features.webFetch` cell — the same cell the substitution in `forwardOneCodexTool()` implements
    // — so the notice a client reads and the matrix a reader reads are the same fact.
    if (isCanonicalWebFetchToolType(type)) {
      decisions.resolveWithPolicy("webFetch", CODEX_CAPABILITIES.features.webFetch, substitutedFetchDetail(type), FETCH_ALTERNATIVE)
      continue
    }

    const declared = resolveHostedToolPolicy(CODEX_CAPABILITIES.hostedTools, type)
    decisions.resolveWithPolicy(
      hostedToolFeature(type),
      declared ?? CODEX_UNDECLARED_HOSTED_TOOL_POLICY,
      declared === undefined ? undeclaredDetail(type) : declaredDetail(type),
      declared === undefined ? UNDECLARED_ALTERNATIVE : DECLARED_ALTERNATIVE,
    )
  }
}

/**
 * What happened to a tool whose type this upstream declares.
 *
 * Unused on today's matrix — all ten declared types are handled natively here, and a native
 * outcome carries no notice — and written anyway, because the wording is what a client would see
 * the moment a measurement lowers one of those cells. A blank detail at that point would be a
 * silent drop wearing a notice's clothes.
 */
function declaredDetail(type: string): string {
  return `the '${type}' tool is one of this endpoint's own hosted tool types, so it is sent on with that type rather than reshaped into a function tool`
}

/**
 * What happened to a tool whose type this upstream does not declare.
 *
 * Names the type, because the type is the fact the client needs: it sent a tool nobody has
 * measured against this endpoint, the tool travels as written, and whether the upstream runs it is
 * unknown. That is a changed meaning the client is owed a report about, not a reason to refuse the
 * request (Requirement 19.4).
 */
function undeclaredDetail(type: string): string {
  return `the '${type}' tool is not one of the hosted tool types this upstream declares, so it is sent on as written and may not be run at all`
}

/**
 * What happened to a fetch tool.
 *
 * Names both halves of the substitution — the tool that was asked for and the tool that was sent —
 * because a client whose fetch came back as search results needs to know why. The fetch intent is
 * not lost: this endpoint reaches a page as the `open_page` action of a search call, which the
 * inbound layer renders back as a fetch result. That is a changed meaning rather than a discarded
 * field, which is what makes this a report instead of a 400.
 */
function substitutedFetchDetail(type: string): string {
  return `this endpoint has no fetch tool of its own, so the '${type}' tool was sent as a web search instead; a page is still reached, as a search that opens it, and the domain and location scoping of the fetch was kept`
}

const DECLARED_ALTERNATIVE = "a client function tool, if the hosted version is not wanted"
const UNDECLARED_ALTERNATIVE = "one of the hosted tool types this upstream declares, or a client function tool"
const FETCH_ALTERNATIVE = "a client function tool that performs the fetch, or an upstream with a hosted fetch tool"
