// Feature: native-api-mode, Property 41: A rejection reports every other outcome the request
// decided, exactly once, and changes nothing when there is none.
//
// For any request that produces a rejection **and** one or more reporting outcomes, on any of the
// three upstreams: the result is a `canonical_error` with status 400 whose message names the
// rejected feature; every recorded `degrade` and `emulate` notice appears on the result exactly
// once, in decision order, deduped by `(feature, detail)`; the rejected feature contributes no
// notice; `resolvedFeatures()` still accounts for every feature the request carried; and zero
// upstream requests are made. For any request that produces a rejection and **no** reporting
// outcome, the result is deep-equal to the result the same request produces today, `featureNotices`
// omitted rather than empty. And for the inbound half, on both inbound providers: the rendered
// error body carries one warning segment naming every `degrade` notice exactly once, ahead of the
// error message that would have been rendered without them, with no field, block type, SSE event
// name, or header the notice-free error response lacks — and an error carrying only `emulate`
// notices renders byte-identically to the notice-free one.
//
// **Validates: Requirements 8.7, 8.8, 9.7, 9.8, 10.11, 10.12, 10.13**
//
// ## What this file is written against, and why not the harness
//
// The three `proxy()` implementations (`src/upstream/{kiro,codex,copilot}/index.ts`), the three
// channel-choice functions (`with*FeatureNotices()`), and the two inbound error branches
// (`Claude_Inbound_Provider.handle()` / `OpenAI_Inbound_Provider.handle()`). Not
// `bun run test:native:verify`: Copilot has no connected account and no live case (Requirement
// 26.9), so a harness-driven property could never cover the third upstream Requirement 10.13 names,
// and a live case would also stop meaning anything the day a declared cell moves.
//
// ## The generators follow the declarations, including where a declaration makes a case unreachable
//
// Nothing here names a feature policy. Each upstream's rejecting and reporting fields are derived at
// load time from its own `capabilities.ts` matrix, by resolving a one-field request per candidate
// field and keeping the fields that upstream's resolver actually records
// (`resolvableFeatures()` below). A cell that moves from `degrade` to `reject` therefore moves the
// generated requests with it instead of leaving this file asserting a case that no longer exists.
//
// **The measurement that shaped this, recorded at task 14b.4.** Neither `CODEX_CAPABILITIES.features`
// nor `COPILOT_CAPABILITIES.features` contains a single `reject` cell today. Two consequences, both
// load-bearing for how the clauses below are written:
//
//  1. Unstrict resolution on those two upstreams never rejects, so drawing "the rejecting field"
//     from their matrices yields an empty set. The route to a rejection there is `strict: true`,
//     which is why the generator has a strict arm as well as an unstrict one.
//  2. Under `strict: true` every `degrade` escalates *together*, and neither upstream declares an
//     `emulate` cell among its request-resolved features — so no notice survives the escalation, and
//     "a rejection carrying notices" is genuinely unreachable through `proxy()` on Codex and
//     Copilot. Asserting it anyway would mean asserting a combination that cannot exist.
//
// So the anti-vacuity clause states the reachable combinations **per upstream** rather than one
// combination for all three: Kiro reaches both "rejection with notices" and "rejection without
// notices", and on Codex/Copilot the clause asserts the emptiness that makes the with-notices case
// unreachable and that strict mode is the route to the rejection. The with-notices delivery is still
// asserted on all three — Requirement 10.13 is about all three — at the one site 14b.2 routed every
// rejection return through, `with*FeatureNotices()`, over generated notice lists. The day a cell on
// either upstream becomes `reject`, the `proxy()` arm picks it up with no edit here and the
// anti-vacuity clause fails until it is updated to record the newly reachable combination.
//
// ## What this adds over its neighbours
//
//  - `test/upstream/features.test.ts` and `test/upstream/kiro/features.test.ts` assert the same
//    delivery at the example level, one request each. This is the generative form over every subset
//    of every declared rejecting and reporting field of all three upstreams.
//  - `test/core/strict.property.test.ts` (Property 5) is about `FeatureDecisions` and never looks at
//    a result object. This file is about what reaches the client.
//  - `test/inbound/notice.property.test.ts` (Properties 7 and 8) stays scoped to the 200 paths; the
//    error path is covered here, as 14b.4 records.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { Canonical_ErrorResponse, Canonical_FeatureNotice, Canonical_Request } from "../../src/core/canonical"
import type { FeatureDecisions } from "../../src/core/feature-decisions"
import type { FeaturePolicy, ProviderFeature } from "../../src/core/provider-capabilities"
import type { UpstreamResult } from "../../src/core/interfaces"
import type { RequestProxyLog } from "../../src/core/types"
import { Claude_Inbound_Provider } from "../../src/inbound/claude"
import { claudeUpstreamErrorMessage } from "../../src/inbound/claude/context-limit"
import { prependClaudeWarning, renderClaudeFeatureWarning } from "../../src/inbound/claude/notice"
import { OpenAI_Inbound_Provider } from "../../src/inbound/openai"
import { prependOpenAIWarning, renderOpenAIFeatureWarning } from "../../src/inbound/openai/notice"
import { Codex_Upstream_Provider } from "../../src/upstream/codex"
import { CODEX_CAPABILITIES } from "../../src/upstream/codex/capabilities"
import { withCodexFeatureNotices } from "../../src/upstream/codex/feature-notices"
import { resolveCodexFeatures } from "../../src/upstream/codex/features"
import { Copilot_Upstream_Provider } from "../../src/upstream/copilot"
import type { Copilot_Auth_Manager } from "../../src/upstream/copilot/auth"
import type { Copilot_Client } from "../../src/upstream/copilot/client"
import { COPILOT_CAPABILITIES } from "../../src/upstream/copilot/capabilities"
import { withCopilotFeatureNotices } from "../../src/upstream/copilot/feature-notices"
import { resolveCopilotFeatures } from "../../src/upstream/copilot/features"
import { Kiro_Auth_Manager, Kiro_Client, Kiro_Upstream_Provider } from "../../src/upstream/kiro"
import { KIRO_CAPABILITIES } from "../../src/upstream/kiro/capabilities"
import { withKiroFeatureNotices } from "../../src/upstream/kiro/feature-notices"
import { resolveKiroFeatures } from "../../src/upstream/kiro/features"
import { textNotices } from "../native/observation"

