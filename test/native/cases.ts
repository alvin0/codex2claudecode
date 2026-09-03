// Role: the single registry of the 14 live cases (Requirement 24.1). Nothing else declares
// a case; the live test, the transcript writer, and the matrix walk all read this table.
//
// Every assertion is structural. Where a requirement leaves the declared policy of a cell
// open (Kiro sampling reads as `reject` in Requirement 2.3 and as degrade-plus-notice in
// Requirement 11.5), the case asserts the fact both readings share: the outcome is declared
// and observable, never a silent 200. That is the defect this feature exists to fix.
import type { JsonObject } from "../../src/core/types"

import {
  expectBlockType,
  expectBytesMatchDirectCallModuloVolatileFields,
  expectClientBytesEqualCapturedUpstreamBytes,
  expectDeclaredOutcome,
  expectErrorMentions,
  expectEventType,
  expectNoSynthesizedClientToolCalls,
  expectNoticeMentions,
  expectServerToolCount,
  expectServerToolResultsArePaired,
  expectStatus,
  expectUpstreamEffortIn,
  expectUpstreamEffortPresent,
  expectUpstreamPayloadOmits,
} from "./assertions"
import type { NativeLiveCase } from "./types"

/** The 14 case ids, in plan order. A rename fails the harness property test loudly. */
export const NATIVE_LIVE_CASE_IDS = [
  "sampling-declared",
  // Renamed from `sampling-native` while closing task 15: `.omc/research/kiro-wire-spike.md`
  // §11.2 measured the Codex `sampling` cell to be `degrade`, and an id is the first thing a
  // reader trusts. Fourteen ids, none repeated — Property 35 enforces both.
  "sampling-degrade",
  "effort-default",
  "effort-degrade",
  "thinking-budget",
  "passthrough-bytes",
  "passthrough-off",
  "messages-no-passthrough",
  "web-search-native",
  "web-search-no-heuristic",
  "web-fetch-emulate",
  "mcp-toolset-kiro",
  "mcp-approval-reject",
  "no-silent-drop",
] as const

export type NativeLiveCaseId = (typeof NATIVE_LIVE_CASE_IDS)[number]

/**
 * Substituted with the loopback MCP fixture's URL at run time. Kept as a visible token so a
 * transcript shows what the registry declared and what the run actually sent.
 */
export const NATIVE_MCP_SERVER_URL_PLACEHOLDER = "{{MCP_SERVER_URL}}"

export const NATIVE_MCP_SERVER_NAME = "native-fixture"

/** Models are overridable because provider catalogs move; both default to a cheap model. */
/**
 * The Kiro model id, **measured** not guessed, and chosen for one property no other candidate on
 * this account has: it publishes an effort enum on the wire.
 *
 * `bun scripts/kiro-models-probe.ts` (one free `GET /ListAvailableModels`, zero credits) with
 * `KIRO_MODELS_PROBE_MODEL=claude-sonnet-5` read this account's catalog and printed the entry
 * verbatim. `claude-sonnet-5` carries
 *
 * ```json
 * "additionalModelRequestFieldsSchema": { "properties": { "output_config": { "properties": {
 *   "effort": { "type": "string", "enum": ["low","medium","high","xhigh","max"], "default": "high" }
 * } } } }
 * ```
 *
 * so the shipped registry parses it as `{ schemaPath: "output_config", levels: [low, medium, high,
 * xhigh, max], defaultLevel: "high", provenance: "live" }`. Three facts follow, and they are the
 * reason for the move:
 *
 * - **`provenance: "live"`.** The endpoint said this, so no bundled assumption is involved and
 *   `effortSchemaDisclosure` is `answered` with a real schema rather than the `null` denial.
 * - **A `defaultLevel` exists.** The previous default, `claude-sonnet-4.5`, publishes
 *   `additionalModelRequestFieldsSchema: null` — a denial — so after the static-fallback narrowing
 *   it gets **no** descriptor at all and every effort case lands on `effort_unsupported`, which is
 *   the branch none of the three effort cases describes (RR23/RR25/RR27/RR29 measured exactly that).
 * - **`schemaPath: "output_config"`.** Same path as before, so `additionalModelRequestFields()`
 *   emits the same shape; this is a Sonnet-class Claude model, not a wire-shape change.
 *
 * Reversible: set `NATIVE_KIRO_MODEL` to go back to `claude-sonnet-4.5` (or any other entry) without
 * touching this file.
 *
 * **This edit is not standalone.** `KIRO_EFFORT_LEVELS` and `KIRO_OUT_OF_ENUM_EFFORT` below move
 * with it, and the reason is written there: this model's enum *contains* the old out-of-enum value.
 */
