// Feature: native-api-mode, Property 27: Hosted tool handling comes from the matrix and never
// throws.
//
// **Validates: Requirements 19.1, 19.2, 19.4, 19.5, 19.6**
//
// ## Why this file knows the whole key set
//
// The ten Responses hosted tool type names are duplicated in three `capabilities.ts` files on
// purpose, so that no Responses type name enters `src/core/` (design, `HostedToolPolicyMap`).
// Duplication needs one place that holds the copies to each other, and task 29.4 designates this
// file as that place: it is **the one test allowed to know the whole cross-provider key set**.
// `test/upstream/capabilities.property.test.ts` deliberately stays name-free and asserts only that
// the three key sets are equal to each other; the names themselves are written out below, once.
//
// ## The three clauses, and where each is observed
//
//   1. **The outcome equals the declared policy for that type.** Observed through the real
//      resolvers — `resolveCodexHostedTools()`, `resolveCopilotHostedTools()`, and now
//      `resolveKiroHostedTools()` — on a `FeatureDecisions`, because those are the objects an
//      upstream's `proxy()` reads to build a response.
//   2. **A type declared native on Codex is forwarded with its original `type`, and not passed
//      through the function-tool converter.** Observed on `forwardCodexHostedTools()` and on the
//      body `canonicalToCodexBody()` emits — the bytes, not an intention.
//   3. **A type absent from the matrix produces a notice and a terminal state without throwing.**
//      Observed twice: on the decisions object, and end-to-end through `Codex_Upstream_Provider`
//      with a stubbed fetch, because "reaches a terminal state" is a claim about a returned result
//      rather than about bookkeeping.
//
// ## Kiro, now wired
//
// The Kiro half of task 29.3 replaced `validateUnsupportedServerTools()` (`src/upstream/kiro/index.ts`)
// with a `resolveKiroHostedTools()` call on the same `FeatureDecisions` the request-shaped features
// use, so the `kiro` row below carries a `resolve` like the other two and clause 1 covers all three
// upstreams through the code an upstream's `proxy()` actually runs.
//
// {@link resolveThroughDeclaration} is kept, and is no longer Kiro's only reachable layer: it is the
// composition the wiring performs, and the `code_interpreter` → Kiro unit asserts *both* — the
// declaration layer and the `proxy()` result — so a divergence between what the matrix says and what
// a client receives fails rather than hides.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import path from "node:path"

import type { Canonical_Request } from "../../src/core/canonical"
import { isCanonicalWebFetchToolType } from "../../src/core/canonical-tools"
import { FeatureDecisions } from "../../src/core/feature-decisions"
import { resolveFeature, resolveHostedToolPolicy } from "../../src/core/feature-policy"
import type { FeaturePolicy, ProviderFeature } from "../../src/core/provider-capabilities"
import type { HostedToolPolicyMap } from "../../src/core/provider-capabilities"
import type { JsonObject } from "../../src/core/types"
import { Codex_Upstream_Provider } from "../../src/upstream/codex"
import { CODEX_CAPABILITIES, CODEX_UNDECLARED_HOSTED_TOOL_POLICY } from "../../src/upstream/codex/capabilities"
import { forwardCodexHostedTools, resolveCodexHostedTools } from "../../src/upstream/codex/hosted-tools"
import { canonicalToCodexBody } from "../../src/upstream/codex/parse"
import { COPILOT_CAPABILITIES, COPILOT_UNDECLARED_HOSTED_TOOL_POLICY } from "../../src/upstream/copilot/capabilities"
import { resolveCopilotHostedTools } from "../../src/upstream/copilot/hosted-tools"
import { Kiro_Auth_Manager, Kiro_Client, Kiro_Upstream_Provider } from "../../src/upstream/kiro"
import { KIRO_CAPABILITIES, KIRO_UNDECLARED_HOSTED_TOOL_POLICY } from "../../src/upstream/kiro/capabilities"
import { resolveKiroHostedTools } from "../../src/upstream/kiro/hosted-tools"
import { sse } from "../helpers"

/**
 * The ten Responses hosted tool type names — the cross-provider key set, written out once, here.
 *
 * Not imported from any `capabilities.ts`: reading the names off the map under test would make the
 * clauses below tautological, because a type dropped from all three declarations would vanish from
 * this list too and every assertion would still pass. The equality between this list and each
 * declaration is asserted instead.
 */