// ---------------------------------------------------------------------------------------------
// Request fragments — one matrix-covered field per feature, and nothing else
// ---------------------------------------------------------------------------------------------

/**
 * One matrix-covered field, spelled in canonical terms.
 *
 * A `Partial<Canonical_Request>` rather than the local future-members view
 * `test/upstream/features.test.ts` casts through: task 14 landed `sampling` and `cacheHint` on the
 * canonical request itself, so the real type is available and a cast would only hide a mismatch.
 */
type RequestFragment = Partial<Canonical_Request>

/**
 * One field per feature, chosen so a request built from a set of features resolves exactly that set.
 *
 * This table says *how a client asks for a feature*, never what any upstream does about it — the
 * policy is read from each `capabilities.ts` and never written here (design decision D3). Features
 * decided outside a request-shaped resolver (`webSearch`, `webFetch`, `mcpToolset`, and `systemPrompt`
 * on Kiro, which is unconditional emulation inside `embedInstructions()`) are absent because no
 * request field turns them on by itself.
 */
const REQUEST_FRAGMENTS: Partial<Record<ProviderFeature, RequestFragment>> = {
  sampling: { sampling: { temperature: 0.3 } },
  outputLength: { sampling: { maxOutputTokens: 128 } },
  stopSequences: { sampling: { stopSequences: ["STOP"] } },
  promptCache: { cacheHint: [{ scope: "system" }] },
  thinkingBudget: { reasoningEffort: "high" },
  systemPrompt: { instructions: "Be helpful" },
  toolChoiceForced: { toolChoice: "required" },
  structuredOutput: { textFormat: { type: "json_schema", name: "result" } },
  strictToolSchema: { tools: [{ type: "function", name: "save", strict: true }] },
}

const FRAGMENT_FEATURES = Object.keys(REQUEST_FRAGMENTS) as ProviderFeature[]

function baseRequest(): Canonical_Request {
  return {
    model: "gpt-5.4",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
  }
}

/**
 * Merge the fragments for `features` into one request. `sampling` is merged member-by-member rather
 * than replaced, because three different features live inside that one object and a spread would
 * silently drop two of them.
 */
