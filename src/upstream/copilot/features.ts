import type { Canonical_Request } from "../../core/canonical"
import { FeatureDecisions } from "../../core/feature-decisions"
import type { JsonObject } from "../../core/types"
import { COPILOT_CAPABILITIES } from "./capabilities"

/**
 * Apply the declared Copilot matrix to one request.
 *
 * Role, and only this role: look at a {@link Canonical_Request}, decide which of the
 * request-shaped features this upstream covers are actually present, and hand each one to
 * {@link FeatureDecisions} with the prose that explains what happened to it. It builds no
 * payload, calls nothing, renders nothing, and reads no environment. Same shape as
 * `../codex/features.ts` and `../kiro/features.ts`: one file per upstream, each reading only
 * its own declaration.
 *
 * ## What "declaration-only" means for this file
 *
 * Requirement 26.9 makes this upstream declaration-only — unit tests, no live case, and
 * `COPILOT_CAPABILITY_EVIDENCE` records every cell as unmeasured. So the resolutions below are
 * as checkable as the declaration they read and no more: each one says what the Gateway does
 * with a client-supplied field on the way to this endpoint, never what GitHub's endpoint does
 * with it afterwards. Raising confidence is a matter of measuring the cell in
 * `./capabilities.ts`, not of rewording anything here.
 *
 * ## The resolved set
 *
 * Nine features are decided purely from the incoming request: `sampling`, `outputLength`,
 * `stopSequences`, `promptCache`, `thinkingBudget`, `systemPrompt`, `toolChoiceForced`,
 * `structuredOutput`, and `strictToolSchema`. The remaining three — `webSearch`, `webFetch`,
 * `mcpToolset` — are decided while the tool list is expanded, where the hosted tool type names
 * and their per-type policies live (`COPILOT_CAPABILITIES.hostedTools`).
 *
 * `thinkingBudget` is resolved here and **not** in `../codex/features.ts`, and the difference
 * is the providers', not this file's. `buildCopilotResponsesBody()` (`./parse.ts`) forwards the
 * effort level canonical carries verbatim and nothing rewrites it on the way out, so the
 * outcome is fully determined by the request. On Codex the level is rewritten downstream by the
 * shared reasoning normalization, so its outcome belongs to the effort pipeline rather than to
 * a request-shaped resolver. Same feature, two owners, because the two upstreams do two
 * different things to it.
 *
 * Three rules this module keeps:
 *
 * 1. **Every policy is read from `./capabilities.ts`, never written here.** `resolve()` looks
 *    the cell up in `COPILOT_CAPABILITIES.features`; no call site names a policy, so the
 *    declaration stays the single source of truth (design decision D3).
 * 2. **Detection is "did the client ask for this", not "is this supported".** A feature absent
 *    from the request is not resolved at all, so a plain request produces zero notices whatever
 *    the matrix says.
 * 3. **`detail` says what happened to the value; `alternative` says what to do instead.** Both
 *    are prose. Neither is ever an inbound-shaped warning string — rendering belongs to
 *    `src/inbound/<provider>/notice.ts` (Requirement 9.5).
 */

/**
 * The `Canonical_Request` members the contract task has not landed yet (design §"Canonical
 * additions": `sampling`, `thinking`, `cacheHint`, `parallelToolCalls`).
 *
 * Declared optional and read defensively so this file needs **no edit** on the day canonical
 * starts carrying them: today no inbound provider builds a request with `sampling` or
 * `cacheHint`, so `sampling`, `stopSequences`, and `promptCache` resolve for nobody and emit
 * nothing. Kept local rather than pushed into `src/core/canonical.ts`: a provider directory may
 * describe what it reads, but it may not widen the canonical contract on core's behalf.
 */
interface FutureCanonicalRequestMembers {
  sampling?: {
    maxOutputTokens?: number
    temperature?: number
    topP?: number
    stopSequences?: string[]
  }
  cacheHint?: ReadonlyArray<{ scope?: string; ttl?: string }>
}

