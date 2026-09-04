// Feature: native-api-mode, Property 42: A rejection names every feature it rejected, and a single
// rejection is unchanged.
//
// For any request that resolves at least one field to `reject`, on any of the three upstreams: the
// reported 400 message contains the name of every rejected feature and each of those rejections'
// own messages; it begins with the first rejection's message, so which feature caused the 400 stays
// resolution-ordered and unchanged; each rejected feature contributes exactly one entry to the
// report however many times it was resolved; and for a request that rejects exactly one field the
// reported message is byte-identical to that rejection's own message. On Kiro additionally: a
// request that carries a rejected field *and* an effort intent reports `thinkingBudget` exactly
// once on the 400, and a request that carries no effort intent leaves that 400 exactly as it was.
//
// **Validates: Requirements 10.3, 10.11, 10.12**
//
// ## What this is written against, and what it deliberately leaves to Property 41
//
// The composition is core's (`FeatureDecisions.rejectionReport()`), so the general clauses are
// stated over generated declarations rather than over one matrix — the property has to hold for a
// cell that moves, and for an upstream that does not exist yet. The per-upstream clauses then run
// each real resolver, which is pure, so no transport is faked to ask a question about resolution.
//
// That the three `proxy()` implementations actually *use* the report is Property 41's clause, not a
// second copy here: `test/upstream/reject-notices.property.test.ts` compares the body of every
// generated rejecting request on all three upstreams against `rejectionReport().message`. The one
// end-to-end arm below is the one thing that clause cannot see, because it is not about
// composition: Kiro's `thinkingBudget` is decided after the bail point, so "the report is complete"
// is only observable through `proxy()`.
//
// ## The measurement behind it
//
// `no-silent-drop` failed `declared-outcome-stopSequences` for twelve runs (Run_Record 15 → 56).
// `stopSequences` is a Kiro `reject` cell resolved after `sampling`, and the 400 body came from
// `firstRejection()`, so the second rejected field was never named — a client had to fix
// `temperature`, retry, and only then learn that `stop_sequences` is unsupported too. The notice
// channel could not carry it: `Canonical_FeatureNotice.policy` is restricted to `degrade` and
// `emulate` (Requirement 8.6), so a rejection has exactly one place to be reported, and that is the
// 400's message.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_Request } from "../../src/core/canonical"
import { FeatureDecisions } from "../../src/core/feature-decisions"
import type { FeaturePolicy, ProviderFeature } from "../../src/core/provider-capabilities"
import { FEATURE_POLICIES, PROVIDER_FEATURES } from "../../src/core/provider-capabilities"
import { CODEX_CAPABILITIES } from "../../src/upstream/codex/capabilities"
import { resolveCodexFeatures } from "../../src/upstream/codex/features"
import { COPILOT_CAPABILITIES } from "../../src/upstream/copilot/capabilities"
import { resolveCopilotFeatures } from "../../src/upstream/copilot/features"
import { KIRO_CAPABILITIES } from "../../src/upstream/kiro/capabilities"
import { resolveKiroFeatures } from "../../src/upstream/kiro/features"
import { kiroEffortProbe } from "./kiro/effort-probe"

// ---------------------------------------------------------------------------------------------
// The core clauses, over generated declarations
// ---------------------------------------------------------------------------------------------

const featureArb = fc.constantFrom(...PROVIDER_FEATURES)
const policyArb = fc.constantFrom(...FEATURE_POLICIES)

/** A declaration for all twelve features, so nothing here depends on a real matrix. */
const declarationArb: fc.Arbitrary<Record<ProviderFeature, FeaturePolicy>> = fc
  .array(policyArb, { minLength: PROVIDER_FEATURES.length, maxLength: PROVIDER_FEATURES.length })
  .map((policies) => Object.fromEntries(PROVIDER_FEATURES.map((feature, index) => [feature, policies[index]!])) as Record<ProviderFeature, FeaturePolicy>)

/** One resolution: a feature, and the prose a caller would author for it. */
const resolutionArb = fc.record({
  feature: featureArb,
  detail: fc.string({ minLength: 1, maxLength: 40 }).map((text) => text.replace(/\s+/g, " ").trim() || "detail"),
  alternative: fc.string({ minLength: 1, maxLength: 40 }).map((text) => text.replace(/\s+/g, " ").trim() || "another upstream"),
})