export const NATIVE_KIRO_MODEL = process.env.NATIVE_KIRO_MODEL ?? "claude-sonnet-5"
/**
 * The Codex model id, **measured** not guessed: `bun scripts/codex-models-probe.ts` (a free GET
 * against `CODEX_MODELS_ENDPOINT`) lists what this account is actually served, and the entry whose
 * `display_name` is `GPT-5.3-Codex-Spark` carries `slug: "gpt-5.3-codex-spark"`. The display name
 * is not the id, so the id comes from the slug.
 *
 * Why the default moved off `gpt-5.4-mini_low`: the account this harness runs against may no longer
 * be allowed to spend on that model, and a live case that dies on model availability measures
 * nothing about the feature it was written for. The probe still lists `gpt-5.4-mini`, so this is a
 * permission change on our side rather than a catalog removal — set `NATIVE_CODEX_MODEL` to go back.
 *
 * The `_low` suffix is kept deliberately. It is coverage, not decoration: `normalizeReasoningModel()`
 * strips it, `gpt-5.3-codex-spark_low` still matches `REASONING_MODEL_PATTERN`
 * (`\.[^_]+` swallows `.3-codex-spark`), and Run_Record 22 measured the suffix reaching the wire
 * intact on `messages-no-passthrough`. Dropping the suffix would silently drop that observation.
 */
export const NATIVE_CODEX_MODEL = process.env.NATIVE_CODEX_MODEL ?? "gpt-5.3-codex-spark_low"

/**
 * The effort enum `NATIVE_KIRO_MODEL` publishes, **measured from the wire** rather than read off
 * `kiro-models.json`: `bun scripts/kiro-models-probe.ts` with
 * `KIRO_MODELS_PROBE_MODEL=claude-sonnet-5` printed
 * `$.properties.output_config.properties.effort.enum = ["low","medium","high","xhigh","max"]`
 * verbatim, with `default: "high"`.
 *
 * It gained `max` when the model moved from `claude-sonnet-4.5` (whose enum came from the bundled
 * static catalog, `[low, medium, high, xhigh]`) to `claude-sonnet-5` (whose enum the endpoint
 * publishes). This edit is **forced** by that move, not cosmetic: `expectUpstreamEffortIn()` checks
 * the level on the upstream payload against this list, and `effort-degrade`'s nearest substitution
 * lands on the model's strongest level — `max` — which would fail `upstream-effort-in-…` if the list
 * still stopped at `xhigh`.
 *
 * Reversible: it tracks whatever `NATIVE_KIRO_MODEL` publishes, so overriding the model means
 * re-reading the enum from the probe for that model.
 */
export const KIRO_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const