function requestFor(features: readonly ProviderFeature[]): Canonical_Request {
  let request = baseRequest()
  for (const feature of features) {
    const fragment = REQUEST_FRAGMENTS[feature]
    if (!fragment) throw new Error(`no request fragment declared for ${feature}`)
    const { sampling, ...rest } = fragment
    request = {
      ...request,
      ...rest,
      ...(sampling ? { sampling: { ...request.sampling, ...sampling } } : {}),
    }
  }
  return request
}

// ---------------------------------------------------------------------------------------------
// The three upstreams under test
// ---------------------------------------------------------------------------------------------

interface ProxyOutcome {
  result: UpstreamResult
  upstreamCalls: number
}

interface UpstreamUnderTest {
  readonly name: string
  readonly features: Readonly<Record<ProviderFeature, FeaturePolicy>>
  resolve(request: Canonical_Request, strict: boolean): FeatureDecisions
  withNotices(result: UpstreamResult, notices: readonly Canonical_FeatureNotice[]): UpstreamResult
  proxy(request: Canonical_Request, strict: boolean): Promise<ProxyOutcome>
}

/** A response no clause below ever reaches: every generated request rejects before the call. */
const UNREACHED_BODY = JSON.stringify({ id: "resp_1", model: "gpt-5.4", output: [], usage: { input_tokens: 1, output_tokens: 1 } })

const KIRO: UpstreamUnderTest = {
  name: "kiro",
  features: KIRO_CAPABILITIES.features,
  resolve: (request, strict) => resolveKiroFeatures(request, { strict }),
  withNotices: withKiroFeatureNotices,
  proxy: async (request, strict) => {
    let upstreamCalls = 0
    const auth = new Kiro_Auth_Manager(
      { accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 700_000).toISOString(), region: "us-east-1" },
      "/tmp/unused-reject-notices",
    )
    const client = new Kiro_Client(auth, {
      fetch: (() => {
        upstreamCalls += 1
        return Promise.resolve(new Response(UNREACHED_BODY, { status: 200 }))
      }) as unknown as typeof fetch,
    })
    const result = await new Kiro_Upstream_Provider({ auth, client, strict }).proxy(request)
    return { result, upstreamCalls }
  },
}

const CODEX: UpstreamUnderTest = {
  name: "codex",
  features: CODEX_CAPABILITIES.features,
  resolve: (request, strict) => resolveCodexFeatures(request, { strict }),
  withNotices: withCodexFeatureNotices,
  proxy: async (request, strict) => {
    let upstreamCalls = 0
    const provider = new Codex_Upstream_Provider({
      accessToken: "access",
      refreshToken: "refresh",
      strict,
      fetch: (() => {
        upstreamCalls += 1
        return Promise.resolve(new Response(UNREACHED_BODY, { status: 200 }))
      }) as unknown as typeof fetch,
    })
    return { result: await provider.proxy(request), upstreamCalls }
  },
}

const COPILOT: UpstreamUnderTest = {
  name: "copilot",
  features: COPILOT_CAPABILITIES.features,
  resolve: (request, strict) => resolveCopilotFeatures(request, { strict }),
  withNotices: withCopilotFeatureNotices,
  proxy: async (request, strict) => {
    let upstreamCalls = 0
    const client = {
      proxy: () => {
        upstreamCalls += 1
        return Promise.resolve(new Response(UNREACHED_BODY, { status: 200 }))
      },
    } as unknown as Copilot_Client
    const provider = new Copilot_Upstream_Provider({ auth: {} as unknown as Copilot_Auth_Manager, client, strict })
    return { result: await provider.proxy(request), upstreamCalls }
  },
}

const UPSTREAMS = [KIRO, CODEX, COPILOT] as const

// ---------------------------------------------------------------------------------------------
// Which fields each upstream actually decides, derived from its own declaration
// ---------------------------------------------------------------------------------------------

/**
 * The features of {@link REQUEST_FRAGMENTS} this upstream's resolver records when the request
 * carries that field alone.
 *
 * Measured rather than listed, so a resolver that stops covering a field, or starts covering one,
 * moves the generators here instead of leaving a stale list behind.
 */