type CopilotFeatureRequestView = Canonical_Request & FutureCanonicalRequestMembers

export interface CopilotFeatureResolutionOptions {
  /**
   * Whether a reporting outcome escalates to a failed request. Passed straight through to
   * {@link FeatureDecisions}, which passes it to the one function that reads it; nothing here
   * branches on it.
   */
  strict?: boolean
}

/**
 * Resolve every matrix-covered feature this request carries, in matrix order.
 *
 * Order is `sampling → outputLength → stopSequences → thinkingBudget → promptCache →
 * systemPrompt → toolChoiceForced → structuredOutput → strictToolSchema`, matching the
 * vocabulary order of `PROVIDER_FEATURES`, which fixes both the notice sequence and which
 * rejection a client sees when two fields would each fail: `firstRejection()` is resolution
 * order, so the failure is stable for a given request.
 *
 * Resolution never stops early, so `resolvedFeatures()` stays the complete account the
 * no-silent-drop set comparison needs (Requirement 10.8).
 */
export function resolveCopilotFeatures(request: Canonical_Request, options: CopilotFeatureResolutionOptions = {}): FeatureDecisions {
  const decisions = new FeatureDecisions(COPILOT_CAPABILITIES.features, options.strict ?? false)
  const view = request as CopilotFeatureRequestView

  const sampling = requestedSamplingControls(view)
  if (sampling.length) {
    decisions.resolve(
      "sampling",
      `this endpoint takes generation controls of its own, so the requested ${joinControls(sampling)} is passed on as sent`,
      "an upstream that honors generation controls, or omit them",
    )
  }

  // Resolved whenever the client sent a limit, like `sampling` above: this cell carries no
  // notice, but resolving it records the feature in `resolvedFeatures()`, which is what the
  // no-silent-drop set comparison reads (Requirement 10.8). A field skipped because its outcome
  // is quiet would be invisible to that walk; a field recorded as covered is accounted for.
  if (requestedOutputLengthLimit(view)) {
    decisions.resolve(
      "outputLength",
      "this wire format has a field for an upper bound on reply length, so the requested limit is forwarded as stated rather than dropped at this boundary",
      "an upstream measured to enforce an output length limit, or omit it",
    )
  }

  if (requestedStopSequences(view).length) {
    decisions.resolve(
      "stopSequences",
      "this endpoint has no stop-sequence field, so generation cannot be halted on the requested strings",
      "an upstream that honors stop sequences, or truncate the reply on the client",
    )
  }

  if (request.reasoningEffort?.trim()) {
    decisions.resolve(
      "thinkingBudget",
      "this endpoint takes a reasoning level of its own, so the requested level is passed on as stated rather than mapped to something else",
      "an upstream that honors the requested reasoning level, or omit it",
    )
  }

  if (requestsPromptCache(view)) {
    decisions.resolve(
      "promptCache",
      "this endpoint caches prompt prefixes on its own schedule and takes no client cache instructions, so the requested cache points cannot be placed where they were asked for",
      "an upstream with a client-addressable prompt cache, or drop the cache hints",
    )
  }

  if (request.instructions?.trim()) {
    decisions.resolve(
      "systemPrompt",
      "this endpoint takes a separate instruction channel, so the system prompt is passed on as written instead of being folded into the conversation",
      "an upstream with a separate instruction channel, or restate the instructions in the first message",
    )
  }

  const forced = forcedToolChoice(request.toolChoice)
  if (forced) {
    decisions.resolve("toolChoiceForced", forcedToolChoiceDetail(forced), "an upstream that can force a tool call, or ask for the tool in the prompt")
  }

  if (request.textFormat) {
    decisions.resolve(
      "structuredOutput",
      "this endpoint takes a response schema of its own, so the requested shape is enforced by the model rather than described to it",
      "an upstream with native structured output, or validate the reply on the client",
    )
  }

  if (requestsStrictToolSchema(request.tools)) {
    decisions.resolve(
      "strictToolSchema",
      "tool schemas are passed on unchanged, so the keywords that make argument validation strict reach the model as written",
      "an upstream that accepts strict tool schemas, or validate tool arguments on the client",
    )
  }

  return decisions
}