/**
 * The effort value the `effort-degrade` case requests. Held as a named constant so the case's
 * out-of-enum-ness is a **construction**, not a coincidence: `harness.test.ts` asserts this value
 * is absent from `KIRO_EFFORT_LEVELS`, so whichever descriptor source ends up feeding the enum,
 * the case keeps requesting something the enum does not contain. No edit here is needed when the
 * enum source changes.
 *
 * **Why it is no longer `"max"`, and why this edit is forced too.** Every Kiro model on this account
 * that publishes an effort enum publishes `max` as its top level — measured across all ten
 * enum-publishing entries in the probe output, `[low, medium, high, xhigh, max]` or
 * `[low, medium, high, max]` or `[none, low, medium, high, xhigh, max]`. So the moment
 * `NATIVE_KIRO_MODEL` became an enum-publishing model, `"max"` stopped being out-of-enum and
 * `effort-degrade` would have asserted nothing at all: `validateKiroEffort()` would return
 * `{ ok: true }`, no substitution would happen, and `notice-mentions-max` would pass only by
 * accident of the requested value appearing in some other notice. The lock in `harness.test.ts`
 * (`KIRO_OUT_OF_ENUM_EFFORT ∉ KIRO_EFFORT_LEVELS`) exists precisely to make that failure loud.
 *
 * `"ultra"` is chosen because it is already the out-of-enum value the offline unit tests use
 * (`test/upstream/kiro/` — effort `"ultra"` on a model with enum `[low..max]` substitutes `max`),
 * and `nearestEnumLevel()` maps it to the model's strongest published level, so the substituted
 * value is `max`: in-enum, and the one level a client could not have reached by stating it here.
 * Reversible: any string outside `KIRO_EFFORT_LEVELS` works.
 */
export const KIRO_OUT_OF_ENUM_EFFORT = "ultra"

/**
 * The state each Live_Case is **measured** to hold, used by the live gate's clause "every other
 * Live_Case holds the exact state recorded at task start".
 *
 * This is not `NativeLiveCase.baseline`. That field records the *pre-implementation* baseline that
 * Requirements 24.5 and 24.6 name case by case, and it stays as written. This table records
 * something else: the hold-state the gates of tasks 19b, 20, 21, 22 and later are read against.
 *
 * **Why it is rebaselined here.** Those gates were inheriting Run_Record 20's `5 green / 9 red`.
 * That snapshot is stale: two independent live runs — RR22–RR25, then RR26–RR29 after the Codex
 * model moved to `gpt-5.3-codex-spark_low` — both measured `9 green / 5 red`, with **zero flips
 * between them** by colour and by failing-assertion name. A set that reproduces across a model
 * change is a baseline; a single snapshot is not.
 *
 * **Rebaselined a second time, to `10 green / 4 red`, on Run_Record 30.** `passthrough-bytes` flipped
 * red → green there, `3 / 0` — both halves of Requirement 29.3, the exact byte comparison and the
 * frame-for-frame one — and the gate that owned that flip, 19.3, **passed**. So the flip is a
 * measured, owned state change and not inherited progress from a later task, which is what
 * distinguishes it from the four early greens below: it needs no entry in
 * `NATIVE_EARLY_GREEN_OWNING_TASK`, because its gate has already been read and satisfied. RR30 item 3
 * recorded the edit and stopped there, since a Run_Record does not grant itself the right to
 * rebaseline; this is the reader's decision, taken with RR30 as its reason.
 *
 * **Why the four cases below are green early, named with the task that turned them green.** Their
 * implementing code landed in the working tree ahead of their own gates, so they were already green
 * when the effort gates were read (RR22's case table records each flip):
 *
 * - `web-search-no-heuristic` — task 27 (M19, intent heuristics behind a flag).
 * - `web-fetch-emulate` — task 28 (M20, `web_fetch` emulation; `src/upstream/kiro/web-fetch.ts`).
 * - `mcp-toolset-kiro` — task 35 (M23, MCP toolset).
 * - `mcp-approval-reject` — task 36 (M25, `require_approval: always` rejected).
 *
 * **The point of the rebaseline.** A gate's hold-state clause exists to measure *that gate's own
 * effect* — that the diff under test moved its target case and nothing else. Against a stale
 * snapshot the clause instead re-reports unrelated progress from four later tasks, so it fails for
 * a reason the task under test cannot fix and cannot be fixed by the task under test. Rebaselining
 * makes the clause measure its own effect again. It is not a relaxation: the clause still demands
 * an exact match on all fourteen cases, and the four early greens still owe their own gates a
 * target flip — those gates must read them as *already green at their start*, not as their flip.
 *
 * **Rebaselined a third time, to `13 green / 1 red`, on Run_Record 52.** Four cases changed colour
 * against the previous snapshot and every one of them is an owned, measured flip whose gate passed
 * in the same reading:
 *
 * - `effort-default` red → green, `3 / 0` — gate 20.4, RR48 then RR53.
 * - `effort-degrade` red → green, `3 / 0` — gate 22.4, RR49 then RR54.
 * - `thinking-budget` red → green, `3 / 0` — gate 23.4, RR50 then RR55.
 * - `passthrough-bytes` back to green, `3 / 0` — RR47 measured it red twice on
 *   `usage.attribution.items[<id>].output_tokens` with *different numbers each run* (28/19 then
 *   23/16 at the same offset 5510), diagnosed it as per-call generation non-determinism rather than
 *   a transform, and declined to patch it. RR52 narrowed `passthroughByteDiff()` to normalize
 *   numeric counters inside a `usage` subtree only — see the RR47 note in
 *   `test/native/byte-diff.ts` for what that buys and what it gives up — and the case measures
 *   `3 / 0` again.
 *
 * `no-silent-drop` stays red, same two failing assertions since RR15; its gaps belong to the
 * task-14b family and no gate here claims it. Same reasoning as the two rebaselines above: a stale
 * snapshot makes the clause re-report progress the task under test cannot affect, so it stops
 * measuring the gate's own effect. Still not a relaxation — the clause remains an exact match over
 * all fourteen cases.
 *
 * **Rebaselined a fourth time, to `14 green / 0 red`, on Run_Record 57.** `no-silent-drop` flipped
 * red → green, `4 / 0`, at gate 14b.10 — the gate that owns it — closing the two gaps that held its
 * `declared-outcome-stopSequences` and `declared-outcome-thinkingBudget` assertions red for twelve
 * runs (RR15 → RR56): the 400 now comes from `FeatureDecisions.rejectionReport()`, so it names
 * `stopSequences` as well as `sampling`, and Kiro decides the deferred `thinkingBudget` outcome
 * before that report is built, so the mapped budget rides the notice list of a rejected request.
 * An owned, measured flip whose gate passed in the same reading, exactly like `passthrough-bytes`
 * at RR30 — so no entry in `NATIVE_EARLY_GREEN_OWNING_TASK` is owed.
 *
 * This is the tightest the table can be: `nativeGateHoldStateCaseIds("red")` is now **empty**, so a
 * gate's hold-state clause demands green on all fourteen and any red anywhere is a failure with
 * nothing left to inherit. `nativeBaselineCaseIds()` — the pre-implementation snapshot Requirements
 * 24.5 and 24.6 fix — is untouched, and so is `NATIVE_EARLY_GREEN_OWNING_TASK`.
 */