function resolvableFeatures(upstream: UpstreamUnderTest): ProviderFeature[] {
  return FRAGMENT_FEATURES.filter((feature) => upstream.resolve(requestFor([feature]), false).resolvedFeatures().has(feature))
}

interface UpstreamFieldSets {
  resolvable: ProviderFeature[]
  reject: ProviderFeature[]
  degrade: ProviderFeature[]
  emulate: ProviderFeature[]
  reporting: ProviderFeature[]
}

function fieldSets(upstream: UpstreamUnderTest): UpstreamFieldSets {
  const resolvable = resolvableFeatures(upstream)
  const withPolicy = (policy: FeaturePolicy) => resolvable.filter((feature) => upstream.features[feature] === policy)
  const reject = withPolicy("reject")
  const degrade = withPolicy("degrade")
  const emulate = withPolicy("emulate")
  return { resolvable, reject, degrade, emulate, reporting: resolvable.filter((feature) => degrade.includes(feature) || emulate.includes(feature)) }
}

const FIELD_SETS = new Map<string, UpstreamFieldSets>(UPSTREAMS.map((upstream) => [upstream.name, fieldSets(upstream)]))

function setsFor(upstream: UpstreamUnderTest): UpstreamFieldSets {
  const sets = FIELD_SETS.get(upstream.name)
  if (!sets) throw new Error(`no field sets for ${upstream.name}`)
  return sets
}

/** A non-empty subset of `pool`, in matrix order, or `undefined` when the pool is empty. */
function subsetArb(pool: readonly ProviderFeature[], minLength: number): fc.Arbitrary<ProviderFeature[]> | undefined {
  if (!pool.length || pool.length < minLength) return undefined
  return fc.uniqueArray(fc.constantFrom(...pool), { minLength, maxLength: pool.length }).map((picked) => pool.filter((feature) => picked.includes(feature)))
}

interface RejectingCase {
  strict: boolean
  requested: ProviderFeature[]
  /** The features whose notice must survive to the result, computed from the declarations. */
  expectedNoticeFeatures: ProviderFeature[]
}

/**
 * Every route to a rejection this upstream's declaration admits.
 *
 * **Unstrict arm** — a non-empty subset of the declared `reject` fields plus any subset of the
 * reporting fields; every reporting notice survives. Empty on Codex and Copilot, which declare no
 * `reject` cell.
 *
 * **Strict arm** — a non-empty subset of the declared `degrade` fields plus any subset of the
 * `emulate` fields; the degrades escalate into the rejection and only the emulate notices survive.
 * This is the only arm Codex and Copilot have, and their `emulate` set is empty, which is exactly
 * why a rejection carrying a notice is unreachable through `proxy()` there.
 */
function rejectingCaseArbs(upstream: UpstreamUnderTest): fc.Arbitrary<RejectingCase>[] {
  const sets = setsFor(upstream)
  const arbs: fc.Arbitrary<RejectingCase>[] = []

  const rejectSubset = subsetArb(sets.reject, 1)
  if (rejectSubset) {
    const reportingSubset = subsetArb(sets.reporting, 0) ?? fc.constant<ProviderFeature[]>([])
    arbs.push(
      fc.tuple(rejectSubset, reportingSubset).map(([rejecting, reporting]) => ({
        strict: false,
        requested: sets.resolvable.filter((feature) => rejecting.includes(feature) || reporting.includes(feature)),
        expectedNoticeFeatures: sets.resolvable.filter((feature) => reporting.includes(feature)),
      })),
    )
  }

  const degradeSubset = subsetArb(sets.degrade, 1)
  if (degradeSubset) {
    const emulateSubset = subsetArb(sets.emulate, 0) ?? fc.constant<ProviderFeature[]>([])
    arbs.push(
      fc.tuple(degradeSubset, emulateSubset).map(([degrading, emulating]) => ({
        strict: true,
        requested: sets.resolvable.filter((feature) => degrading.includes(feature) || emulating.includes(feature)),
        expectedNoticeFeatures: sets.resolvable.filter((feature) => emulating.includes(feature)),
      })),
    )
  }

  return arbs
}

function noticeKey(notice: Canonical_FeatureNotice): string {
  return `${notice.feature}\u0000${notice.detail}`
}

