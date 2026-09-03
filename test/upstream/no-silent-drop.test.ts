// Task 10.6 — the no-silent-drop matrix walk (Requirements 10.4, 10.8).
//
// Requirement 10.8 asks for one unit test that walks every `ProviderFeature` of every upstream
// and asserts each produces a Feature_Notice, a 400, or a native forward, with zero features
// producing a fifth outcome. The walk below is that test, and its shape follows from one honest
// fact about the current tree: a per-upstream `features.ts` resolver does not decide all twelve
// features. Three are decided while the tool list is expanded, `thinkingBudget` is decided by
// the effort pipeline on two upstreams, and `systemPrompt` is unconditional emulation inside
// Kiro's `embedInstructions()`.
//
// So each upstream declares two disjoint categories for its twelve features:
//
//   * **resolved here** — the resolver sees the field and hands it to `FeatureDecisions`.
//   * **decided elsewhere** — with the owner named, in {@link FEATURE_OWNERSHIP}.
//
// Both categories are then checked against what the resolver *actually* does, in both
// directions:
//
//   * a feature the table calls "resolved here" must appear in `resolvedFeatures()`;
//   * a feature the table attributes elsewhere must **not** appear there (a stale attribution
//     is as much a lie as a missing one);
//   * the union of the two categories must be exactly `PROVIDER_FEATURES`.
//
// That last equality is where the requirement bites. A feature in *neither* category — present
// in the request, unresolved by the resolver, unattributed by the table — fails this file
// loudly, and that is precisely the silent drop Requirement 10.8 targets. Nothing here is
// skipped or filtered to make the walk pass; an absence is either accounted for by name or it
// is a failure.
//
// Related coverage, deliberately not duplicated: `test/core/feature-policy.property.test.ts`
// owns the totality property over arbitrary inputs, `test/upstream/features.test.ts` and
// `test/upstream/kiro/features.test.ts` own the per-upstream examples and the delivery paths.
// This file owns the cross-upstream census.
import { afterEach, describe, expect, test } from "bun:test"

import type { Canonical_Request } from "../../src/core/canonical"
import { FEATURE_OUTCOME_KINDS } from "../../src/core/feature-policy"
import type { FeatureOutcomeKind } from "../../src/core/feature-policy"
import type { FeatureDecisions } from "../../src/core/feature-decisions"
import type { FeaturePolicy, ProviderFeature } from "../../src/core/provider-capabilities"
import { PROVIDER_FEATURES } from "../../src/core/provider-capabilities"
import type { JsonObject } from "../../src/core/types"
import { CODEX_CAPABILITIES } from "../../src/upstream/codex/capabilities"
import { resolveCodexFeatures } from "../../src/upstream/codex/features"
import { COPILOT_CAPABILITIES } from "../../src/upstream/copilot/capabilities"
import { resolveCopilotFeatures } from "../../src/upstream/copilot/features"
import { KIRO_CAPABILITIES } from "../../src/upstream/kiro/capabilities"
import { resolveKiroFeatures } from "../../src/upstream/kiro/features"
import { Kiro_Auth_Manager, Kiro_Client, Kiro_Upstream_Provider } from "../../src/upstream/kiro"

/**
 * The `Canonical_Request` members task 14 adds (`sampling`, `cacheHint`), written through the
 * same local-cast idiom the per-upstream feature tests use.
 *
 * Necessary rather than convenient: `sampling`, `outputLength`, `stopSequences`, and
 * `promptCache` are resolved from members canonical does not carry yet, so a walk restricted to
 * today's contract could not make them *present* and would report four features as
 * absent-and-unattributed — a false finding. Casting keeps the walk over all twelve honest
 * without widening core's contract from a test.
 */
type FutureRequest = Canonical_Request & {
  sampling?: { maxOutputTokens?: number; temperature?: number; topP?: number; stopSequences?: string[] }
  cacheHint?: Array<{ scope?: string; ttl?: string }>
}

/** The request-shaped fields one feature needs in order to be present. */
type FeaturePatch = Partial<Pick<FutureRequest, "instructions" | "reasoningEffort" | "toolChoice" | "textFormat" | "sampling" | "cacheHint" | "tools">>

/**
 * A base request carrying **none** of the twelve features.
 *
 * No `instructions` and no `reasoningEffort` in particular: either one would make
 * `systemPrompt` or `thinkingBudget` present on an upstream that resolves it, and the walk's
 * per-feature isolation (exactly one feature resolved per request) would break in a way that
 * looks like a resolver bug.
 */
