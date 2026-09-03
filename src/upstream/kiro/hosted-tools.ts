import { isCanonicalWebFetchToolType } from "../../core/canonical-tools"
import type { Canonical_Request } from "../../core/canonical"
import type { FeatureDecisions } from "../../core/feature-decisions"
import { resolveHostedToolPolicy } from "../../core/feature-policy"
import type { ProviderFeature } from "../../core/provider-capabilities"
import type { JsonObject } from "../../core/types"
import { KIRO_CAPABILITIES, KIRO_UNDECLARED_HOSTED_TOOL_POLICY } from "./capabilities"

/**
 * Hosted tool handling for the Kiro (CodeWhisperer `generateAssistantResponse`) upstream, read
 * from the declared matrix.
 *
 * Requirements 19.2 through 19.5. Every hosted tool type the request carries is looked up in
 * `KIRO_CAPABILITIES.hostedTools` through `resolveHostedToolPolicy()` and handed to
 * {@link FeatureDecisions}; a type absent from that map falls back to
 * `KIRO_UNDECLARED_HOSTED_TOOL_POLICY`, which reports and completes rather than refusing
 * (Requirement 19.4).
 *
 * **This replaces a pair of hardcoded type comparisons.** `validateUnsupportedServerTools()`
 * (`./index.ts`) refused exactly two type names — a server-side fetch tool and a generic server
 * toolset — with three fixed 400 strings, and said nothing at all about the other eight declared
 * types: an `image_generation` or `code_interpreter` tool travelled to an endpoint that has no such
 * tool and was never mentioned to the client. That is the silent drop the matrix removes. The
 * outcome for every type now comes from a `capabilities.ts` cell, so lowering or raising one is a
 * one-line declaration change rather than an edit to a validator.
 *
 * **No provider-name comparison anywhere on this path** (Requirement 19.5). The only inputs are the
 * request's tool list and this directory's own declaration — no provider identifier, no
 * `providerKind`, no model name. The reason a `code_interpreter` tool is refused here and forwarded
 * on the Responses upstreams is a difference between two `capabilities.ts` cells, not a branch.
 *
 * **Why this is a separate file from the other two upstreams' modules of the same name.** Same
 * shape, deliberately not shared: the ten type names are one upstream's wire vocabulary, the prose
 * in a notice is the wording that upstream owes its clients, and a cross-provider import under
 * `src/upstream/` is an edge the architecture rules forbid. A shared helper would have to live in
 * `src/core/`, which is the one place a Responses type name may not go. `./features.ts` and its two
 * counterparts are duplicated for exactly this reason and this file follows them.
 *
 * There is no forwarding function here, unlike the Codex module's: Requirement 19.1 is about an
 * upstream that puts a hosted tool on the wire with its original `type`, and this endpoint has no
 * hosted tool field at all — `convertCanonicalToKiroPayload()` (`./payload.ts`) only ever sends
 * client function tools. So the two questions this file answers collapse to one: what the client is
 * told.
 */

/**
 * The one tool type that is not a hosted tool.
 *
 * A function tool is the client's own code, called back by the client; every other `type` in a tool
 * list names a tool the client expects someone upstream to run. So "hosted" is decided by exclusion
 * rather than by matching the ten declared names — a type nobody declared is still a hosted tool,
 * and Requirement 19.4 is precisely about telling the client what happened to it. Matching the
 * declared names instead would make an unlisted type invisible again, which is the behavior this
 * module exists to end.
 */
const FUNCTION_TOOL_TYPE = "function"

/**
 * Which declared feature a hosted tool decision is recorded under.
 *
 * `Canonical_FeatureNotice.feature` is a {@link ProviderFeature}, so every hosted tool decision has
 * to name one of core's twelve. Two of the ten types have a feature of their own; the rest are
 * recorded under `mcpToolset`, the one member of the vocabulary that means "a tool the upstream
 * hosts and runs on the client's behalf". The attribution is identical to the Codex and Copilot
 * modules' because it follows from core's vocabulary rather than from anything this upstream
 * measured.
 *
 * Written as an explicit table rather than a regex on the name, so a reader sees the attribution of
 * every declared type at once and adding a type is a visible edit.
 */
const HOSTED_TOOL_FEATURES: Readonly<Record<string, ProviderFeature>> = {
  web_search: "webSearch",
  web_search_preview: "webSearch",
}