/**
 * The whole upstream half of the property, on one generated request.
 *
 * `expectedNoticeFeatures` is derived from the matrix, so the set clause is independent of the
 * resolver; the order clause is asserted against the recorded decisions, because "in decision order"
 * is a claim about delivery preserving the record rather than about the order itself.
 */
async function assertRejectionCarriesItsNotices(upstream: UpstreamUnderTest, kase: RejectingCase): Promise<void> {
  const request = requestFor(kase.requested)
  const decisions = upstream.resolve(request, kase.strict)
  const rejection = decisions.firstRejection()
  // The body a rejecting `proxy()` returns. Task 14b.7 made that `rejectionReport()` rather than
  // `firstRejection()`, so a request refused over two fields names both; the two are the *same
  // string* whenever the request rejected once, which is the case this clause set is mostly about.
  const reported = decisions.rejectionReport()
  const { result, upstreamCalls } = await upstream.proxy(request, kase.strict)

  // The generator only builds rejecting requests; if this fails the declaration moved.
  expect(rejection, `${upstream.name}: ${kase.requested.join(",")} strict=${kase.strict} did not reject`).toBeDefined()
  if (!rejection) return

  // Requirement 10.11 — the 400, the feature it names, and no spent upstream request.
  expect(result.type).toBe("canonical_error")
  if (result.type !== "canonical_error") return
  expect(result.status).toBe(400)
  expect(result.body).toContain(rejection.feature)
  expect(kase.requested).toContain(rejection.feature)
  expect(upstreamCalls).toBe(0)

  // Requirement 10.8 — resolution did not stop at the rejection, so the account is complete.
  expect([...decisions.resolvedFeatures()].sort()).toEqual([...kase.requested].sort())

  const delivered = result.featureNotices ?? []

  if (!kase.expectedNoticeFeatures.length) {
    // Requirement 10.12 — omitted rather than empty, and otherwise the error this request
    // produced before 14b existed: the four members `canonicalError()` builds, nothing more.
    expect("featureNotices" in result).toBe(false)
    expect(Object.keys(result).sort()).toEqual(["body", "headers", "status", "type"])
    expect(result).toEqual({ type: "canonical_error", status: 400, headers: new Headers(), body: reported!.message })
    // The clause this replaced compared `body` against `firstRejection().message`, which is the
    // same string for a request rejected once and drops the further rejections' names for a request
    // rejected twice — the gap task 14b.7 closes (Property 42). Still an exact-shape check, still
    // "the error this request produced with the notice member omitted rather than empty": what
    // changed is which of the two rejection accessors the body is compared against, not how
    // strictly it is compared.
    if (decisions.rejections().length === 1) expect(result.body).toBe(rejection.message)
    return
  }

  // Requirement 10.11 — every recorded notice is on the result, in decision order, exactly once.
  expect(delivered.map((notice) => notice.feature)).toEqual(kase.expectedNoticeFeatures)
  expect(delivered.map((notice) => notice.feature)).toEqual(decisions.notices().map((notice) => notice.feature))
  expect(delivered).toEqual(decisions.notices())
  expect(new Set(delivered.map(noticeKey)).size).toBe(delivered.length)

  for (const notice of delivered) {
    // The policy a notice reports is the declared cell, and never the rejecting one — a `reject`
    // travels the 400, not the notice list (Requirement 8.6). Compared as strings because the two
    // vocabularies differ on purpose: `FeaturePolicy` has four members, a notice's policy two.
    expect<string>(notice.policy).toBe(upstream.features[notice.feature])
    expect(notice.policy === "degrade" || notice.policy === "emulate").toBe(true)
    expect(notice.detail.length).toBeGreaterThan(0)
    expect(notice.feature).not.toBe(rejection.feature)
  }
}

// ---------------------------------------------------------------------------------------------
// The upstream half
// ---------------------------------------------------------------------------------------------

