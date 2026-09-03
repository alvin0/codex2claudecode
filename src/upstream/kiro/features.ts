import type { Canonical_Request } from "../../core/canonical"
import { FeatureDecisions } from "../../core/feature-decisions"
import type { JsonObject } from "../../core/types"
import { KIRO_CAPABILITIES } from "./capabilities"

/**
 * Apply the declared Kiro matrix to one request.
 *
 * Role, and only this role: look at a {@link Canonical_Request}, decide which of the seven
 * request-shaped features this upstream covers are actually present, and hand each one to
 * {@link FeatureDecisions} together with the prose that explains what happened to it. It
 * builds no payload, calls nothing, renders nothing, and reads no environment.
 *
 * The seven are `sampling`, `outputLength`, `stopSequences`, `promptCache`, `toolChoiceForced`,
 * `structuredOutput`, and `strictToolSchema` — the features whose outcome is decided purely
 * from the incoming request. The remaining five members of `ProviderFeature` are decided
 * elsewhere and stay out of this file on purpose: `systemPrompt` is unconditional emulation
 * inside `embedInstructions()` (`./payload.ts`), `thinkingBudget` is settled by the effort
 * resolver (task 22), and `webSearch` / `webFetch` / `mcpToolset` are decided while the tool
 * list is expanded, after their flags are read.
 *
 * Three rules this module keeps:
 *
 * 1. **Every policy is read from `./capabilities.ts`, never written here.** `resolve()` looks
 *    the cell up in `KIRO_CAPABILITIES.features`; no call site names a policy, so the
 *    declaration stays the single source of truth and no module under `src/upstream/` outside
 *    `capabilities.ts` compares against a policy literal at all (design decision D3).
 * 2. **Detection is "did the client ask for this", not "is this supported".** A feature absent
 *    from the request is not resolved at all, so a plain request produces zero notices whatever
 *    the matrix says. That is what keeps the notice list proportional to what was actually
 *    dropped rather than a recital of the matrix.
 * 3. **`detail` says what happened to the value; `alternative` says what to do instead.** Both
 *    are prose. Neither is ever an inbound-shaped warning string — rendering belongs to
 *    `src/inbound/<provider>/notice.ts` (Requirement 9.5).
 */

/**
 * The `Canonical_Request` members the contract task (design §"Canonical additions": `sampling`,
 * `thinking`, `cacheHint`, `parallelToolCalls`) has not landed yet.
 *
 * Declared here as optional and read defensively so this file needs **no edit** on the day
 * canonical starts carrying them: today `sampling` and `cacheHint` are absent from every
 * request the inbound providers build, so `sampling`, `stopSequences`, and `promptCache`
 * resolve for nobody and emit nothing. That is honest rather than convenient — those fields
 * are currently dropped at the *inbound* boundary, before any upstream sees them, so an
 * upstream notice claiming otherwise would be fiction. The moment `claudeToCanonicalRequest()`
 * spreads its sampling mapper in, the three resolutions below start firing with no change here.
 *
 * Kept local rather than pushed into `src/core/canonical.ts`: a provider directory may describe
 * what it reads, but it may not widen the canonical contract on core's behalf.
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

type KiroFeatureRequestView = Canonical_Request & FutureCanonicalRequestMembers

export interface KiroFeatureResolutionOptions {
  /**
   * Whether `degrade` escalates to `reject`. Passed straight through to
   * {@link FeatureDecisions}, which passes it to the one function that reads it; nothing here
   * branches on it.
   */
  strict?: boolean
}

/**
 * Resolve every matrix-covered feature this request carries, in matrix order.
 *
 * Order is `sampling → outputLength → stopSequences → promptCache → toolChoiceForced →
 * structuredOutput → strictToolSchema`, matching the vocabulary order of `PROVIDER_FEATURES`,
 * which fixes both the notice sequence and which rejection a client sees when two fields would
 * each fail: `firstRejection()` is resolution order, so the 400 is stable for a given request
 * instead of depending on evaluation accidents.
 *
 * Resolution never stops early. Even on a request that will end in a 400, every present
 * feature is still resolved, so `resolvedFeatures()` stays the complete account the
 * no-silent-drop set comparison needs (Requirement 10.8).
 */