function baseRequest(): FutureRequest {
  return {
    model: "claude-sonnet-4-5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
  }
}

/**
 * How to make each feature present in a request, one feature at a time.
 *
 * Minimal on purpose — each patch turns on exactly one feature and nothing else, so the
 * resolved set for a single-feature request is a singleton and any extra member is a real
 * over-resolution rather than an artifact of a fat fixture. The hosted-tool patches carry no
 * `parameters`, which keeps them from tripping `strictToolSchema` as a side effect.
 */
const FEATURE_PRESENCE: Record<ProviderFeature, FeaturePatch> = {
  sampling: { sampling: { temperature: 0.2 } },
  // Its own sub-member of `sampling`, and the only one this patch sets: `outputLength` is a
  // feature of its own, so a request carrying only `maxOutputTokens` must resolve exactly it and
  // not `sampling`. The per-feature isolation assertion in the walk is what holds that.
  outputLength: { sampling: { maxOutputTokens: 256 } },
  stopSequences: { sampling: { stopSequences: ["STOP"] } },
  thinkingBudget: { reasoningEffort: "high" },
  systemPrompt: { instructions: "Be helpful" },
  promptCache: { cacheHint: [{ scope: "system" }] },
  strictToolSchema: { tools: [{ type: "function", name: "save", strict: true }] },
  toolChoiceForced: { toolChoice: "required" },
  structuredOutput: { textFormat: { type: "json_schema", name: "result" } },
  webSearch: { tools: [{ type: "web_search_20250305", name: "web_search" }] },
  webFetch: { tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] },
  mcpToolset: { tools: [{ type: "mcp_toolset", name: "toolset" }] },
}

/**
 * Apply patches on top of {@link baseRequest}.
 *
 * `sampling`, `cacheHint`, and `tools` merge rather than overwrite, because four different
 * features live inside `sampling` and four inside `tools`; a plain spread would silently drop
 * the earlier feature and shrink the "all features present" request the census depends on.
 */
function requestWith(...patches: readonly FeaturePatch[]): Canonical_Request {
  const merged = baseRequest()
  for (const patch of patches) {
    if (patch.sampling) merged.sampling = { ...merged.sampling, ...patch.sampling }
    if (patch.cacheHint) merged.cacheHint = [...(merged.cacheHint ?? []), ...patch.cacheHint]
    if (patch.tools) merged.tools = [...(merged.tools ?? []), ...(patch.tools as JsonObject[])]
    if (patch.instructions !== undefined) merged.instructions = patch.instructions
    if (patch.reasoningEffort !== undefined) merged.reasoningEffort = patch.reasoningEffort
    if (patch.toolChoice !== undefined) merged.toolChoice = patch.toolChoice
    if (patch.textFormat !== undefined) merged.textFormat = patch.textFormat
  }
  return merged as Canonical_Request
}

/** A request carrying every one of the twelve features at once. */
function requestWithEveryFeature(): Canonical_Request {
  return requestWith(...PROVIDER_FEATURES.map((feature) => FEATURE_PRESENCE[feature]))
}

/**
 * Where a feature's outcome is decided for one upstream.
 *
 * `"resolver"` means the upstream's `features.ts` hands it to `FeatureDecisions`.
 * `"elsewhere"` carries the owner, because an unexplained absence is the silent drop and a
 * named one is a recorded fact — the two must not look alike in this file.
 */
type FeatureOwnership = { site: "resolver" } | { site: "elsewhere"; owner: string }

const TOOL_EXPANSION = "tool-list expansion (task 30), where the hosted tool type names and their per-type policies live in this upstream's `hostedTools` declaration"
const EFFORT_PIPELINE = "the effort pipeline (task 22), which rewrites the requested level on the way out, so resolving it here would pre-empt that decision with a second one"

/**
 * The attribution table: every feature of every upstream, in one of the two categories.
 *
 * Typed as a total `Record<ProviderFeature, …>` so the compiler refuses a missing cell, and
 * re-checked at runtime against `PROVIDER_FEATURES` so a cell cannot go missing across a JSON
 * boundary either. Every `"elsewhere"` string is copied from the reason the owning
 * `features.ts` already documents; if one of those files changes its mind, the cross-check
 * tests below fail rather than this table quietly disagreeing with the code.
 */
