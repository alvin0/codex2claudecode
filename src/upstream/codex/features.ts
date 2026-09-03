import type { Canonical_Request } from "../../core/canonical"
import { FeatureDecisions } from "../../core/feature-decisions"
import type { JsonObject } from "../../core/types"
import { CODEX_CAPABILITIES } from "./capabilities"

/**
 * Apply the declared Codex matrix to one request.
 *
 * Role, and only this role: look at a {@link Canonical_Request}, decide which of the
 * request-shaped features this upstream covers are actually present, and hand each one to
 * {@link FeatureDecisions} with the prose that explains what happened to it. It builds no
 * payload, calls nothing, renders nothing, and reads no environment. The same shape as
 * `../kiro/features.ts`, deliberately: one file per upstream, each reading only its own
 * declaration, so a policy divergence between two upstreams is a diff between two
 * `capabilities.ts` cells rather than a branch somewhere in shared code.
 *
 * The eight resolved here are `sampling`, `outputLength`, `stopSequences`, `promptCache`,
 * `systemPrompt`, `toolChoiceForced`, `structuredOutput`, and `strictToolSchema` — the features
 * whose outcome is decided purely from the incoming request. The other four members of
 * `ProviderFeature` stay out on purpose:
 *
 * - `thinkingBudget` is decided where the effort level is decided, not here: `./effort.ts` runs
 *   the precedence ladder and `./index.ts` applies it to the request before the body is built.
 *   Resolving it here would pre-empt that decision with a second, independent one, and the notice
 *   a substitution owes the client has to name the level that was actually chosen — which only the
 *   decision knows. `../kiro/features.ts` leaves it out for the same reason.
 * - `webSearch`, `webFetch`, and `mcpToolset` are decided while the tool list is expanded,
 *   which is where the hosted-tool type names and their per-type policies live
 *   (`CODEX_CAPABILITIES.hostedTools`).
 *
 * Three rules this module keeps:
 *
 * 1. **Every policy is read from `./capabilities.ts`, never written here.** `resolve()` looks
 *    the cell up in `CODEX_CAPABILITIES.features`; no call site names a policy, so the
 *    declaration stays the single source of truth and this module needs no comparison against
 *    a policy literal (design decision D3).
 * 2. **Detection is "did the client ask for this", not "is this supported".** A feature absent
 *    from the request is not resolved at all, so a plain request produces zero notices whatever
 *    the matrix says.
 * 3. **`detail` says what happened to the value; `alternative` says what to do instead.** Both
 *    are prose. Neither is ever an inbound-shaped warning string — rendering belongs to
 *    `src/inbound/<provider>/notice.ts` (Requirement 9.5).
 *
 * ## Why this file is the whole of Requirement 10.6
 *
 * Requirement 10.6 used to be negative — a `temperature` sent to this upstream produces **zero**
 * notices — and the revised criterion says the opposite, because the measurement does.
 * `.omc/research/kiro-wire-spike.md` §11.2 sent `temperature`, `top_p`, and
 * `max_output_tokens` one per run and got `400 Unsupported parameter` for each, so the
 * `sampling` and `outputLength` cells of `CODEX_CAPABILITIES` are `degrade` (§11.5): the field
 * is dropped on the way out and the client is told.
 *
 * The mechanism that satisfies it is the same one that used to satisfy the negative reading,
 * unchanged. Both features are resolved unconditionally-when-present, and
 * `resolveFeature()` in `src/core/feature-policy.ts` builds exactly one notice for a
 * reporting outcome and none for a native one. So flipping the cell was the whole behavioral
 * change: resolution records the feature in `resolvedFeatures()` either way, which is what the
 * no-silent-drop set comparison reads, and the notice list follows the declaration. What this
 * file must own instead is the **wording** — the `detail` of a `degrade` is the only place a
 * client learns that the value it sent was not sent on, so the prose below says which control
 * was affected and what happened to it, not merely that something did.
 */

/**
 * `sampling` and `cacheHint` are read straight off {@link Canonical_Request} now.
 *
 * They used to be declared here as a local forward-compatible view, because canonical carried
 * neither member and the inbound providers dropped both at their own boundary — an upstream
 * notice about a field no upstream could see would have been fiction. The contract task landed
 * them (design §"Canonical additions") and task 14 wired the inbound mappers, so the
 * speculative view is gone: one shape, owned by core, is what the resolutions below key off.
 * Keeping the local declaration would let core's shape and this file's idea of it drift apart
 * silently — it had already drifted on `cacheHint`, whose scope is a fixed union in core and
 * was an open `string` here — which is the one failure mode the view was never able to catch.
 * `../kiro/features.ts` and `../copilot/features.ts` dropped theirs for the same reason.
 */