export function resolveKiroFeatures(request: Canonical_Request, options: KiroFeatureResolutionOptions = {}): FeatureDecisions {
  const decisions = new FeatureDecisions(KIRO_CAPABILITIES.features, options.strict ?? false)
  const view = request as KiroFeatureRequestView

  const sampling = requestedSamplingControls(view)
  if (sampling.length) {
    decisions.resolve(
      "sampling",
      `this endpoint exposes no generation controls, so the requested ${joinControls(sampling)} cannot reach the model — there is nothing here to carry the value, and an invented carrier would be answered with a 200 and discarded, which reads as honored while changing nothing`,
      "an upstream that honors generation controls, or omit them",
    )
  }

  // Its own feature rather than a third name inside the `sampling` text, because this endpoint
  // treats it differently from `temperature` / `topP`: the limit is taken and then disregarded
  // instead of having nowhere to go at all. The two policies therefore differ, and a policy
  // difference belongs in `./capabilities.ts` (design decision D3), not in a detection helper.
  if (requestedOutputLengthLimit(view)) {
    decisions.resolve(
      "outputLength",
      "this endpoint accepts an output length limit and then disregards it — a limit of a handful of tokens was measured answering 200 and still streaming a full-length essay — so the limit is left off the request rather than sent to be ignored, and the reply may run well past the length that was asked for",
      "an upstream that enforces an output length limit, or stop reading the reply on the client once it is long enough",
    )
  }

  if (requestedStopSequences(view).length) {
    decisions.resolve(
      "stopSequences",
      "this endpoint has no stop-sequence field, so generation cannot be halted on the requested strings",
      "an upstream that honors stop sequences, or truncate the reply on the client",
    )
  }

  if (requestsPromptCache(view)) {
    decisions.resolve(
      "promptCache",
      "this endpoint exposes no prompt cache: reusing a conversation reduced no spend and reported no cached-input counter, so the requested cache hints cannot be applied",
      "an upstream with a prompt cache, or drop the cache hints",
    )
  }

  const forced = forcedToolChoice(request.toolChoice)
  if (forced) {
    decisions.resolve("toolChoiceForced", forcedToolChoiceDetail(forced), "an upstream that can force a tool call, or ask for the tool in the prompt")
  }

  if (request.textFormat) {
    decisions.resolve(
      "structuredOutput",
      "this endpoint has no response-format field, so the requested schema is embedded in the prompt and the model is asked to answer with matching JSON — the shape is instructed, not enforced",
      "an upstream with native structured output, or validate the reply on the client",
    )
  }

  if (requestsStrictToolSchema(request.tools)) {
    decisions.resolve(
      "strictToolSchema",
      "tool schemas are sanitized before they are sent and the keywords that make validation strict are removed, so arguments outside the declared shape are not refused upstream",
      "an upstream that accepts strict tool schemas, or validate tool arguments on the client",
    )
  }

  return decisions
}

/**
 * Which generation controls the client asked for, named the way a human would read them.
 *
 * Returns names rather than a boolean so the notice can say *which* value went nowhere:
 * "temperature" and "temperature and top-p" are different facts, and a client tuning one knob
 * should not have to guess whether the report is about the other.
 *
 * `maxOutputTokens` is deliberately **not** one of these names. It is `outputLength`, resolved
 * on its own below, so the outcome this list feeds covers only the two controls that have
 * nowhere at all to go on this endpoint.
 */
function requestedSamplingControls(request: KiroFeatureRequestView): string[] {
  const sampling = request.sampling
  if (!sampling) return []
  return [
    typeof sampling.temperature === "number" ? "temperature" : undefined,
    typeof sampling.topP === "number" ? "top-p" : undefined,
  ].filter((name): name is string => name !== undefined)
}