/**
 * The one capability two of the declared type names spell two ways.
 *
 * `web_search` and `web_search_preview` are the same hosted intent — `./capabilities.ts` says so in
 * as many words ("`web_search` (and its Responses alias)"), declares the same `emulate` cell for
 * both, and {@link HOSTED_TOOL_FEATURES} records both under `webSearch`. Requirement 10.2 is per
 * *field*: a field resolving to `degrade` or `emulate` gets **exactly one** notice. So a request
 * carrying both spellings is one dropped capability and owes the client one notice.
 *
 * {@link FeatureDecisions} dedups on the pair `(feature, detail)`, which means the two spellings can
 * only collapse if they produce the same detail. Naming each spelling separately made the pair
 * differ and emitted two notices for one capability — the defect this constant removes. The detail
 * therefore names the canonical spelling and mentions the alias, so a client that sent either one
 * still recognises its own tool in the text while the dedup key stays single.
 *
 * The alternative reading — keep the detail naming whatever the client actually sent, and dedup on
 * `feature` alone for this cell — was rejected: nothing in Requirements 10.2 or 19.2 through 19.5
 * asks the detail to echo the client's spelling, and weakening the dedup key in core would silently
 * merge genuinely different details for the same feature everywhere (an undeclared type and a
 * declared one both land on `mcpToolset` with deliberately different texts).
 */
const WEB_SEARCH_DETAIL_SUBJECT = "'web_search' (or its 'web_search_preview' alias)"

/**
 * The phrase a notice detail uses for a type, canonical per capability rather than per spelling.
 *
 * Only the aliased pair needs an entry; every other declared type is its own capability and is named
 * as sent.
 */
const HOSTED_TOOL_DETAIL_SUBJECTS: Readonly<Record<string, string>> = {
  web_search: WEB_SEARCH_DETAIL_SUBJECT,
  web_search_preview: WEB_SEARCH_DETAIL_SUBJECT,
}

function hostedToolDetailSubject(type: string): string {
  return Object.hasOwn(HOSTED_TOOL_DETAIL_SUBJECTS, type) ? HOSTED_TOOL_DETAIL_SUBJECTS[type]! : `'${type}'`
}

/** The feature an undeclared type, or a declared one with no entry above, is recorded under. */
const DEFAULT_HOSTED_TOOL_FEATURE: ProviderFeature = "mcpToolset"

function hostedToolFeature(type: string): ProviderFeature {
  return Object.hasOwn(HOSTED_TOOL_FEATURES, type) ? HOSTED_TOOL_FEATURES[type]! : DEFAULT_HOSTED_TOOL_FEATURE
}

/** Whether this tool asks the upstream to run a tool of its own. */
export function isKiroHostedTool(tool: JsonObject): boolean {
  return typeof tool.type === "string" && tool.type.length > 0 && tool.type !== FUNCTION_TOOL_TYPE
}

/**
 * The hosted tool types this request carries, in the order they were sent, each once.
 *
 * Deduped because two `web_search` tools are one decision about one type, and a client that sent
 * both should not be told the same thing twice. Order is the client's, so the notice sequence and
 * the 400 a client sees are stable for a given request rather than dependent on the shape of the
 * map.
 */
export function kiroHostedToolTypes(tools: Canonical_Request["tools"]): string[] {
  const seen = new Set<string>()
  for (const tool of tools ?? []) {
    if (isKiroHostedTool(tool)) seen.add(tool.type as string)
  }
  return [...seen]
}

/**
 * Resolve every hosted tool type this request carries against the declared matrix.
 *
 * Requirements 19.2 through 19.5. One `resolveWithPolicy()` per type, so the outcome a client gets
 * is the declared cell and nothing else: a refusing cell produces the 400 the caller reads off
 * `firstRejection()`, a reporting cell produces one notice, and a native cell produces neither.
 * Resolution never stops early, for the same reason `./features.ts` does not — the account of what
 * the request asked for stays complete even when it ends in a 400.
 *
 * Called from `./index.ts` rather than from `resolveKiroFeatures()`, because the three features
 * these decisions land under are the three that `./features.ts` documents as decided while the tool
 * list is read (`test/upstream/no-silent-drop.test.ts` holds that attribution in both directions).
 * It must run on the same {@link FeatureDecisions} that request already built, so a refused hosted
 * tool carries the notices every other decision produced.
 *
 * Returns nothing: the decisions object *is* the result. A caller wanting the 400 reads
 * `firstRejection()`, exactly as it does for the request-shaped features, so there is no second
 * error channel to keep in step with the first.
 */