const FEATURE_OWNERSHIP: Record<string, Record<ProviderFeature, FeatureOwnership>> = {
  kiro: {
    sampling: { site: "resolver" },
    outputLength: { site: "resolver" },
    stopSequences: { site: "resolver" },
    promptCache: { site: "resolver" },
    toolChoiceForced: { site: "resolver" },
    structuredOutput: { site: "resolver" },
    strictToolSchema: { site: "resolver" },
    systemPrompt: { site: "elsewhere", owner: "`embedInstructions()` in `src/upstream/kiro/payload.ts`, an unconditional emulation rather than a request-shaped decision" },
    thinkingBudget: { site: "elsewhere", owner: EFFORT_PIPELINE },
    webSearch: { site: "elsewhere", owner: TOOL_EXPANSION },
    webFetch: { site: "elsewhere", owner: TOOL_EXPANSION },
    mcpToolset: { site: "elsewhere", owner: TOOL_EXPANSION },
  },
  codex: {
    sampling: { site: "resolver" },
    outputLength: { site: "resolver" },
    stopSequences: { site: "resolver" },
    promptCache: { site: "resolver" },
    systemPrompt: { site: "resolver" },
    toolChoiceForced: { site: "resolver" },
    structuredOutput: { site: "resolver" },
    strictToolSchema: { site: "resolver" },
    thinkingBudget: { site: "elsewhere", owner: EFFORT_PIPELINE },
    webSearch: { site: "elsewhere", owner: TOOL_EXPANSION },
    webFetch: { site: "elsewhere", owner: TOOL_EXPANSION },
    mcpToolset: { site: "elsewhere", owner: TOOL_EXPANSION },
  },
  copilot: {
    sampling: { site: "resolver" },
    outputLength: { site: "resolver" },
    stopSequences: { site: "resolver" },
    promptCache: { site: "resolver" },
    thinkingBudget: { site: "resolver" },
    systemPrompt: { site: "resolver" },
    toolChoiceForced: { site: "resolver" },
    structuredOutput: { site: "resolver" },
    strictToolSchema: { site: "resolver" },
    webSearch: { site: "elsewhere", owner: TOOL_EXPANSION },
    webFetch: { site: "elsewhere", owner: TOOL_EXPANSION },
    mcpToolset: { site: "elsewhere", owner: TOOL_EXPANSION },
  },
}

interface UpstreamWalk {
  name: string
  declared: Readonly<Record<ProviderFeature, FeaturePolicy>>
  resolve: (request: Canonical_Request, options: { strict: boolean }) => FeatureDecisions
  ownership: Record<ProviderFeature, FeatureOwnership>
}

const UPSTREAMS: readonly UpstreamWalk[] = [
  { name: "kiro", declared: KIRO_CAPABILITIES.features, resolve: resolveKiroFeatures, ownership: FEATURE_OWNERSHIP.kiro! },
  { name: "codex", declared: CODEX_CAPABILITIES.features, resolve: resolveCodexFeatures, ownership: FEATURE_OWNERSHIP.codex! },
  { name: "copilot", declared: COPILOT_CAPABILITIES.features, resolve: resolveCopilotFeatures, ownership: FEATURE_OWNERSHIP.copilot! },
]

/**
 * What the client actually gets. Exactly three, which is the whole of Requirement 10.8's
 * "a Feature_Notice, a 400, or a native forward".
 *
 * A fourth label is unrepresentable here, so the assertion that no feature produces one is a
 * mapping over the closed outcome union rather than a guess at what else might happen.
 */
const DELIVERIES = ["feature_notice", "http_400", "native_forward"] as const
type Delivery = (typeof DELIVERIES)[number]

function deliveryFor(kind: FeatureOutcomeKind): Delivery {
  switch (kind) {
    case "emulate":
    case "degrade":
      return "feature_notice"
    case "reject":
      return "http_400"
    case "native":
      return "native_forward"
  }
}

/** The kind a declared policy must produce, which is the whole of strict mode when `strict`. */
function expectedKind(policy: FeaturePolicy, strict: boolean): FeatureOutcomeKind {
  if (policy === "degrade" && strict) return "reject"
  return policy
}

/**
 * Read one feature's outcome back off a `FeatureDecisions`, and prove it is a single outcome.
 *
 * Observation is deliberately indirect — notices, rejection, and resolved-set membership are
 * the three things a caller can see — because those are the signals an upstream's `proxy()`
 * uses to build a response. If they disagreed with the outcome the resolver returned, the
 * client would see something other than what was decided, which is the bug this file is
 * looking for.
 */