/**
 * Whether the client asked for an upper bound on the reply length.
 *
 * A boolean, not a name: there is one field, so there is nothing to disambiguate the way the
 * sampling controls need. The number itself stays out of the notice text — a client that sent
 * it already knows what it sent, and quoting it back would make the prose vary per request for
 * no gain in what the client learns.
 */
function requestedOutputLengthLimit(request: KiroFeatureRequestView): boolean {
  return typeof request.sampling?.maxOutputTokens === "number"
}

function joinControls(names: readonly string[]): string {
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}

function requestedStopSequences(request: KiroFeatureRequestView): readonly string[] {
  const stopSequences = request.sampling?.stopSequences
  return Array.isArray(stopSequences) ? stopSequences.filter((entry) => typeof entry === "string" && entry.length > 0) : []
}

function requestsPromptCache(request: KiroFeatureRequestView): boolean {
  return Array.isArray(request.cacheHint) && request.cacheHint.length > 0
}

/**
 * The shapes of "make the model call a tool", as `computeEffectiveTools()` (`./index.ts`) sees
 * them.
 *
 * `any` is `tool_choice: "required"` — every tool stays available and the model is *asked* to
 * pick one. `named` is any choice that points at a single tool, whichever of the three
 * spellings the client used; the tool list is narrowed to that one tool.
 *
 * `"none"` is deliberately not here: honoring it means sending no tools, and sending no tools
 * is exactly what this endpoint does with an empty list — the client's intent survives, so
 * there is nothing to report.
 */
type ForcedToolChoice = { kind: "any" } | { kind: "named"; name: string }

function forcedToolChoice(toolChoice: Canonical_Request["toolChoice"]): ForcedToolChoice | undefined {
  if (!toolChoice) return undefined
  if (typeof toolChoice === "string") return toolChoice === "required" ? { kind: "any" } : undefined
  if (typeof toolChoice.name === "string") return { kind: "named", name: toolChoice.name }
  const nested = toolChoice.function
  if (isJsonObject(nested) && typeof nested.name === "string") return { kind: "named", name: nested.name }
  // A hosted-tool choice such as `{ type: "web_search" }` names one tool just as directly as a
  // function choice does, and is narrowed the same way.
  if (typeof toolChoice.type === "string" && toolChoice.type !== "function") return { kind: "named", name: toolChoice.type }
  return undefined
}

/**
 * What the request got instead of a forced call. Two different degradations, so two texts —
 * a client told "the tool list was narrowed" when in fact nothing was narrowed would be
 * misinformed rather than informed.
 */
function forcedToolChoiceDetail(forced: ForcedToolChoice): string {
  if (forced.kind === "any") {
    return "this endpoint cannot require a tool call, so every tool stayed available and the model may still answer with text instead of calling one"
  }
  return `this endpoint cannot require a tool call, so the available tools were narrowed to '${forced.name}' to steer the model toward it — the model may still answer with text instead`
}

/**
 * Whether any tool asks for validation this upstream cannot pass on.
 *
 * Two signals, both erased on the way to the wire: an explicit `strict` flag, which
 * `convertTool()` (`./payload.ts`) never forwards, and the schema keyword that closes a shape
 * to undeclared properties, which `sanitizeToolSchema()` strips at every depth. Either one
 * means the client asked for a stricter contract than the model is given.
 */
function requestsStrictToolSchema(tools: Canonical_Request["tools"]): boolean {
  return (tools ?? []).some((tool) => tool.strict === true || schemaClosesShape(tool.parameters ?? tool.input_schema))
}

/**
 * Whether a JSON schema anywhere in its tree constrains undeclared properties.
 *
 * `additionalProperties: false` and a subschema value both narrow what the arguments may
 * contain, and `sanitizeToolSchema()` strips either one, so either is a real loss.
 * `additionalProperties: true` is not: it restates the JSON Schema default, so removing it
 * changes nothing and reporting it would be a notice about a non-event.
 *
 * Recurses because the stripping is recursive: a nested object schema carrying the keyword
 * loses it just as a top-level one does, so checking only the top level would miss the change.
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