export interface CodexFeatureResolutionOptions {
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
 * Order is `sampling → outputLength → stopSequences → promptCache → systemPrompt →
 * toolChoiceForced → structuredOutput → strictToolSchema`, matching the vocabulary order of
 * `PROVIDER_FEATURES`, which fixes both the notice sequence and which rejection a client sees
 * when two fields would each fail: `firstRejection()` is resolution order, so the 400 is stable
 * for a given request instead of depending on evaluation accidents.
 *
 * Resolution never stops early. Even on a request that would end in a 400, every present
 * feature is still resolved, so `resolvedFeatures()` stays the complete account the
 * no-silent-drop set comparison needs (Requirement 10.8).
 */
export function resolveCodexFeatures(request: Canonical_Request, options: CodexFeatureResolutionOptions = {}): FeatureDecisions {
  const decisions = new FeatureDecisions(CODEX_CAPABILITIES.features, options.strict ?? false)

  const sampling = requestedSamplingControls(request)
  if (sampling.length) {
    decisions.resolve(
      "sampling",
      `this endpoint refuses generation controls outright, so the requested ${joinControls(sampling)} was left off the request and the model sampled with its own defaults instead`,
      "an upstream that honors generation controls, or omit them",
    )
  }

  // Resolved whenever the client sent a limit, exactly like `sampling` above: resolving records
  // the feature in `resolvedFeatures()`, which is what the no-silent-drop set comparison reads
  // (Requirement 10.8), and the notice follows from the declared cell rather than from anything
  // decided here. The limit named in the detail is the client's own number, because on the Claude
  // route `max_tokens` is mandatory — so this notice reaches every Claude→Codex request, and a
  // client reading it needs to see which value went missing.
  const limit = requestedOutputLengthLimit(request)
  if (limit !== undefined) {
    decisions.resolve(
      "outputLength",
      `this endpoint refuses an output-length parameter outright, so the requested limit of ${limit} was left off the request and the reply is not capped at it`,
      "an upstream that honors an output length limit, or omit it",
    )
  }

  if (requestedStopSequences(request).length) {
    decisions.resolve(
      "stopSequences",
      "this endpoint has no stop-sequence field, so generation cannot be halted on the requested strings",
      "an upstream that honors stop sequences, or truncate the reply on the client",
    )
  }

  if (requestsPromptCache(request)) {
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
 * Names rather than a boolean, so a reporting outcome can say *which* value was affected:
 * "temperature" and "temperature and top-p" are different facts, and a client tuning one knob
 * should not have to guess whether the report is about the other. Written while the cell was
 * `native` and unused; load-bearing now that spike §11.2 made the cell `degrade`.
 *
 * `maxOutputTokens` is not one of these names: it is `outputLength`, its own feature with its
 * own cell, detected by {@link requestedOutputLengthLimit}. The split is a vocabulary decision
 * made in core and followed here, not a Codex-specific one — the two features happen to share a
 * policy on this upstream and do not on every upstream.
 */
function requestedSamplingControls(request: Canonical_Request): string[] {
  const sampling = request.sampling
  if (!sampling) return []
  return [
    typeof sampling.temperature === "number" ? "temperature" : undefined,
    typeof sampling.topP === "number" ? "top-p" : undefined,
  ].filter((name): name is string => name !== undefined)
}

/**
 * The upper bound on reply length the client asked for, or `undefined` if it asked for none.
 *
 * The value rather than a boolean, because the cell is `degrade` (spike §11.2) and the notice has
 * to name the number that went missing. `undefined` rather than a falsy check is what keeps
 * `maxOutputTokens: 0` — a nonsense limit, and still a limit the client sent — a resolution
 * instead of an absence.
 */
function requestedOutputLengthLimit(request: Canonical_Request): number | undefined {
  const limit = request.sampling?.maxOutputTokens
  return typeof limit === "number" ? limit : undefined
}

function joinControls(names: readonly string[]): string {
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}

function requestedStopSequences(request: Canonical_Request): readonly string[] {
  const stopSequences = request.sampling?.stopSequences
  return Array.isArray(stopSequences) ? stopSequences.filter((entry) => typeof entry === "string" && entry.length > 0) : []
}

function requestsPromptCache(request: Canonical_Request): boolean {
  return Array.isArray(request.cacheHint) && request.cacheHint.length > 0
}

/**
 * The shapes of "make the model call a tool".
 *
 * `any` is the client asking for some tool call without naming one; `named` points at a single
 * tool, whichever of the three spellings the client used. `"none"` is deliberately absent:
 * honoring it means sending no tools, which is what an empty list already does, so the
 * client's intent survives and there is nothing to record.
 *
 * Detection is shared with `../kiro/features.ts` in shape but not in code, because the two
 * upstreams disagree on the outcome: this one forwards the choice, Kiro narrows the tool list
 * instead. Sharing the detector would invite sharing the wording, and the wording is the part
 * that must stay per-upstream.
 */
type ForcedToolChoice = { kind: "any" } | { kind: "named"; name: string }

function forcedToolChoice(toolChoice: Canonical_Request["toolChoice"]): ForcedToolChoice | undefined {
  if (!toolChoice) return undefined
  if (typeof toolChoice === "string") return toolChoice === "required" ? { kind: "any" } : undefined
  if (typeof toolChoice.name === "string") return { kind: "named", name: toolChoice.name }
  const nested = toolChoice.function
  if (isJsonObject(nested) && typeof nested.name === "string") return { kind: "named", name: nested.name }
  // A hosted-tool choice such as a search tool names one tool as directly as a function choice.
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
 * Whether any tool asks for validation stricter than the JSON Schema default.
 *
 * Two signals, both forwarded untouched by this upstream: an explicit strict flag, and the
 * schema keyword that closes a shape to undeclared properties. Either one means the client
 * asked for a stricter contract, and on this upstream it gets one — which is why the cell is
 * native here and not on every upstream.
 */
function requestsStrictToolSchema(tools: Canonical_Request["tools"]): boolean {
  return (tools ?? []).some((tool) => tool.strict === true || schemaClosesShape(tool.parameters ?? tool.input_schema))
}

/**
 * Whether a JSON schema anywhere in its tree constrains undeclared properties.
 *
 * `additionalProperties: true` does not count: it restates the JSON Schema default, so a
 * request carrying it asked for nothing stricter. Recurses because the keyword is meaningful
 * at any depth, and a nested schema carrying it is as much a strictness request as a top-level
 * one.
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