export function resolveKiroHostedTools(tools: Canonical_Request["tools"], decisions: FeatureDecisions): void {
  for (const type of kiroHostedToolTypes(tools)) {
    // A fetch is the one type whose outcome is not a `hostedTools` lookup, for the same reason it is
    // not on the Responses upstreams: it is not one of the ten and never will be, because this
    // endpoint's server-side toolset is exactly `web_search` (spike §9.2). Its policy is the declared
    // `features.webFetch` cell — the same cell `computeEffectiveTools()` (`./index.ts`) implements by
    // injecting the gateway's own `web_fetch` function tool — so the notice a client reads and the
    // matrix a reader reads are the same fact.
    //
    // Without this branch a fetch fell to `KIRO_UNDECLARED_HOSTED_TOOL_POLICY` and was reported under
    // `mcpToolset` as a tool "nothing here claims to run", while the gateway went on to run it; under
    // `NATIVE_STRICT` that degrading fallback escalated to a 400 and refused a request this upstream
    // declares it can serve. A canonical fetch only started arriving here once the inbound side
    // gained a canonical spelling for it (`src/core/canonical-tools.ts`), which is why the gap opened
    // where a `web_search` substitution used to hide it.
    if (isCanonicalWebFetchToolType(type)) {
      decisions.resolveWithPolicy("webFetch", KIRO_CAPABILITIES.features.webFetch, emulatedFetchDetail(type), FETCH_ALTERNATIVE)
      continue
    }

    const declared = resolveHostedToolPolicy(KIRO_CAPABILITIES.hostedTools, type)
    decisions.resolveWithPolicy(
      hostedToolFeature(type),
      declared ?? KIRO_UNDECLARED_HOSTED_TOOL_POLICY,
      declared === undefined ? undeclaredDetail(type) : declaredDetail(type),
      declared === undefined ? UNDECLARED_ALTERNATIVE : DECLARED_ALTERNATIVE,
    )
  }
}

/**
 * What happened to a tool whose type this upstream declares.
 *
 * One text for all ten declared types, because on this endpoint one sentence is true of every one
 * of them: there is no hosted tool field on the wire, so the tool is not sent as a hosted tool at
 * all, and what the client gets depends on whether the gateway can stand in for it. The refusing
 * cells turn this into "does not support … Use … instead."; the two emulating cells turn it into a
 * notice saying the gateway ran the tool itself.
 *
 * Names the capability, because the type is the fact the client needs in either case — through
 * {@link hostedToolDetailSubject}, so the two spellings of the web search capability produce one
 * text and therefore one notice (Requirement 10.2).
 */
function declaredDetail(type: string): string {
  return `this endpoint has no hosted tool field, so the ${hostedToolDetailSubject(type)} tool is not sent upstream as a hosted tool — the gateway runs it on the request's behalf where it can, and where it cannot the tool cannot run at all`
}

/**
 * What happened to a tool whose type this upstream does not declare (Requirement 19.4).
 *
 * Names the type, because the type is the fact the client needs: it sent a tool nobody has measured
 * against this endpoint, no hosted tool field carries it, and whether anything runs it is unknown.
 * That is a changed meaning the client is owed a report about, not a reason to refuse the request —
 * refusing would assert knowledge `./capabilities.ts` does not have, which is why the fallback
 * there reports instead.
 */
function undeclaredDetail(type: string): string {
  return `the '${type}' tool is not one of the hosted tool types this upstream declares, so nothing here claims to run it and it may not run at all`
}

/**
 * What happened to a fetch tool (Requirement 18.6).
 *
 * Says the gateway performed the fetch, because that is the whole of the difference from a native
 * hosted fetch: the page is retrieved and returned as a `web_fetch_tool_result` (`./web-fetch.ts`),
 * but the retrieval happens here rather than upstream, so it is the gateway's network reach and not
 * the model's. Names the type as sent, since the dated spellings are one capability with one policy
 * and echoing the client's own name costs nothing.
 */
function emulatedFetchDetail(type: string): string {
  return `this endpoint has no server-side fetch tool, so the '${type}' tool is not sent upstream — the gateway fetches the URL itself and returns the page as a web_fetch_tool_result`
}

/** What to do instead when a fetch cannot be served at all. */
const FETCH_ALTERNATIVE = "a client function tool that fetches the URL, or an upstream that hosts a fetch tool"

const DECLARED_ALTERNATIVE = "a client function tool, or the gateway's own web_search helper"
const UNDECLARED_ALTERNATIVE = "one of the hosted tool types this upstream declares, or a client function tool"