describe("Property 41 — the upstream rejection path", () => {
  for (const upstream of UPSTREAMS) {
    const arbs = rejectingCaseArbs(upstream)

    test(`Feature: native-api-mode, Property 41: a ${upstream.name} rejection reports every other outcome the request decided, exactly once`, async () => {
      // A declaration with neither a `reject` nor a `degrade` cell among its request-resolved
      // fields would make this test silently cover nothing.
      expect(arbs.length).toBeGreaterThan(0)

      await fc.assert(
        fc.asyncProperty(fc.oneof(...arbs), async (kase) => {
          await assertRejectionCarriesItsNotices(upstream, kase)
        }),
        { numRuns: 150 },
      )
    })
  }

  /**
   * Anti-vacuity, per upstream, written against what each declaration actually admits rather than
   * against one combination assumed reachable everywhere. See the file header: on Codex and Copilot
   * a rejection carrying a notice cannot exist today, so this clause records the emptiness that
   * makes it so and fails the day that changes without this file being revisited.
   */
  test("Feature: native-api-mode, Property 41: the generated requests reach every combination each declaration admits", async () => {
    for (const upstream of UPSTREAMS) {
      const sets = setsFor(upstream)
      const seen = { withNotices: new Set<boolean>(), strict: new Set<boolean>(), rejected: new Set<boolean>() }

      await fc.assert(
        fc.asyncProperty(fc.oneof(...rejectingCaseArbs(upstream)), async (kase) => {
          const { result } = await upstream.proxy(requestFor(kase.requested), kase.strict)
          seen.rejected.add(result.type === "canonical_error")
          seen.withNotices.add(result.type === "canonical_error" && (result.featureNotices?.length ?? 0) > 0)
          seen.strict.add(kase.strict)
        }),
        { numRuns: 150 },
      )

      // Every generated request really did reject; none of the clauses above ran on a 200.
      expect(seen.rejected, upstream.name).toEqual(new Set([true]))

      if (sets.reject.length) {
        // Kiro today: both routes exist, and both "with notices" and "without notices" are reached.
        expect(seen.strict, upstream.name).toEqual(new Set([false, true]))
        expect(seen.withNotices, upstream.name).toEqual(new Set([false, true]))
      } else {
        // Codex and Copilot today. Strict mode is the only route to a rejection, and it escalates
        // every `degrade` at once while no `emulate` cell exists to leave a survivor — so
        // "rejection without notices" is the only reachable combination, and saying otherwise
        // would be asserting a combination the declaration forbids.
        expect(sets.emulate, upstream.name).toEqual([])
        expect(seen.strict, upstream.name).toEqual(new Set([true]))
        expect(seen.withNotices, upstream.name).toEqual(new Set([false]))
      }
    }

    // The shape of the finding above, stated as a fact about the declarations so a cell that moves
    // is caught here rather than by a clause quietly covering less.
    expect(setsFor(KIRO).reject.length).toBeGreaterThan(0)
    expect(setsFor(CODEX).reject).toEqual([])
    expect(setsFor(COPILOT).reject).toEqual([])
    for (const upstream of UPSTREAMS) expect(setsFor(upstream).degrade.length).toBeGreaterThan(0)
  })

  /**
   * The with-notices delivery on all three upstreams (Requirement 10.13), asserted at the one site
   * 14b.2 routed every rejection return through. This is the clause that covers Codex and Copilot,
   * where `proxy()` cannot produce the combination today, and it is the same function the Kiro
   * `proxy()` arm above exercises end-to-end.
   */
  test("Feature: native-api-mode, Property 41: every upstream's rejection channel carries the notices and touches nothing else", () => {
    const noticeArb = fc.record({
      feature: fc.constantFrom(...FRAGMENT_FEATURES),
      policy: fc.constantFrom<Canonical_FeatureNotice["policy"]>("degrade", "emulate"),
      detail: fc.string({ minLength: 1, maxLength: 60 }),
    })

    fc.assert(
      fc.property(
        fc.constantFrom(...UPSTREAMS),
        fc.array(noticeArb, { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 400, max: 599 }),
        fc.string({ minLength: 1, maxLength: 80 }),
        (upstream, notices, status, body) => {
          const headers = new Headers({ "x-test": "1" })
          const error: Canonical_ErrorResponse = { type: "canonical_error", status, headers, body }
          const delivered = upstream.withNotices(error, notices)

          expect(delivered.type).toBe("canonical_error")
          if (delivered.type !== "canonical_error") return
          // A copy, so the decision record cannot be reached through the result.
          expect(delivered).not.toBe(error)
          expect(delivered.featureNotices).toEqual(notices)
          expect(delivered.featureNotices).not.toBe(notices)
          // Status, headers and body are what the producer built (Requirement 8.7).
          expect(delivered.status).toBe(status)
          expect(delivered.headers).toBe(headers)
          expect(delivered.body).toBe(body)
          expect(Object.keys(delivered).sort()).toEqual(["body", "featureNotices", "headers", "status", "type"])
          // Requirement 10.12 at this site: no notice means the same object, not an empty array.
          expect(upstream.withNotices(error, [])).toBe(error)
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------------------------
// The inbound half
// ---------------------------------------------------------------------------------------------

const ERROR_BODY = "This upstream does not support sampling: temperature=0.3 was not sent upstream. Use an upstream that honors generation controls instead."

/** Details that survive the harness parser: single-line, non-blank, no marker of their own. */
const detailArb = fc
  .string({ minLength: 1, maxLength: 70 })
  .map((text) => text.replace(/[\r\n[\]]/g, " "))
  .filter((text) => text.trim().length > 0 && text.trim() === text.replace(/\s+/g, " ").trim())

const inboundNoticeArb: fc.Arbitrary<Canonical_FeatureNotice> = fc.record({
  feature: fc.constantFrom(...FRAGMENT_FEATURES),
  policy: fc.constantFrom<Canonical_FeatureNotice["policy"]>("degrade", "emulate"),
  detail: detailArb,
})

/** Lists that include duplicates on purpose, so the `(feature, detail)` dedup rule is exercised. */
const inboundNoticeListArb: fc.Arbitrary<Canonical_FeatureNotice[]> = fc
  .array(inboundNoticeArb, { minLength: 1, maxLength: 5 })
  .chain((notices) => fc.array(fc.constantFrom(...notices), { maxLength: 3 }).map((extra) => [...notices, ...extra]))

function erroringUpstream(featureNotices?: Canonical_FeatureNotice[]) {
  return {
    proxy: () =>
      Promise.resolve({
        type: "canonical_error" as const,
        status: 400,
        headers: new Headers(),
        body: ERROR_BODY,
        ...(featureNotices ? { featureNotices } : {}),
      }),
    inputTokens: () => Promise.resolve(Response.json({ object: "response.input_tokens", input_tokens: 1 })),
    checkHealth: () => Promise.resolve({ ok: true }),
  }
}

interface InboundUnderTest {
  readonly name: string
  /** The prose field the notice-free error would have carried, so "ahead of it" is checkable. */
  baseMessage(): string
  render(notices: readonly Canonical_FeatureNotice[]): string
  prepend(text: string, warning: string): string
  errorFor(notices?: Canonical_FeatureNotice[], onProxy?: (log: RequestProxyLog) => void): Promise<{ response: Response; text: string }>
}

const CLAUDE_INBOUND: InboundUnderTest = {
  name: "claude",
  baseMessage: () => claudeUpstreamErrorMessage(400, ERROR_BODY),
  render: renderClaudeFeatureWarning,
  prepend: prependClaudeWarning,
  errorFor: async (notices, onProxy) => {
    const response = await new Claude_Inbound_Provider().handle(
      new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) }),
      { path: "/v1/messages", method: "POST" },
      erroringUpstream(notices),
      { requestId: "req_reject_notices", logBody: false, quiet: true, ...(onProxy ? { onProxy } : {}) },
    )
    return { response, text: await response.text() }
  },
}

const OPENAI_INBOUND: InboundUnderTest = {
  name: "openai",
  baseMessage: () => ERROR_BODY,
  render: renderOpenAIFeatureWarning,
  prepend: prependOpenAIWarning,
  errorFor: async (notices, onProxy) => {
    const response = await new OpenAI_Inbound_Provider({ passthrough: false }).handle(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }),
      { path: "/v1/responses", method: "POST" },
      erroringUpstream(notices),
      { requestId: "req_reject_notices", logBody: false, quiet: true, ...(onProxy ? { onProxy } : {}) },
    )
    return { response, text: await response.text() }
  },
}

const INBOUNDS = [CLAUDE_INBOUND, OPENAI_INBOUND] as const

function markerCount(text: string): number {
  return text.split("[gateway]").length - 1
}

function dedupedDegrades(notices: readonly Canonical_FeatureNotice[]): Array<{ feature: string; detail: string }> {
  const seen = new Set<string>()
  const rows: Array<{ feature: string; detail: string }> = []
  for (const notice of notices) {
    if (notice.policy !== "degrade") continue
    const detail = notice.detail.replace(/\s+/g, " ").trim()
    const key = `${notice.feature}\u0000${detail}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ feature: notice.feature, detail })
  }
  return rows
}

describe("Property 41 — the inbound error response", () => {
  for (const inbound of INBOUNDS) {
    test(`Feature: native-api-mode, Property 41: the ${inbound.name} error body carries one warning segment ahead of the message it already had`, async () => {
      const plain = await inbound.errorFor()
      const plainBody = JSON.parse(plain.text) as { error: { message: string; type: string } }

      await fc.assert(
        fc.asyncProperty(inboundNoticeListArb, async (notices) => {
          const { response, text } = await inbound.errorFor(notices)
          const body = JSON.parse(text) as { error: { message: string; type: string } }
          const expected = dedupedDegrades(notices)

          expect(response.status).toBe(plain.response.status)

          if (!expected.length) {
            // Requirement 9.8, and Requirement 9.2 on this path: an `emulate`-only error renders
            // byte-identically to the notice-free one.
            expect(text).toBe(plain.text)
            return
          }

          // Requirement 9.7 — one combined segment, leading the message that would have been
          // rendered without the notices, which is still there unchanged behind it.
          expect(markerCount(text)).toBe(1)
          expect(body.error.message).toBe(inbound.prepend(inbound.baseMessage(), inbound.render(notices)))
          expect(body.error.message.endsWith(inbound.baseMessage())).toBe(true)
          expect(body.error.message.indexOf("[gateway]")).toBe(0)

          // Every `degrade` named exactly once, deduped by `(feature, detail)`, read back through
          // the parser the harness uses.
          expect(textNotices(body.error.message)).toEqual(expected.map((row) => ({ ...row, source: "text" })))

          // Zero members, block types, SSE event names, and headers the notice-free error lacks.
          expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(Object.keys(JSON.parse(plain.text) as object).sort())
          expect(Object.keys(body.error).sort()).toEqual(Object.keys(plainBody.error).sort())
          expect(body.error.type).toBe(plainBody.error.type)
          expect([...response.headers.keys()].sort()).toEqual([...plain.response.headers.keys()].sort())
          expect(text).not.toContain("event:")
          expect(text).not.toContain("data:")
        }),
        { numRuns: 120 },
      )
    })

    test(`Feature: native-api-mode, Property 41: a notice-free ${inbound.name} error is unchanged, and its notices still reach telemetry`, async () => {
      const plainLogs: RequestProxyLog[] = []
      const plain = await inbound.errorFor(undefined, (log) => plainLogs.push(log))

      // Requirement 8.8's presence semantics on the error path: a request that recorded nothing
      // reports `featureNotices` as absent, and still reports `providerCredits` as "not measured"
      // rather than 0 — a rejected request made no upstream call and spent nothing.
      expect(plainLogs[0]?.telemetry?.featureNotices).toBeUndefined()
      expect(plainLogs[0]?.telemetry && "providerCredits" in plainLogs[0].telemetry).toBe(true)
      expect(plainLogs[0]?.telemetry?.providerCredits).toBeUndefined()

      await fc.assert(
        fc.asyncProperty(
          fc.array(inboundNoticeArb, { minLength: 1, maxLength: 4 }).map((notices) => notices.map((notice) => ({ ...notice, policy: "emulate" as const }))),
          async (notices) => {
            const logs: RequestProxyLog[] = []
            const { text } = await inbound.errorFor(notices, (log) => logs.push(log))

            // Requirement 9.8 — nothing visible changes.
            expect(text).toBe(plain.text)
            // Requirement 8.8 — and the account is still delivered, unrendered and undeduped.
            expect(logs[0]?.telemetry?.featureNotices).toEqual(notices)
            expect(logs[0]?.telemetry && "providerCredits" in logs[0].telemetry).toBe(true)
          },
        ),
        { numRuns: 100 },
      )
    })
  }
})