export const NATIVE_LIVE_GATE_HOLD_STATE: Readonly<Record<NativeLiveCaseId, "green" | "red">> = {
  "sampling-declared": "green",
  "sampling-degrade": "green",
  // The three effort cases flipped red → green across gates 20.4 / 22.4 / 23.4, measured in RR48–RR50
  // and held in RR52. See the table comment.
  "effort-default": "green",
  "effort-degrade": "green",
  "thinking-budget": "green",
  // Flipped red → green at gate 19.3, measured in Run_Record 30 (`3 / 0`); red in RR47 on per-call
  // usage-counter non-determinism, green again in RR52 after the counter narrowing. See the comment.
  "passthrough-bytes": "green",
  "passthrough-off": "green",
  "messages-no-passthrough": "green",
  "web-search-native": "green",
  "web-search-no-heuristic": "green",
  "web-fetch-emulate": "green",
  "mcp-toolset-kiro": "green",
  "mcp-approval-reject": "green",
  // Flipped red → green at gate 14b.10, measured in Run_Record 57 (`4 / 0`), closing the last red
  // case of the set. See the table comment for the two gaps that closed.
  "no-silent-drop": "green",
}

/** The task that turned each early-green case green, ahead of that case's own live gate. */
export const NATIVE_EARLY_GREEN_OWNING_TASK: Readonly<Record<string, string>> = {
  "web-search-no-heuristic": "27",
  "web-fetch-emulate": "28",
  "mcp-toolset-kiro": "35",
  "mcp-approval-reject": "36",
}