function observedOutcome(decisions: FeatureDecisions, feature: ProviderFeature): { kind: FeatureOutcomeKind; delivery: Delivery } {
  const notices = decisions.notices().filter((notice) => notice.feature === feature)
  const rejection = decisions.firstRejection()
  const rejected = rejection?.feature === feature
  const resolved = decisions.resolvedFeatures().has(feature)

  // Exactly one signal, so no feature can be both reported and rejected, or reported twice.
  expect(resolved, `${feature} must reach resolve() to have an outcome at all`).toBe(true)
  expect(notices.length, `${feature} produced ${notices.length} notices; a reporting outcome produces exactly one`).toBeLessThanOrEqual(1)
  const signals = [notices.length > 0, rejected].filter(Boolean).length
  expect(signals, `${feature} produced ${signals} simultaneous outcomes`).toBeLessThanOrEqual(1)

  if (rejected) {
    expect(rejection!.message).toContain(feature)
    expect(rejection!.message).toMatch(/Use .+ instead\./)
    return { kind: "reject", delivery: "http_400" }
  }
  const notice = notices[0]
  if (notice) {
    expect(notice.detail.trim().length, `${feature} notice must carry a non-empty detail`).toBeGreaterThan(0)
    return { kind: notice.policy, delivery: "feature_notice" }
  }
  return { kind: "native", delivery: "native_forward" }
}

describe("no silent drop — every feature of every upstream is accounted for", () => {
  // The census. Empirical on the left, declared-by-this-file on the right; a feature missing
  // from both sides is the finding Requirement 10.8 exists to surface.
  for (const upstream of UPSTREAMS) {
    describe(upstream.name, () => {
      test("every one of the twelve features is either resolved here or attributed to a named owner", () => {
        const everything = requestWithEveryFeature()
        const resolvedHere = new Set(upstream.resolve(everything, { strict: false }).resolvedFeatures())
        const attributedElsewhere = new Set(PROVIDER_FEATURES.filter((feature) => upstream.ownership[feature].site === "elsewhere"))

        // No feature is in neither category. This is the assertion that fails on a silent drop.
        const unaccounted = PROVIDER_FEATURES.filter((feature) => !resolvedHere.has(feature) && !attributedElsewhere.has(feature))
        expect(unaccounted, `${upstream.name} silently drops these features: neither resolved nor attributed`).toEqual([])

        // …and none is in both, so an attribution cannot go stale behind a resolver that
        // started covering the feature after all.
        const doubleCounted = PROVIDER_FEATURES.filter((feature) => resolvedHere.has(feature) && attributedElsewhere.has(feature))
        expect(doubleCounted, `${upstream.name} attributes these features elsewhere while also resolving them`).toEqual([])

        // The two categories partition the matrix exactly.
        expect(new Set([...resolvedHere, ...attributedElsewhere]).size).toBe(PROVIDER_FEATURES.length)

        // The table's own claim about the resolver matches the resolver, both directions.
        const claimedResolvedHere = PROVIDER_FEATURES.filter((feature) => upstream.ownership[feature].site === "resolver")
        expect([...resolvedHere].sort()).toEqual([...claimedResolvedHere].sort())
      })

      test("every attributed absence names its owner and stays covered by the declared matrix", () => {
        for (const feature of PROVIDER_FEATURES) {
          const ownership = upstream.ownership[feature]
          if (ownership.site === "resolver") continue

          // An attribution without an owner would be an excuse rather than a fact.
          expect(ownership.owner.trim().length, `${upstream.name}/${feature} is attributed elsewhere with no owner named`).toBeGreaterThan(0)
          // The feature is still declared — attributed elsewhere, not undeclared.
          expect(upstream.declared[feature], `${upstream.name}/${feature} has no declared policy`).toBeTruthy()
          // And this resolver genuinely does not claim it, even when the field is present.
          const decisions = upstream.resolve(requestWith(FEATURE_PRESENCE[feature]), { strict: false })
          expect(decisions.resolvedFeatures().has(feature)).toBe(false)
        }
      })

      // The walk proper: one request per resolved feature, in both strict modes, each asserted
      // to land on exactly one of the four outcomes and exactly one of the three deliveries.
      for (const strict of [false, true]) {
        test(`each resolved feature produces one declared outcome (strict=${strict})`, () => {
          const observed: Array<{ feature: ProviderFeature; kind: FeatureOutcomeKind; delivery: Delivery }> = []

          for (const feature of PROVIDER_FEATURES) {
            if (upstream.ownership[feature].site !== "resolver") continue

            const decisions = upstream.resolve(requestWith(FEATURE_PRESENCE[feature]), { strict })

            // Per-feature isolation: this request turned on one feature, so one was resolved.
            expect([...decisions.resolvedFeatures()], `${upstream.name}/${feature} over-resolved`).toEqual([feature])

            const outcome = observedOutcome(decisions, feature)
            expect(outcome.kind, `${upstream.name}/${feature} produced an outcome outside the closed union`).toBe(expectedKind(upstream.declared[feature], strict))
            expect(outcome.delivery).toBe(deliveryFor(outcome.kind))
            observed.push({ feature, ...outcome })
          }

          // Zero features produce a fifth outcome, and zero produce a fourth delivery.
          expect(observed.every((entry) => (FEATURE_OUTCOME_KINDS as readonly string[]).includes(entry.kind))).toBe(true)
          expect(observed.every((entry) => (DELIVERIES as readonly string[]).includes(entry.delivery))).toBe(true)
          expect(observed).not.toEqual([])
        })
      }

      // The set comparison of Requirement 10.8, on one request rather than twelve: every
      // feature this resolver owns and the client sent is in `resolvedFeatures()`.
      test("a request carrying everything leaves no resolver-owned feature unresolved", () => {
        const decisions = upstream.resolve(requestWithEveryFeature(), { strict: false })
        const resolved = decisions.resolvedFeatures()
        const owned = PROVIDER_FEATURES.filter((feature) => upstream.ownership[feature].site === "resolver")

        expect(owned.filter((feature) => !resolved.has(feature))).toEqual([])
        // Resolution never stops at the first rejection, so the account stays complete even
        // though this request rejects on Kiro.
        expect(resolved.size).toBe(owned.length)
      })

      // `none` and `auto` are not drops: honouring them requires nothing, so there is nothing
      // to record. Asserted so a future reader does not mistake the silence for a gap.
      test("`none` and `auto` tool choices resolve nothing, because honouring them costs nothing", () => {
        for (const toolChoice of ["none", "auto"]) {
          const decisions = upstream.resolve(requestWith({ toolChoice }), { strict: false })
          expect(decisions.resolvedFeatures().has("toolChoiceForced")).toBe(false)
          expect(decisions.notices()).toEqual([])
          expect(decisions.firstRejection()).toBeUndefined()
        }
      })
    })
  }

  // Across all three upstreams, the observed delivery labels are exactly the three the
  // requirement allows — and all three are actually exercised, so the claim is not vacuous.
  test("the three upstreams between them exercise all three deliveries and nothing else", () => {
    const deliveries = new Set<Delivery>()
    for (const upstream of UPSTREAMS) {
      for (const feature of PROVIDER_FEATURES) {
        if (upstream.ownership[feature].site !== "resolver") continue
        const decisions = upstream.resolve(requestWith(FEATURE_PRESENCE[feature]), { strict: false })
        deliveries.add(observedOutcome(decisions, feature).delivery)
      }
    }

    expect([...deliveries].sort()).toEqual([...DELIVERIES].sort())
  })
})