describe("Property 42 — the report a rejection carries", () => {
  test("Feature: native-api-mode, Property 42: the report names every rejected feature, in resolution order, once each", () => {
    fc.assert(
      fc.property(declarationArb, fc.boolean(), fc.array(resolutionArb, { minLength: 1, maxLength: 8 }), (features, strict, resolutions) => {
        const decisions = new FeatureDecisions(features, strict)
        for (const resolution of resolutions) decisions.resolve(resolution.feature, resolution.detail, resolution.alternative)

        const rejections = decisions.rejections()
        const report = decisions.rejectionReport()
        const first = decisions.firstRejection()

        // Nothing rejected means nothing to report, on both accessors at once.
        if (!rejections.length) {
          expect(report).toBeUndefined()
          expect(first).toBeUndefined()
          return
        }

        // One entry per rejected feature, in resolution order — the same dedup rule notices use,
        // applied to the other channel.
        expect(new Set(rejections.map((rejection) => rejection.feature)).size).toBe(rejections.length)
        expect(rejections[0]).toEqual(first!)

        // The cause is unchanged: `rejectionReport()` reports more, it never re-attributes.
        expect(report?.feature).toBe(first?.feature)
        expect(report?.message.startsWith(first!.message)).toBe(true)

        // Every rejected feature is named, and every rejection's own reason survives whole.
        for (const rejection of rejections) {
          expect(report?.message).toContain(rejection.feature)
          expect(report?.message).toContain(rejection.message)
        }

        // Requirement 10.12 — one rejection is the message it always was, byte for byte.
        if (rejections.length === 1) expect(report?.message).toBe(first!.message)
        else expect(report?.message.length).toBeGreaterThan(first!.message.length)
      }),
      { numRuns: 300 },
    )
  })

  test("Feature: native-api-mode, Property 42: the generated declarations reach one, several, and zero rejections", () => {
    const seen = new Set<string>()
    fc.assert(
      fc.property(declarationArb, fc.boolean(), fc.array(resolutionArb, { minLength: 1, maxLength: 8 }), (features, strict, resolutions) => {
        const decisions = new FeatureDecisions(features, strict)
        for (const resolution of resolutions) decisions.resolve(resolution.feature, resolution.detail, resolution.alternative)
        const count = decisions.rejections().length
        seen.add(count === 0 ? "none" : count === 1 ? "one" : "several")
      }),
      { numRuns: 300 },
    )
    // Without this, every clause above could be running on the "nothing rejected" branch.
    expect([...seen].sort()).toEqual(["none", "one", "several"])
  })
})

// ---------------------------------------------------------------------------------------------
// The per-upstream clauses, over each real declaration and resolver
// ---------------------------------------------------------------------------------------------

/**
 * One canonical field per feature, so a request can be built from a set of features.
 *
 * Deliberately a local table rather than one shared with `reject-notices.property.test.ts`: the two
 * properties generate over different sets — that file needs a reporting field beside a rejecting
 * one, this one needs several rejecting fields at once — and a shared table would make each
 * property's generators move when the other's needs change.
 */
const FIELD_FOR: Partial<Record<ProviderFeature, Partial<Canonical_Request>>> = {
  sampling: { sampling: { temperature: 0.3 } },
  outputLength: { sampling: { maxOutputTokens: 128 } },
  stopSequences: { sampling: { stopSequences: ["STOP"] } },
  promptCache: { cacheHint: [{ scope: "system" }] },
  toolChoiceForced: { toolChoice: "required" },
  structuredOutput: { textFormat: { type: "json_schema", name: "result" } },
  strictToolSchema: { tools: [{ type: "function", name: "save", strict: true }] },
}

const FIELD_FEATURES = Object.keys(FIELD_FOR) as ProviderFeature[]

function requestFor(features: readonly ProviderFeature[]): Canonical_Request {
  let request: Canonical_Request = {
    model: "claude-sonnet-4-5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
  }
  for (const feature of features) {
    const { sampling, ...rest } = FIELD_FOR[feature] ?? {}
    request = { ...request, ...rest, ...(sampling ? { sampling: { ...request.sampling, ...sampling } } : {}) }
  }
  return request
}

interface UpstreamUnderTest {
  name: string
  features: Readonly<Record<ProviderFeature, FeaturePolicy>>
  resolve(request: Canonical_Request, strict: boolean): FeatureDecisions
}

const UPSTREAMS: readonly UpstreamUnderTest[] = [
  { name: "kiro", features: KIRO_CAPABILITIES.features, resolve: (request, strict) => resolveKiroFeatures(request, { strict }) },
  { name: "codex", features: CODEX_CAPABILITIES.features, resolve: (request, strict) => resolveCodexFeatures(request, { strict }) },
  { name: "copilot", features: COPILOT_CAPABILITIES.features, resolve: (request, strict) => resolveCopilotFeatures(request, { strict }) },
]

/** The fields of {@link FIELD_FOR} this resolver records when the request carries that field alone. */
function resolvable(upstream: UpstreamUnderTest): ProviderFeature[] {
  return FIELD_FEATURES.filter((feature) => upstream.resolve(requestFor([feature]), false).resolvedFeatures().has(feature))
}