/** Case ids the live gate expects to hold `state` (rebaselined; see the table's comment). */
export function nativeGateHoldStateCaseIds(state: "green" | "red") {
  return NATIVE_LIVE_CASE_IDS.filter((id) => NATIVE_LIVE_GATE_HOLD_STATE[id] === state)
}

const OK_PROMPT = "Reply with exactly: ok"

function messages(body: JsonObject = {}, prompt = OK_PROMPT): JsonObject {
  return {
    model: NATIVE_KIRO_MODEL,
    max_tokens: 256,
    stream: false,
    messages: [{ role: "user", content: prompt }],
    ...body,
  }
}

/**
 * Codex `/v1/responses` refuses a non-streaming request outright — measured in Run_Record 1 as
 * `400 {"detail":"Stream must be set to true"}` — so the default here is `stream: true`. A case
 * that genuinely needs the non-streaming path must set it explicitly and expect that 400.
 */
function responses(body: JsonObject = {}, prompt = OK_PROMPT): JsonObject {
  return {
    model: NATIVE_CODEX_MODEL,
    stream: true,
    input: prompt,
    ...body,
  }
}

function clientWebTools(): JsonObject[] {
  return [
    {
      name: "WebSearch",
      description: "Search the web for a query.",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    {
      name: "WebFetch",
      description: "Fetch a URL and summarize it.",
      input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  ]
}

function mcpToolsetBody(requireApproval: "always" | "never"): JsonObject {
  return messages(
    {
      mcp_servers: [{ name: NATIVE_MCP_SERVER_NAME, type: "url", url: NATIVE_MCP_SERVER_URL_PLACEHOLDER }],
      tools: [
        {
          type: "mcp_toolset",
          mcp_server_name: NATIVE_MCP_SERVER_NAME,
          require_approval: requireApproval,
        },
      ],
    },
    "Call the fixture echo tool with the text ping, then reply with its result.",
  )
}

export const NATIVE_LIVE_CASES: readonly NativeLiveCase[] = [
  {
    id: "sampling-declared",
    title: "Kiro sampling resolves to its declared policy instead of being dropped",
    upstream: "kiro",
    route: "/v1/messages",
    body: messages({ temperature: 0.2, top_p: 0.9 }),
    flags: {},
    baseline: "red",
    assertions: [
      expectDeclaredOutcome("sampling", ["temperature", "top_p"]),
      // Measured: Kiro ignores inferenceConfig, so the payload must not carry it (Requirement 3.5).
      expectUpstreamPayloadOmits("inferenceConfig", "maxTokens"),
    ],
  },
  {
    id: "sampling-degrade",
    title: "Codex sampling is dropped and reported, not honored and not refused",
    upstream: "codex",
    route: "/v1/responses",
    // `stream: true` because the upstream requires it (see `responses()`); the case's claim is
    // about the declared sampling outcome, not about the non-streaming path.
    body: responses({ stream: true, temperature: 0.2, top_p: 0.9 }),
    flags: {},
    baseline: "green",
    // Restated from `expectNoNotice("sampling")`. That assertion encoded `sampling: "native"`,
    // and `.omc/research/kiro-wire-spike.md` §11.2 measured this endpoint answering
    // `400 {"detail":"Unsupported parameter: temperature"}` and `...: top_p` to exactly the two
    // values below, with a 200 on the control run that sent neither. Two things had to change
    // together, and Run_Record 16 item 2 is explicit that changing only one is the trap: the
    // fields go on the denylist *and* the cell becomes `degrade`, because a drop with no notice
    // is the silent drop this whole feature removes — and it would put the case back to passing
    // vacuously, which is how the regression got past a fully green offline suite.
    //
    // The three assertions are one claim each and none is redundant. `status-200` is the half
    // that separates `degrade` from `reject`: the request must still be answered. The completion
    // event keeps that 200 from being an empty or aborted stream. `declared-outcome-sampling`
    // then requires the client to have been told — and because the 200 is asserted separately,
    // its rejection branch is unreachable here, so it reduces to "exactly one notice naming
    // sampling, temperature, or top_p".
    assertions: [
      expectStatus(200),
      expectEventType("response.completed"),
      expectDeclaredOutcome("sampling", ["temperature", "top_p"]),
    ],
  },
  {
    id: "effort-default",
    title: "Kiro sends the model's default effort level when the client states none",
    upstream: "kiro",
    route: "/v1/messages",
    body: messages(),
    flags: {},
    baseline: "red",
    assertions: [expectStatus(200), expectUpstreamEffortPresent(), expectUpstreamEffortIn(KIRO_EFFORT_LEVELS)],
  },
  {
    id: "effort-degrade",
    // Retitled to name the branch this case actually asserts. `validateKiroEffort()` (task 21.1)
    // classifies a requested effort into four outcomes, and **two** of them can be reached by the
    // body below. They are not the same claim, so the title says which one the assertions make:
    //
    // - `effort_not_in_enum` — the model publishes an effort enum and the requested value is not in
    //   it. Task 22.1 sends the **nearest enum level** plus a notice naming the requested value.
    //   That is this case: `status-200` + `upstream-effort-in-…` (a level *is* on the payload) +
    //   `notice-mentions-${KIRO_OUT_OF_ENUM_EFFORT}` (`notice-mentions-ultra` today).
    // - `effort_unsupported` — the model publishes no effort enum at all. Task 22.1 sends **no
    //   effort level** by design ("there is no enum to draw from") and reports that in a notice.
    //   A case measuring that branch would assert `status-200`, a notice, and the *absence* of an
    //   effort level on the payload — the opposite of `upstream-effort-in-…`.
    //
    // **Which branch ran live on the previous model, measured:** `effort_unsupported`. RR23/RR27
    // read the notice verbatim — "Kiro model 'claude-sonnet-4.5' does not support configurable
    // effort, so the requested effort 'max' was left off the request" — and RR25/RR29 read `2 / 1`:
    // `status-200` and the notice assertion pass, `upstream-effort-in-…` fails with `upstream
    // payload carries no effort level`. So the assertion was not wrong and the branch was not
    // wrong; the case was red because live was on the branch this case does not describe.
    // `claude-sonnet-4.5` publishes `additionalModelRequestFieldsSchema: null` — a denial — and
    // `KiroModelMetadataRegistry` populates from that response only.
    //
    // **What changed, and it is the enum source rather than this case.** `NATIVE_KIRO_MODEL` now
    // defaults to `claude-sonnet-5`, whose live entry publishes
    // `output_config.effort.enum = [low, medium, high, xhigh, max]` (probe output, quoted at that
    // constant). So this body now reaches `effort_not_in_enum` — the branch the title names — with
    // **no edit to any assertion here**, which is exactly what the construction below was for.
    //
    // **Why the assertion stays.** Deleting or loosening `upstream-effort-in-…` would delete the
    // only live check that a substituted level reaches the wire — the exact half RR25 records as
    // still unproven. The requested value is `KIRO_OUT_OF_ENUM_EFFORT`, held out-of-enum by
    // construction and locked by `harness.test.ts`, so it stays out-of-enum as the enum source moves.
    title: "effort_not_in_enum: an effort outside the model's published enum degrades to the nearest level in it, with a notice",
    upstream: "kiro",
    route: "/v1/messages",
    // `KIRO_OUT_OF_ENUM_EFFORT` is absent from `KIRO_EFFORT_LEVELS` by construction — no
    // enum-publishing Kiro model on this account lists it — so this is out-of-enum whichever source
    // supplies the enum, and `nearestEnumLevel()` substitutes the model's strongest level (`max`).
    body: messages({ output_config: { effort: KIRO_OUT_OF_ENUM_EFFORT } }),
    flags: {},
    baseline: "red",
    assertions: [
      expectStatus(200),
      expectUpstreamEffortIn(KIRO_EFFORT_LEVELS),
      expectNoticeMentions(KIRO_OUT_OF_ENUM_EFFORT),
    ],
  },
  {
    id: "thinking-budget",
    title: "A thinking budget maps to an effort level and says so",
    upstream: "kiro",
    route: "/v1/messages",
    body: messages({ thinking: { type: "enabled", budget_tokens: 12_000 } }),
    flags: {},
    baseline: "red",
    assertions: [expectStatus(200), expectUpstreamEffortIn(KIRO_EFFORT_LEVELS), expectNoticeMentions("12000")],
  },
  {
    id: "passthrough-bytes",
    // Two claims, because Run_Record 19 measured that one of them can only be made in the
    // normalized form: the client bytes are exactly the bytes the gateway captured from its
    // own upstream call, and they match a second, independent direct call frame for frame
    // once the per-call volatile fields are blanked (`byte-diff.ts`).
    title: "Streaming /v1/responses to Codex forwards upstream bytes untransformed",
    upstream: "codex",
    route: "/v1/responses",
    body: responses({ stream: true }),
    flags: { NATIVE_PASSTHROUGH: "1" },
    baseline: "red",
    requiresDirectUpstreamCall: true,
    assertions: [
      expectStatus(200),
      expectClientBytesEqualCapturedUpstreamBytes(),
      expectBytesMatchDirectCallModuloVolatileFields(),
    ],
  },
  {
    id: "passthrough-off",
    title: "With the flag unset the same request takes the canonical path",
    upstream: "codex",
    route: "/v1/responses",
    body: responses({ stream: true }),
    flags: {},
    baseline: "green",
    assertions: [expectStatus(200), expectEventType("response.completed")],
  },
  {
    id: "messages-no-passthrough",
    title: "/v1/messages never takes the passthrough path even with the flag on",
    upstream: "codex",
    route: "/v1/messages",
    // Assertions unchanged, and worth reading against Run_Record 16: this case carries no
    // sampling field of its own, only the `max_tokens: 256` the `messages()` helper must send
    // because the Claude API makes it mandatory. That alone was enough for a `400 Unsupported
    // parameter: max_output_tokens` once the limit started reaching the wire, which is why the
    // §11.2 correction reads on this case too. With `outputLength` declared `degrade` the limit
    // is dropped, the request is answered, and the notice arrives as an extra content block —
    // none of which disturbs the three structural claims below.
    body: messages({ model: NATIVE_CODEX_MODEL, stream: true }),
    flags: { NATIVE_PASSTHROUGH: "1" },
    baseline: "green",
    assertions: [expectStatus(200), expectEventType("message_start"), expectEventType("message_stop")],
  },
  {
    id: "web-search-native",
    title: "Model-emitted web search flows through untouched",
    upstream: "kiro",
    route: "/v1/messages",
    // No client web tool and no search phrase, so a synthesized call is structurally impossible.
    body: messages({}, "Find the current stable Bun release version and reply with just the version number."),
    flags: {},
    baseline: "green",
    assertions: [expectStatus(200), expectNoSynthesizedClientToolCalls(), expectServerToolResultsArePaired()],
  },
  {
    id: "web-search-no-heuristic",
    title: "Intent heuristics stay inactive: no tool call the model did not emit",
    upstream: "kiro",
    route: "/v1/messages",
    // The prompt names web search on purpose — that phrase is what trips the preflight today.
    body: messages({ tools: clientWebTools() }, "Do not use web search. Reply with exactly: ok"),
    flags: {},
    baseline: "red",
    assertions: [expectStatus(200), expectNoSynthesizedClientToolCalls()],
  },
  {
    id: "web-fetch-emulate",
    title: "Kiro emulates web_fetch instead of rejecting it",
    upstream: "kiro",
    route: "/v1/messages",
    body: messages(
      { tools: [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 1 }] },
      "Fetch https://bun.sh/docs and reply with the page title only.",
    ),
    flags: {},
    baseline: "red",
    assertions: [expectStatus(200), expectBlockType("web_fetch_tool_result"), expectServerToolCount("web_fetch_requests", 1)],
  },
  {
    id: "mcp-toolset-kiro",
    title: "Kiro executes an MCP toolset against the loopback fixture",
    upstream: "kiro",
    route: "/v1/messages",
    body: mcpToolsetBody("never"),
    flags: { NATIVE_MCP_EMULATION: "1" },
    baseline: "red",
    requiresMcpFixture: true,
    assertions: [expectStatus(200), expectBlockType("mcp_tool_result"), expectServerToolCount("mcp_calls", 1)],
  },
  {
    id: "mcp-approval-reject",
    title: "require_approval: always is rejected and names the alternative",
    upstream: "kiro",
    route: "/v1/messages",
    body: mcpToolsetBody("always"),
    flags: { NATIVE_MCP_EMULATION: "1" },
    baseline: "red",
    requiresMcpFixture: true,
    assertions: [expectStatus(400), expectErrorMentions("require_approval", "never")],
  },
  {
    id: "no-silent-drop",
    // Two of the four assertions could not pass before task 14b.7/14b.8, and the same two were
    // measured red for twelve runs (RR15 → RR56): the request carries `temperature`/`top_p`,
    // `KIRO_CAPABILITIES.features.sampling` is `reject`, so it dies with a 400 **before**
    // `resolveRequestedEffort()` runs — so `thinkingBudget`, decided inside that function, could not
    // reach the notice list on this path — and `stopSequences` was never named because the body came
    // from `firstRejection()`, which reports only the first rejection.
    //
    // Both closed at gate 14b.10, measured in Run_Record 57 (`4 / 0`), with the case, its body, and
    // its four assertions unchanged: the 400 is built from `FeatureDecisions.rejectionReport()`, so
    // it names every rejected feature, and `Kiro_Upstream_Provider` decides the deferred
    // `thinkingBudget` outcome before that report, so a refused request reports the budget mapping
    // (`4000 → low`) it made. `baseline` stays `red` — that field records the pre-implementation
    // measurement Requirement 24.5 fixes, not the current state.
    title: "Every field covered by the matrix ends in a declared outcome",
    upstream: "kiro",
    route: "/v1/messages",
    body: messages({
      temperature: 0.3,
      top_p: 0.8,
      stop_sequences: ["STOP"],
      thinking: { type: "enabled", budget_tokens: 4000 },
      tool_choice: { type: "any" },
      tools: [{ name: "noop", description: "Does nothing.", input_schema: { type: "object", properties: {} } }],
    }),
    flags: {},
    baseline: "red",
    assertions: [
      expectDeclaredOutcome("sampling", ["temperature", "top_p"]),
      expectDeclaredOutcome("stopSequences", ["stop_sequences", "stop sequences"]),
      expectDeclaredOutcome("toolChoiceForced", ["tool_choice", "tool choice"]),
      expectDeclaredOutcome("thinkingBudget", ["budget_tokens", "thinking budget"]),
    ],
  },
]

export function nativeLiveCase(id: NativeLiveCaseId): NativeLiveCase {
  const found = NATIVE_LIVE_CASES.find((liveCase) => liveCase.id === id)
  if (!found) throw new Error(`Unknown native live case: ${id}`)
  return found
}

export function nativeLiveCasesFor(upstream: NativeLiveCase["upstream"]) {
  return NATIVE_LIVE_CASES.filter((liveCase) => liveCase.upstream === upstream)
}

/** Case ids whose recorded pre-implementation state is `state` (Requirements 24.5, 24.6). */
export function nativeBaselineCaseIds(state: NativeLiveCase["baseline"]) {
  return NATIVE_LIVE_CASES.filter((liveCase) => liveCase.baseline === state).map((liveCase) => liveCase.id)
}

/**
 * Fills the MCP fixture URL into a case body. Returns a deep copy, so a run can never
 * mutate the registry and leak state into the next case.
 */
export function resolveNativeCaseBody(liveCase: NativeLiveCase, context: { mcpServerUrl?: string } = {}): JsonObject {
  const serialized = JSON.stringify(liveCase.body)
  if (!serialized.includes(NATIVE_MCP_SERVER_URL_PLACEHOLDER)) return JSON.parse(serialized) as JsonObject
  if (!context.mcpServerUrl) throw new Error(`Case ${liveCase.id} needs an MCP fixture URL`)
  return JSON.parse(serialized.split(NATIVE_MCP_SERVER_URL_PLACEHOLDER).join(context.mcpServerUrl)) as JsonObject
}