/**
 * Which generation controls the client asked for, named the way a human would read them.
 *
 * Names rather than a boolean, so a reporting outcome can say *which* value was affected.
 * Unused while this cell stays native, and correct the moment it is not.
 *
 * `maxOutputTokens` is not one of these names: it is `outputLength`, its own feature with its
 * own cell, detected by {@link requestedOutputLengthLimit}.
 */
function requestedSamplingControls(request: CopilotFeatureRequestView): string[] {
  const sampling = request.sampling
  if (!sampling) return []
  return [
    typeof sampling.temperature === "number" ? "temperature" : undefined,
    typeof sampling.topP === "number" ? "top-p" : undefined,
  ].filter((name): name is string => name !== undefined)
}

/**
 * Whether the client asked for an upper bound on the reply length. A boolean, not a name:
 * there is one field, so there is nothing to disambiguate the way the sampling controls need.
 */
function requestedOutputLengthLimit(request: CopilotFeatureRequestView): boolean {
  return typeof request.sampling?.maxOutputTokens === "number"
}

function joinControls(names: readonly string[]): string {
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}

function requestedStopSequences(request: CopilotFeatureRequestView): readonly string[] {
  const stopSequences = request.sampling?.stopSequences
  return Array.isArray(stopSequences) ? stopSequences.filter((entry) => typeof entry === "string" && entry.length > 0) : []
}

function requestsPromptCache(request: CopilotFeatureRequestView): boolean {
  return Array.isArray(request.cacheHint) && request.cacheHint.length > 0
}

/**
 * The shapes of "make the model call a tool". `"none"` is deliberately absent: honoring it
 * means sending no tools, which is what an empty list already does.
 */
type ForcedToolChoice = { kind: "any" } | { kind: "named"; name: string }

function forcedToolChoice(toolChoice: Canonical_Request["toolChoice"]): ForcedToolChoice | undefined {
  if (!toolChoice) return undefined
  if (typeof toolChoice === "string") return toolChoice === "required" ? { kind: "any" } : undefined
  if (typeof toolChoice.name === "string") return { kind: "named", name: toolChoice.name }
  const nested = toolChoice.function
  if (isJsonObject(nested) && typeof nested.name === "string") return { kind: "named", name: nested.name }
  if (typeof toolChoice.type === "string" && toolChoice.type !== "function") return { kind: "named", name: toolChoice.type }
  return undefined
}

function forcedToolChoiceDetail(forced: ForcedToolChoice): string {
  if (forced.kind === "any") {
    return "this endpoint can require a tool call, so the requirement is passed on and every tool stays available"
  }
  return `this endpoint can require a named tool call, so the request for '${forced.name}' is passed on with the tool list left intact`
}

/**
 * Whether any tool asks for validation stricter than the JSON Schema default. Both signals —
 * an explicit strict flag and the keyword that closes a shape — are forwarded untouched by this
 * upstream, so a client asking for strict validation gets it.
 */
function requestsStrictToolSchema(tools: Canonical_Request["tools"]): boolean {
  return (tools ?? []).some((tool) => tool.strict === true || schemaClosesShape(tool.parameters ?? tool.input_schema))
}

/**
 * Whether a JSON schema anywhere in its tree constrains undeclared properties.
 * `additionalProperties: true` does not count: it restates the JSON Schema default.
 */
function schemaClosesShape(schema: unknown, depth = 0): boolean {
  if (depth > 16 || !schema || typeof schema !== "object") return false
  if (Array.isArray(schema)) return schema.some((entry) => schemaClosesShape(entry, depth + 1))
  const record = schema as JsonObject
  if (Object.hasOwn(record, "additionalProperties") && record.additionalProperties !== true) return true
  return Object.values(record).some((value) => schemaClosesShape(value, depth + 1))
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