describe("Property 42 — every upstream's own declaration", () => {
  for (const upstream of UPSTREAMS) {
    test(`Feature: native-api-mode, Property 42: a ${upstream.name} request rejecting several fields names all of them`, () => {
      const fields = resolvable(upstream)
      expect(fields.length).toBeGreaterThan(0)

      fc.assert(
        fc.property(fc.uniqueArray(fc.constantFrom(...fields), { minLength: 1, maxLength: fields.length }), fc.boolean(), (picked, strict) => {
          const requested = fields.filter((feature) => picked.includes(feature))
          const decisions = upstream.resolve(requestFor(requested), strict)
          const rejections = decisions.rejections()
          const report = decisions.rejectionReport()
          if (!rejections.length) return

          // Every rejected feature is one the client actually asked for, and every one is named.
          for (const rejection of rejections) {
            expect(requested).toContain(rejection.feature)
            expect<string>(strict && upstream.features[rejection.feature] === "degrade" ? "reject" : upstream.features[rejection.feature]).toBe("reject")
            expect(report?.message).toContain(rejection.feature)
          }
          // Resolution order, which for these resolvers is matrix order: the cause is the earliest
          // rejected field the request carried.
          expect(report?.feature).toBe(rejections[0]!.feature)
          expect(rejections.map((rejection) => rejection.feature)).toEqual(requested.filter((feature) => rejections.some((r) => r.feature === feature)))
        }),
        { numRuns: 200 },
      )
    })
  }

  /**
   * The declarations this property currently runs against, stated as facts so a moved cell is
   * caught here rather than by a clause quietly covering less — the same guard
   * `reject-notices.property.test.ts` keeps for its own sets.
   */
  test("Feature: native-api-mode, Property 42: several rejections at once are reachable, unstrict on Kiro and strict everywhere", () => {
    // `promptCache` was the third member until it moved to `degrade`; the two that remain are
    // the whole of Kiro's unstrict `reject` set among request-resolved fields, so this stays a
    // multi-rejection case rather than becoming one.
    const kiroUnstrict = resolveKiroFeatures(requestFor(["sampling", "stopSequences", "promptCache"]), { strict: false })
    expect(kiroUnstrict.rejections().map((rejection) => rejection.feature)).toEqual(["sampling", "stopSequences"])
    expect(kiroUnstrict.rejectionReport()?.feature).toBe("sampling")

    for (const upstream of UPSTREAMS) {
      const fields = resolvable(upstream)
      const strictAll = upstream.resolve(requestFor(fields), true)
      // Strict escalates every `degrade`, so every upstream can produce a multi-rejection report —
      // which is what makes the clauses above non-vacuous on Codex and Copilot, neither of which
      // declares a `reject` cell among its request-resolved fields today.
      expect(strictAll.rejections().length, upstream.name).toBeGreaterThan(1)
      const report = strictAll.rejectionReport()
      for (const rejection of strictAll.rejections()) expect(report?.message, upstream.name).toContain(rejection.feature)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// The Kiro end-to-end clause: the report is complete, not merely complete up to the bail point
// ---------------------------------------------------------------------------------------------

const KIRO_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const

describe("Property 42 — Kiro reports the feature it decides after the bail point", () => {
  test("Feature: native-api-mode, Property 42: any effort intent beside a rejected field is reported on the 400, exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constantFrom("ultra", "insane", "extreme").map((requested) => ({ requested, thinking: undefined })),
          fc.integer({ min: 1, max: 200_000 }).map((budgetTokens) => ({ requested: undefined, thinking: { mode: "enabled" as const, budgetTokens } })),
        ),
        async (intent) => {
          const probe = kiroEffortProbe({ levels: KIRO_LEVELS, defaultLevel: "medium" })
          const result = await probe.proxy(intent.requested, intent.thinking, { sampling: { temperature: 0.3 } })

          expect(result.type).toBe("canonical_error")
          if (result.type !== "canonical_error") return
          expect(result.status).toBe(400)
          // The rejection is still `sampling`'s, and the deferred decision rides as a notice.
          expect(result.body.startsWith("This upstream does not support sampling:")).toBe(true)
          const budget = (result.featureNotices ?? []).filter((notice) => notice.feature === "thinkingBudget")
          expect(budget.length).toBe(1)
          expect(budget[0]?.policy).toBe("degrade")
          expect(budget[0]?.detail.length).toBeGreaterThan(0)
          // A refused request never reaches the wire, deferred decision or not.
          expect(probe.upstreamCalls()).toBe(0)
        },
      ),
      { numRuns: 60 },
    )
  })

  test("Feature: native-api-mode, Property 42: with no effort intent the same rejection is untouched and reads no catalog", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<Canonical_Request["thinking"]>(undefined, { mode: "disabled" }, { mode: "disabled", budgetTokens: 8000 }), async (thinking) => {
        const probe = kiroEffortProbe({ levels: KIRO_LEVELS, defaultLevel: "medium" })
        const result = await probe.proxy(undefined, thinking, { sampling: { temperature: 0.3 } })

        expect(result.type).toBe("canonical_error")
        if (result.type !== "canonical_error") return
        // Requirement 10.12 at the proxy level: the four members `canonicalError()` builds, no
        // notice member, and no cost added to a request that had no deferred decision to make.
        expect(Object.keys(result).sort()).toEqual(["body", "headers", "status", "type"])
        expect(result.body).not.toContain("also rejected")
        expect(probe.metadataFetches()).toBe(0)
        expect(probe.upstreamCalls()).toBe(0)
      }),
      { numRuns: 20 },
    )
  })
})