const HOSTED_TOOL_TYPES = [
  "image_generation",
  "web_search",
  "web_search_preview",
  "file_search",
  "computer",
  "computer_use_preview",
  "code_interpreter",
  "mcp",
  "local_shell",
  "tool_search",
] as const

/** How one upstream's hosted tool handling is reachable from a test. */
interface UpstreamRow {
  name: string
  hostedTools: HostedToolPolicyMap
  /** The policy a type absent from {@link hostedTools} falls back to (Requirement 19.4). */
  fallback: FeaturePolicy
  /** The declared feature policies, needed to build a `FeatureDecisions` for this upstream. */
  features: Readonly<Record<ProviderFeature, FeaturePolicy>>
  /**
   * The provider's own hosted tool resolver — the function that upstream's `proxy()` calls.
   *
   * Optional in the type only so a future upstream can be added to the census before its resolver
   * exists; all three rows carry one today.
   */
  resolve?: (tools: Canonical_Request["tools"], decisions: FeatureDecisions) => void
}

const UPSTREAMS: readonly UpstreamRow[] = [
  {
    name: "codex",
    hostedTools: CODEX_CAPABILITIES.hostedTools!,
    fallback: CODEX_UNDECLARED_HOSTED_TOOL_POLICY,
    features: CODEX_CAPABILITIES.features,
    resolve: resolveCodexHostedTools,
  },
  {
    name: "copilot",
    hostedTools: COPILOT_CAPABILITIES.hostedTools!,
    fallback: COPILOT_UNDECLARED_HOSTED_TOOL_POLICY,
    features: COPILOT_CAPABILITIES.features,
    resolve: resolveCopilotHostedTools,
  },
  {
    name: "kiro",
    hostedTools: KIRO_CAPABILITIES.hostedTools!,
    fallback: KIRO_UNDECLARED_HOSTED_TOOL_POLICY,
    features: KIRO_CAPABILITIES.features,
    resolve: resolveKiroHostedTools,
  },
]

function canonicalRequest(tools?: JsonObject[]): Canonical_Request {
  return {
    model: "gpt-5.4",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    passthrough: false,
    metadata: {},
    ...(tools && { tools }),
  }
}

/**
 * What a caller can see after one hosted tool type was resolved: the notice, the rejection, or
 * neither.
 *
 * Read off the three signals a `proxy()` uses, deliberately not off the feature the decision was
 * recorded under — which `ProviderFeature` a hosted tool decision is attributed to is the provider
 * module's business, and a test that pinned it would fail on a re-attribution that changed nothing
 * a client can observe.
 */
function observe(decisions: FeatureDecisions): { kind: FeaturePolicy; message?: string; detail?: string } {
  const rejection = decisions.firstRejection()
  const notices = decisions.notices()

  // Exactly one signal, never two: a hosted tool type lands on one outcome.
  expect(Number(Boolean(rejection)) + notices.length).toBeLessThanOrEqual(1)

  if (rejection) return { kind: "reject", message: rejection.message }
  const notice = notices[0]
  if (notice) return { kind: notice.policy, detail: notice.detail }
  return { kind: "native" }
}

/**
 * The declaration layer on its own: the declared cell, resolved by core.
 *
 * The two calls `resolveKiroHostedTools()` makes, without the provider module in between. Not a
 * second implementation of the resolvers — it makes no lookup decisions of its own beyond the
 * documented absent-type fallback — so pairing it with a `proxy()` result shows the module adds no
 * decision of its own.
 */
function resolveThroughDeclaration(row: UpstreamRow, type: string, strict = false) {
  const declared = resolveHostedToolPolicy(row.hostedTools, type)
  return resolveFeature({
    feature: "mcpToolset",
    policy: declared ?? row.fallback,
    detail: `the '${type}' tool cannot be run as sent`,
    alternative: "a client function tool",
    strict,
  })
}

const hostedType = fc.constantFrom(...HOSTED_TOOL_TYPES)

/**
 * A type name no upstream declares.
 *
 * Filtered against the key set above rather than against one map, so the generator cannot
 * accidentally produce a declared name for one upstream and an undeclared one for another and make
 * the clause read as flaky. `function` is excluded because a function tool is not a hosted tool at
 * all, and the two inherited property names are excluded because `resolveHostedToolPolicy()`
 * already reads them as absent for a different reason (its own test owns that claim).
 *
 * A canonical fetch spelling is excluded too, and for a reason worth stating: `web_fetch` is absent
 * from all three `hostedTools` maps, but it is **not** an undeclared type — all three resolvers route
 * it to the declared `features.webFetch` cell instead, because the canonical vocabulary carries the
 * fetch (`src/core/canonical-tools.ts`) while this protocol's hosted vocabulary does not. Leaving it
 * in the generator would make the clause assert the fallback for a type that has a declaration.
 */