/**
 * One end-to-end anchor per delivery on Kiro, so "a 400" and "a Feature_Notice" are facts about
 * a response rather than about a bookkeeping object.
 *
 * Kiro is the upstream that carries all of `reject`, `degrade`, and `emulate` in its
 * declaration, which makes it the one place two of the three deliveries can be shown on the
 * same provider. The native forward is shown on Codex and Copilot in
 * `test/upstream/features.test.ts`.
 */
describe("no silent drop — the deliveries are observable on a Kiro response", () => {
  function provider() {
    const auth = new Kiro_Auth_Manager(
      { accessToken: "access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 700_000).toISOString(), region: "us-east-1" },
      "/tmp/unused",
    )
    let calls = 0
    const client = new Kiro_Client(auth, {
      fetch: (() => {
        calls += 1
        return Promise.resolve(new Response(""))
      }) as unknown as typeof fetch,
    })
    return { provider: new Kiro_Upstream_Provider({ auth, client }), upstreamCalls: () => calls }
  }

  test("a rejected feature becomes a 400 naming the feature, with no upstream call", async () => {
    const { provider: kiro, upstreamCalls } = provider()
    const result = await kiro.proxy(requestWith(FEATURE_PRESENCE.sampling))

    expect(result.type).toBe("canonical_error")
    if (result.type !== "canonical_error") return
    expect(result.status).toBe(400)
    expect(result.body).toContain("sampling")
    expect(upstreamCalls()).toBe(0)
  })

  /**
   * The unit-level twin of the `no-silent-drop` live case: one request carrying both a
   * `reject`-declared and a `degrade`-declared feature. Task 14b — the rejection reports every
   * other outcome the request decided, so a single request now delivers both `http_400` and
   * `feature_notice`. `DELIVERIES` and `observedOutcome()` need no change: the walk reads per
   * feature, and per feature each delivery is still exactly one thing.
   */
  test("a rejection carries the notices the same request decided, exactly once, with no upstream call", async () => {
    const { provider: kiro, upstreamCalls } = provider()
    const result = await kiro.proxy(requestWith(FEATURE_PRESENCE.sampling, FEATURE_PRESENCE.toolChoiceForced))
    expect(result.type).toBe("canonical_error")
    if (result.type !== "canonical_error") return
    expect(result.status).toBe(400)
    expect(result.body).toContain("sampling")
    // Exactly once, and the rejected feature contributes no notice of its own.
    expect(result.featureNotices?.map((notice) => notice.feature)).toEqual(["toolChoiceForced"])
    expect(upstreamCalls()).toBe(0)
  })
  test("a reported feature becomes a featureNotices entry on a 200", async () => {
    const { provider: kiro } = provider()
    const result = await kiro.proxy(requestWith(FEATURE_PRESENCE.toolChoiceForced))

    expect(result.type).toBe("canonical_response")
    if (result.type !== "canonical_response") return
    expect(result.featureNotices?.map((notice) => notice.feature)).toEqual(["toolChoiceForced"])
  })
})

/**
 * Requirement 10.4 — the two `tool_choice` cases warn zero times.
 *
 * Task 10.3 deleted both `console.warn` calls in `computeEffectiveTools()` and replaced them
 * with a `toolChoiceForced` resolution. The spy asserts the *absence*, because a notice plus a
 * surviving warn would satisfy every other test in the tree while still writing to the
 * operator's console on every request — the exact behaviour the requirement replaces.
 *
 * The count is zero across the whole `proxy()` call, not merely zero warns whose text mentions
 * tool choice. A text filter would keep passing if the two calls came back under new wording,
 * which is the regression most worth catching.
 */
describe("no silent drop — the tool_choice path warns zero times", () => {
  const realWarn = console.warn

  afterEach(() => {
    // Restored unconditionally, including after a failing assertion, so a spy cannot leak into
    // another file — `console` is process-global and Bun shares it across test files.
    console.warn = realWarn
  })

  async function proxyWithWarnSpy(request: Canonical_Request) {
    const auth = new Kiro_Auth_Manager(
      { accessToken: "access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 700_000).toISOString(), region: "us-east-1" },
      "/tmp/unused",
    )
    const client = new Kiro_Client(auth, { fetch: (() => Promise.resolve(new Response(""))) as unknown as typeof fetch })
    const kiro = new Kiro_Upstream_Provider({ auth, client })

    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    try {
      return { result: await kiro.proxy(request), warnings }
    } finally {
      console.warn = realWarn
    }
  }

  test.each([
    ["required", "required" as const],
    ["named", { type: "function", name: "save" }],
  ])("a %s tool choice reports through a notice and writes nothing to the console", async (_label, toolChoice) => {
    const { result, warnings } = await proxyWithWarnSpy(requestWith({ toolChoice, tools: [{ type: "function", name: "save" }] }))

    expect(warnings.map((args) => args.map(String).join(" "))).toEqual([])
    expect(result.type).toBe("canonical_response")
    if (result.type !== "canonical_response") return
    expect(result.featureNotices?.map((notice) => notice.feature)).toEqual(["toolChoiceForced"])
  })

  /**
   * The control for the two assertions above.
   *
   * "Zero warns" is only evidence if the spy can see a warn at all — a mis-wired spy, a
   * provider that never reached `computeEffectiveTools()`, or a `proxy()` that returned early
   * would each produce zero warns for the wrong reason. Kiro still warns about a URL-based
   * image on the same code path, so this case proves the instrument works before the two above
   * are believed. It is not asserting that the image warn is desirable; that warn belongs to a
   * different concern and is untouched by task 10.
   */
  test("the spy is wired: a warn that the same path still emits is recorded", async () => {
    const request = requestWith()
    const { warnings } = await proxyWithWarnSpy({
      ...request,
      input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/cat.png" }] }],
    })

    expect(warnings.map((args) => args.map(String).join(" "))).toEqual(["Skipping URL-based image because Kiro only supports base64 data URL images"])
  })
})