const undeclaredType = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter(
    (value) =>
      value.trim().length > 0 &&
      !(HOSTED_TOOL_TYPES as readonly string[]).includes(value) &&
      value !== "function" &&
      !isCanonicalWebFetchToolType(value),
  )

describe("Property 27 — hosted tool handling comes from the matrix", () => {
  /**
   * The premise the whole file rests on: the ten names above are exactly what each upstream
   * declares. Without this, every clause below could pass over a shrunken matrix.
   *
   * **Validates: Requirements 19.1, 19.2**
   */
  test("Feature: native-api-mode, Property 27: each upstream declares exactly the ten hosted tool types", () => {
    for (const row of UPSTREAMS) {
      expect(Object.keys(row.hostedTools).sort(), `${row.name} hostedTools key set`).toEqual([...HOSTED_TOOL_TYPES].sort())
    }
  })

  /**
   * Clause 1 — for any hosted tool type and any upstream, the outcome equals the declared policy.
   *
   * Codex and Copilot through their own resolvers; Kiro through the declared cell composed with
   * core's resolution, which is the layer reachable without the `validateUnsupportedServerTools()`
   * wiring. A refusing cell additionally names an alternative, which is Requirement 19.3's half of
   * the same lookup.
   *
   * **Validates: Requirements 19.2, 19.3, 19.5**
   */
  test("Feature: native-api-mode, Property 27: the outcome equals the declared policy for that type", () => {
    fc.assert(
      fc.property(hostedType, fc.constantFrom(...UPSTREAMS.map((row) => row.name)), (type, upstreamName) => {
        const row = UPSTREAMS.find((entry) => entry.name === upstreamName)!
        const declared = row.hostedTools[type]
        expect(declared, `${row.name} declares ${type}`).toBeTruthy()

        if (row.resolve) {
          const decisions = new FeatureDecisions(row.features, false)
          row.resolve([{ type }], decisions)
          const observed = observe(decisions)
          expect(observed.kind, `${row.name}/${type}`).toBe(declared!)
          if (observed.message) expect(observed.message).toMatch(/Use .+ instead\./)
          if (observed.detail) expect(observed.detail.trim().length).toBeGreaterThan(0)
          return
        }

        // Kiro: the declaration layer, until the wiring lands.
        const outcome = resolveThroughDeclaration(row, type)
        expect(outcome.kind, `${row.name}/${type}`).toBe(declared!)
        if (outcome.kind === "reject") expect(outcome.message).toMatch(/Use .+ instead\./)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * Clause 2 — a type declared `native` on Codex is forwarded with its original `type`, and is not
   * passed through the function-tool converter.
   *
   * "Not converted" is asserted structurally rather than by calling
   * `claudeFunctionToolToResponsesTool()`: that function is module-private to
   * `src/inbound/claude/server-tools.ts`, and an upstream test importing an inbound module would
   * cross the layer boundary the architecture test forbids. Its output shape is fixed and public
   * knowledge — `{ type: "function", name, description, parameters, strict }` — so a forwarded tool
   * that keeps its own `type` and gains none of those four fields cannot have been through it.
   *
   * The extra client-supplied fields in the generator matter: a converter would drop them. Their
   * survival is what separates "forwarded" from "rebuilt with the same type".
   *
   * **Validates: Requirements 19.1, 19.6**
   */
  test("Feature: native-api-mode, Property 27: a native hosted tool is forwarded with its own type, unconverted", () => {
    fc.assert(
      fc.property(hostedType, fc.dictionary(fc.constantFrom("server_label", "container", "filters", "vector_store_ids"), fc.string(), { maxKeys: 3 }), (type, extras) => {
        expect(CODEX_CAPABILITIES.hostedTools![type], `codex declares ${type} native`).toBe("native")

        const tool = { type, ...extras } as JsonObject
        const forwarded = forwardCodexHostedTools([tool])!

        // The object on the wire is the object the client sent.
        expect(forwarded).toHaveLength(1)
        expect(forwarded[0]).toBe(tool)
        expect(forwarded[0]!.type).toBe(type)

        // …and the body carries it, so this is a fact about bytes rather than about a helper.
        const body = canonicalToCodexBody(canonicalRequest([tool]))
        const bodyTools = body.tools as JsonObject[]
        expect(bodyTools).toEqual([tool])
        expect(bodyTools[0]!.type).toBe(type)

        // None of the four fields the function-tool converter always writes.
        for (const injected of ["name", "description", "parameters", "strict"]) {
          expect(Object.hasOwn(bodyTools[0]!, injected), `${type} gained ${injected}`).toBe(false)
        }
        // Every client-supplied field survived.
        for (const [key, value] of Object.entries(extras)) expect(bodyTools[0]![key]).toBe(value)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * Clause 3 — a type absent from the matrix produces a notice, and no rejection, on every upstream
   * whose resolver is wired.
   *
   * The absence of a rejection is the load-bearing half: Requirement 19.4 says an unknown type
   * completes the request. A 400 would also be "handled", and would be the wrong answer.
   *
   * **Validates: Requirements 19.4, 19.5**
   */
  test("Feature: native-api-mode, Property 27: a type absent from the matrix produces a notice and no rejection", () => {
    fc.assert(
      fc.property(undeclaredType, fc.constantFrom(...UPSTREAMS.filter((row) => row.resolve).map((row) => row.name)), (type, upstreamName) => {
        const row = UPSTREAMS.find((entry) => entry.name === upstreamName)!
        expect(resolveHostedToolPolicy(row.hostedTools, type)).toBeUndefined()

        const decisions = new FeatureDecisions(row.features, false)
        row.resolve!([{ type }], decisions)
        const observed = observe(decisions)

        expect(decisions.firstRejection(), `${row.name}/${type} refused an undeclared type`).toBeUndefined()
        expect(observed.kind).toBe(row.fallback)
        expect(observed.detail).toContain(type)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * Clause 3, end to end — an undeclared hosted tool type reaches a terminal state without
   * throwing.
   *
   * Through `Codex_Upstream_Provider.proxy()` with a stubbed fetch, because "completes the request
   * without throwing" is a claim about a returned result. The notice rides on that result, so the
   * client both gets its answer and is told what happened to the tool.
   *
   * **Validates: Requirements 19.4**
   */
  test("Feature: native-api-mode, Property 27: an undeclared hosted tool still completes the request", async () => {
    const completed = sse([
      { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
    ])

    await fc.assert(
      fc.asyncProperty(undeclaredType, async (type) => {
        const provider = new Codex_Upstream_Provider({
          accessToken: "access",
          refreshToken: "refresh",
          fetch: (() => Promise.resolve(new Response(completed, { status: 200 }))) as unknown as typeof fetch,
        })

        const result = await provider.proxy(canonicalRequest([{ type }]))

        expect(result.type).toBe("canonical_response")
        if (result.type !== "canonical_response") return
        expect(result.featureNotices?.length).toBe(1)
        expect(result.featureNotices![0]!.detail).toContain(type)
      }),
      { numRuns: 100 },
    )
  })

  /**
   * Unit (Requirement 19.6) — `code_interpreter` sent to Codex is not converted by
   * `claudeFunctionToolToResponsesTool()`.
   *
   * The named case the requirement asks for, on the body rather than on a helper. Same structural
   * argument as clause 2: the converter's output always has `type: "function"` and always carries
   * `name`, `description`, `parameters`, and `strict`; this tool has its own type and none of them.
   */
  test("Feature: native-api-mode, Property 27: code_interpreter to Codex keeps its type and gains no function-tool fields", () => {
    const tool = { type: "code_interpreter", container: { type: "auto" } } as JsonObject
    const body = canonicalToCodexBody(canonicalRequest([tool]))

    expect(body.tools).toEqual([tool])
    const forwarded = (body.tools as JsonObject[])[0]!
    expect(forwarded.type).toBe("code_interpreter")
    expect(forwarded.type).not.toBe("function")
    expect(Object.keys(forwarded).sort()).toEqual(["container", "type"])
    // And the matrix agrees this is the native forward, not an accident of the body builder.
    expect(CODEX_CAPABILITIES.hostedTools!.code_interpreter).toBe("native")
  })

  /**
   * Unit (Requirements 19.2, 19.3) — the same tool sent to Kiro returns a 400 naming an
   * alternative.
   *
   * Asserted twice, at both ends of the wiring task 29.3 landed:
   *
   *  - the **declaration layer** — the declared cell plus core's resolution of it, which is the
   *    composition `resolveKiroHostedTools()` performs;
   *  - and the **response** — `Kiro_Upstream_Provider.proxy()` returning a `canonical_error` of
   *    status 400 whose body is that same message, with zero upstream calls.
   *
   * Both, rather than only the second, because the pair is what shows the provider module contributes
   * no decision of its own: if it ever hardcoded a refusal, the two would still agree on the status
   * and disagree on the message.
   */
  test("Feature: native-api-mode, Property 27: code_interpreter to Kiro refuses with an alternative", async () => {
    const kiro = UPSTREAMS.find((row) => row.name === "kiro")!

    expect(resolveHostedToolPolicy(kiro.hostedTools, "code_interpreter")).toBe("reject")

    const outcome = resolveThroughDeclaration(kiro, "code_interpreter")
    expect(outcome.kind).toBe("reject")
    if (outcome.kind !== "reject") return
    // The 400 body a caller sends back: it names what failed and what to do instead.
    expect(outcome.message).toMatch(/Use .+ instead\./)
    expect(outcome.message.length).toBeGreaterThan(0)

    // …and the same request through `proxy()` produces exactly that 400, before any upstream call.
    const { provider, upstreamCalls } = kiroProvider()
    const result = await provider.proxy(canonicalRequest([{ type: "code_interpreter", container: { type: "auto" } }]))

    expect(result.type).toBe("canonical_error")
    if (result.type !== "canonical_error") return
    expect(result.status).toBe(400)
    expect(result.body).toMatch(/Use .+ instead\./)
    expect(result.body).toContain("code_interpreter")
    expect(upstreamCalls()).toBe(0)

    // The divergence from Codex is a difference between two declarations, nothing else.
    expect(CODEX_CAPABILITIES.hostedTools!.code_interpreter).toBe("native")
  })
})

/**
 * A Kiro provider whose transport is a counter, so "no upstream call" is observable.
 *
 * The same construction `test/upstream/no-silent-drop.test.ts` uses: a real `Kiro_Auth_Manager` over
 * in-memory credentials that expire well past the test, and a `Kiro_Client` whose `fetch` records
 * calls. Nothing reads the filesystem and nothing leaves the process.
 */
function kiroProvider() {
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

/**
 * Requirement 19.5's negative half — the hosted tool path selects handling from the matrix, and
 * there is no provider-name branch on it.
 *
 * A source scan, because that is the only way to assert an absence of a branch. Scope is the files
 * that make a hosted tool decision: the three provider modules and core's lookup. Deliberately
 * **not** each provider's `index.ts` — `providerKind = "codex"` lives there, it is a registry label
 * rather than a branch, and including the file would turn this into an assertion about naming.
 *
 * Comments are stripped before the scan, because these files legitimately *discuss* the other
 * upstreams in prose (that is how a reader learns why Codex forwards what Kiro refuses). The
 * stripping is regex-based and would mishandle a `//` inside a regular-expression literal; none of
 * the scanned files contains one, and the failure mode is a false negative in a file this test also
 * proves is non-empty.
 */
describe("Property 27 — no provider-name branch on the hosted tool path", () => {
  const HOSTED_TOOL_PATH = [
    "src/upstream/codex/hosted-tools.ts",
    "src/upstream/copilot/hosted-tools.ts",
    "src/upstream/kiro/hosted-tools.ts",
    "src/core/feature-policy.ts",
  ] as const

  /** The four provider identifiers, as a comparison would spell them. */
  const PROVIDER_NAMES = ["codex", "kiro", "copilot", "claude"] as const

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
  }

  test("Feature: native-api-mode, Property 27: no file on the hosted tool path compares against a provider name", async () => {
    for (const file of HOSTED_TOOL_PATH) {
      const source = await readFile(path.join(process.cwd(), file), "utf8")
      const code = stripComments(source)

      // Anti-vacuity: the file exists, has code left after stripping, and really is on the path.
      expect(code.trim().length, `${file} has no code`).toBeGreaterThan(200)
      expect(code, `${file} is on the hosted tool path`).toContain("HostedTool")

      for (const name of PROVIDER_NAMES) {
        const quoted = new RegExp(`(["'\`])${name}\\1`, "i")
        expect(quoted.test(code), `${file} compares against the provider name '${name}'`).toBe(false)
      }
      // `providerKind` is the registry label; reading it here would be selecting handling from the
      // provider's identity rather than from its declaration.
      expect(code.includes("providerKind"), `${file} reads providerKind`).toBe(false)
    }
  })
})
