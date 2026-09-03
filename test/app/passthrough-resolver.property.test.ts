// Feature: native-api-mode, Property 18: Passthrough is exactly the four-way conjunction.
//
// For any route path, provider kind, stream flag, and opt-in flag, the passthrough resolver returns
// true if and only if the route path is `/v1/responses`, the provider kind is `codex`, the stream
// flag is true, and the opt-in flag is enabled; the result is independent of every request header
// because the resolver takes none.
//
// **Validates: Requirements 15.1, 15.2, 15.3, 15.6, 15.8, 15.9**
//
// ## The clauses, and why each one is separate
//
//  1. **The explicit truth table** (Requirement 15.9, which asks for it by name) — all sixteen rows
//     of the four conditions met/unmet, then the fully closed grid of 2 route paths x 3 provider
//     kinds x 2 stream values x 2 flag values. The sixteen-row table is the readable artifact; the
//     closed grid is the exhaustive one over the real domains of the two non-boolean inputs.
//  2. **The generative conjunction** (15.1, 15.2) — arbitrary route strings, including near-misses
//     of `/v1/responses`, against the conjunction computed independently of the resolver.
//  3. **`/v1/messages` is always false** (15.3) — stated as its own clause rather than left to fall
//     out of clause 2, because 15.3 names that route specifically.
//  4. **`kiro` and `copilot` are always false** — the provider-kind half of the same guarantee, over
//     the closed `UpstreamProviderKind` union rather than over strings, so a fourth kind added to
//     the union later fails to typecheck here instead of passing silently.
//  5. **The decider agrees with the resolver everywhere** — `passthroughDecider` pre-binds two of
//     the four inputs, so it is a second surface that could disagree. Nothing else asserts it
//     generatively.
//  6. **Header independence** (15.8) — see the note below on what form of evidence this is.
//  7. **The flag half** (15.6) — an environment with `NATIVE_PASSTHROUGH` unset resolves to
//     `flagEnabled: false` and therefore to `false`, even when the other three conditions hold.
//     `readNativeFlags` is the only reader of that variable and lives beside the resolver in
//     `src/app/`, so composing the two here is the join, not a layer violation.
//
// ## Header independence is asserted as evidence, not as a varying input
//
// `resolvePassthrough` takes a single `PassthroughInputs` object with four members and no headers,
// and `PassthroughDecider` is `(routePath, stream) => boolean`. There is therefore no runtime knob
// a test can turn to vary a header, and a clause written as "call it with header A, call it with
// header B, expect the same answer" would be unfalsifiable — it would pass against any
// implementation whatsoever, including one that read `process.env` or a module global.
//
// So the clause is asserted in the three falsifiable forms that are actually available:
//
//  - **Behavioral, over an open world of extra keys.** `PassthroughInputs` is a TypeScript
//     interface, so at runtime an object literal may carry any additional key. The test passes
//     inputs augmented with generated header-shaped keys (`originator`, `user-agent`, `x-api-key`,
//     and arbitrary generated names carrying arbitrary generated values) and asserts the answer is
//     identical to the un-augmented call. This *can* fail: an implementation that reached for
//     `inputs.originator` would be caught. It cannot prove the absence of a header channel that
//     never travels through this argument.
//  - **Structural, over the declared input surface.** The four keys the resolver is allowed to read
//     are enumerated once here as `DECLARED_INPUT_KEYS`, and the test asserts that dropping any one
//     of them changes the answer for at least one point of the grid — i.e. each declared key is
//     load-bearing, so the list is the real surface rather than an aspirational comment. Arity is
//     asserted alongside it: `resolvePassthrough.length === 1` and the bound decider's
//     `length === 2`, so neither signature has room for a header argument.
//  - **Source-text, over the module.** The resolver's own source is read and asserted to contain no
//     header-reading identifier (`headers`, `originator`, `user-agent`, `req.`, `request.`,
//     `process.env`). This is the only one of the three that speaks to a channel other than the
//     argument, and it is a grep, with a grep's limits.
//
// Taken together: the argument shape is proven closed behaviorally, the four declared keys are
// proven load-bearing, and the module is proven not to name a header. Requirement 15.8's real
// enforcement is the type signature itself, which `bun run check` checks; these clauses are the
// runtime evidence that the signature has not been worked around.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { readNativeFlags } from "../../src/app/native-flags"
import { passthroughDecider, resolvePassthrough, type PassthroughInputs } from "../../src/app/passthrough-resolver"
import type { UpstreamProviderKind } from "../../src/core/interfaces"
import { path, readFile } from "../helpers"

/** At least 100 iterations per property (standing constraint); raised where the domain is wide. */
const RUNS = { numRuns: 300 } as const

const PASSTHROUGH_ROUTE = "/v1/responses"
const MESSAGES_ROUTE = "/v1/messages"

/** The closed `UpstreamProviderKind` union, spelled out so a new member breaks this file loudly. */
const ALL_KINDS: readonly UpstreamProviderKind[] = ["codex", "kiro", "copilot"]
const NON_CODEX_KINDS: readonly UpstreamProviderKind[] = ["kiro", "copilot"]

/** Every key the policy is allowed to read. Asserted load-bearing below, not just documented. */
const DECLARED_INPUT_KEYS = ["routePath", "providerKind", "stream", "flagEnabled"] as const

/** The conjunction, restated independently of the implementation so the test is not a tautology. */
function expectedPassthrough(inputs: PassthroughInputs): boolean {
  return inputs.routePath === PASSTHROUGH_ROUTE && inputs.providerKind === "codex" && inputs.stream && inputs.flagEnabled
}

const arbRouteish = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(PASSTHROUGH_ROUTE, MESSAGES_ROUTE) },
  // Near-misses: casing, trailing slash, prefix/suffix, and the path with query or version drift.
  { weight: 3, arbitrary: fc.constantFrom("/v1/Responses", "/V1/RESPONSES", "/v1/responses/", "/v1/responses?stream=true", "/v2/responses", "v1/responses", "/v1/response", "/v1/responsesx", " /v1/responses", "/v1/responses ", "", "/", "/v1/chat/completions", "/v1/models") },
  { weight: 2, arbitrary: fc.string() },
  { weight: 1, arbitrary: fc.webPath() },
)

const arbInputs = fc.record({
  routePath: arbRouteish,
  providerKind: fc.constantFrom(...ALL_KINDS),
  stream: fc.boolean(),
  flagEnabled: fc.boolean(),
})

/** Header-shaped noise: the two identity headers 15.8 names, plus arbitrary generated ones. */
const arbHeaderNoise = fc.dictionary(
  fc.oneof(fc.constantFrom("originator", "user-agent", "x-api-key", "authorization", "headers", "host", "accept"), fc.string({ minLength: 1 })),
  fc.oneof(fc.string(), fc.boolean(), fc.integer(), fc.constant(null)),
  { maxKeys: 6 },
)

describe("Property 18: passthrough is exactly the four-way conjunction", () => {
  // Clause 1a — Requirement 15.9 asks for the explicit four-input truth table. Each input is shown
  // in its met and unmet form, with one representative unmet value per input.
  test("Feature: native-api-mode, Property 18: the explicit sixteen-row four-input truth table", () => {
    const rows: [PassthroughInputs, boolean][] = [
      [{ routePath: PASSTHROUGH_ROUTE, providerKind: "codex", stream: true, flagEnabled: true }, true],
      [{ routePath: PASSTHROUGH_ROUTE, providerKind: "codex", stream: true, flagEnabled: false }, false],
      [{ routePath: PASSTHROUGH_ROUTE, providerKind: "codex", stream: false, flagEnabled: true }, false],
      [{ routePath: PASSTHROUGH_ROUTE, providerKind: "codex", stream: false, flagEnabled: false }, false],
      [{ routePath: PASSTHROUGH_ROUTE, providerKind: "kiro", stream: true, flagEnabled: true }, false],
      [{ routePath: PASSTHROUGH_ROUTE, providerKind: "kiro", stream: true, flagEnabled: false }, false],
      [{ routePath: PASSTHROUGH_ROUTE, providerKind: "kiro", stream: false, flagEnabled: true }, false],
      [{ routePath: PASSTHROUGH_ROUTE, providerKind: "kiro", stream: false, flagEnabled: false }, false],
      [{ routePath: MESSAGES_ROUTE, providerKind: "codex", stream: true, flagEnabled: true }, false],
      [{ routePath: MESSAGES_ROUTE, providerKind: "codex", stream: true, flagEnabled: false }, false],
      [{ routePath: MESSAGES_ROUTE, providerKind: "codex", stream: false, flagEnabled: true }, false],
      [{ routePath: MESSAGES_ROUTE, providerKind: "codex", stream: false, flagEnabled: false }, false],
      [{ routePath: MESSAGES_ROUTE, providerKind: "kiro", stream: true, flagEnabled: true }, false],
      [{ routePath: MESSAGES_ROUTE, providerKind: "kiro", stream: true, flagEnabled: false }, false],
      [{ routePath: MESSAGES_ROUTE, providerKind: "kiro", stream: false, flagEnabled: true }, false],
      [{ routePath: MESSAGES_ROUTE, providerKind: "kiro", stream: false, flagEnabled: false }, false],
    ]

    expect(rows).toHaveLength(16)
    // Exactly one row is true, and it is the all-met row.
    expect(rows.filter(([, expected]) => expected)).toHaveLength(1)
    for (const [inputs, expected] of rows) expect(resolvePassthrough(inputs)).toBe(expected)
  })

  // Clause 1b — the closed grid over the real domains of both non-boolean inputs, so `copilot` and
  // the second route are covered exhaustively rather than by representative.
  test("Feature: native-api-mode, Property 18: the closed grid of both routes, all three kinds, and both booleans", () => {
    const seen: boolean[] = []
    for (const routePath of [PASSTHROUGH_ROUTE, MESSAGES_ROUTE]) {
      for (const providerKind of ALL_KINDS) {
        for (const stream of [true, false]) {
          for (const flagEnabled of [true, false]) {
            const inputs: PassthroughInputs = { routePath, providerKind, stream, flagEnabled }
            const actual = resolvePassthrough(inputs)
            expect(actual).toBe(expectedPassthrough(inputs))
            seen.push(actual)
          }
        }
      }
    }
    expect(seen).toHaveLength(24)
    expect(seen.filter(Boolean)).toHaveLength(1)
  })

  // Clause 2 — Requirements 15.1, 15.2.
  test("Feature: native-api-mode, Property 18: the resolver equals the conjunction for generated inputs", () => {
    fc.assert(
      fc.property(arbInputs, (inputs) => {
        expect(resolvePassthrough(inputs)).toBe(expectedPassthrough(inputs))
      }),
      RUNS,
    )
  })

  // Clause 2b — the "only if" direction stated as its own claim: a true answer pins all four inputs.
  test("Feature: native-api-mode, Property 18: a true result forces all four conditions", () => {
    fc.assert(
      fc.property(arbInputs, (inputs) => {
        if (!resolvePassthrough(inputs)) return
        expect(inputs.routePath).toBe(PASSTHROUGH_ROUTE)
        expect(inputs.providerKind).toBe("codex")
        expect(inputs.stream).toBe(true)
        expect(inputs.flagEnabled).toBe(true)
      }),
      RUNS,
    )
  })

  // Clause 3 — Requirement 15.3.
  test("Feature: native-api-mode, Property 18: /v1/messages is false for every combination of the rest", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_KINDS), fc.boolean(), fc.boolean(), (providerKind, stream, flagEnabled) => {
        expect(resolvePassthrough({ routePath: MESSAGES_ROUTE, providerKind, stream, flagEnabled })).toBe(false)
        expect(passthroughDecider({ providerKind, flagEnabled })(MESSAGES_ROUTE, stream)).toBe(false)
      }),
      RUNS,
    )
  })

  // Clause 4 — the provider-kind half, over the closed union.
  test("Feature: native-api-mode, Property 18: kiro and copilot are false for every route, stream, and flag", () => {
    fc.assert(
      fc.property(fc.constantFrom(...NON_CODEX_KINDS), arbRouteish, fc.boolean(), fc.boolean(), (providerKind, routePath, stream, flagEnabled) => {
        expect(resolvePassthrough({ routePath, providerKind, stream, flagEnabled })).toBe(false)
        expect(passthroughDecider({ providerKind, flagEnabled })(routePath, stream)).toBe(false)
      }),
      RUNS,
    )
  })

  // Clause 5 — the decider is the resolver with two inputs pre-bound, everywhere.
  test("Feature: native-api-mode, Property 18: the bound decider agrees with the resolver on every input", () => {
    fc.assert(
      fc.property(arbInputs, (inputs) => {
        const decide = passthroughDecider({ providerKind: inputs.providerKind, flagEnabled: inputs.flagEnabled })
        expect(decide(inputs.routePath, inputs.stream)).toBe(resolvePassthrough(inputs))
      }),
      RUNS,
    )
  })

  // Clause 5b — one decider instance is reusable and stateless: repeated and interleaved calls on
  // the same bound instance return the same answers, so the two bound values cannot drift.
  test("Feature: native-api-mode, Property 18: a bound decider is stateless across repeated calls", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_KINDS), fc.boolean(), fc.array(fc.tuple(arbRouteish, fc.boolean()), { minLength: 1, maxLength: 8 }), (providerKind, flagEnabled, calls) => {
        const decide = passthroughDecider({ providerKind, flagEnabled })
        const first = calls.map(([routePath, stream]) => decide(routePath, stream))
        const second = calls.map(([routePath, stream]) => decide(routePath, stream))
        expect(second).toEqual(first)
        for (const [index, [routePath, stream]] of calls.entries()) {
          expect(first[index]).toBe(expectedPassthrough({ routePath, providerKind, stream, flagEnabled }))
        }
      }),
      RUNS,
    )
  })
})

describe("Property 18: the result is independent of every request header", () => {
  // Clause 6a — behavioral evidence. Header-shaped extra keys on the argument change nothing. This
  // fails if the implementation reads any key outside the declared four.
  test("Feature: native-api-mode, Property 18: header-shaped extra keys on the input change nothing", () => {
    fc.assert(
      fc.property(arbInputs, arbHeaderNoise, (inputs, noise) => {
        const augmented = { ...noise, ...inputs } as PassthroughInputs
        expect(resolvePassthrough(augmented)).toBe(resolvePassthrough(inputs))
        expect(resolvePassthrough(augmented)).toBe(expectedPassthrough(inputs))
      }),
      RUNS,
    )
  })

  // Clause 6b — behavioral evidence for the decider: extra positional arguments are ignored, so no
  // caller can smuggle a header in as a third argument.
  test("Feature: native-api-mode, Property 18: extra positional arguments to the decider change nothing", () => {
    fc.assert(
      fc.property(arbInputs, fc.jsonValue(), (inputs, extra) => {
        const decide = passthroughDecider({ providerKind: inputs.providerKind, flagEnabled: inputs.flagEnabled })
        const loose = decide as (routePath: string, stream: boolean, ...rest: unknown[]) => boolean
        expect(loose(inputs.routePath, inputs.stream, extra)).toBe(resolvePassthrough(inputs))
      }),
      RUNS,
    )
  })

  // Clause 6c — structural evidence: arity. One object argument, and a two-argument decider. There
  // is no positional room for a header bag in either signature.
  test("Feature: native-api-mode, Property 18: neither signature has room for a header argument", () => {
    expect(resolvePassthrough).toHaveLength(1)
    expect(passthroughDecider({ providerKind: "codex", flagEnabled: true })).toHaveLength(2)
  })

  // Clause 6d — structural evidence: every declared key is load-bearing. Dropping any one of the
  // four changes the answer for at least one point of the grid, so `DECLARED_INPUT_KEYS` is the
  // real read surface. Combined with 6a (nothing outside the four is read), the argument shape is
  // pinned to exactly these four members.
  test("Feature: native-api-mode, Property 18: each of the four declared input keys is load-bearing", () => {
    const allMet: PassthroughInputs = { routePath: PASSTHROUGH_ROUTE, providerKind: "codex", stream: true, flagEnabled: true }
    expect(Object.keys(allMet).sort()).toEqual([...DECLARED_INPUT_KEYS].sort())
    expect(resolvePassthrough(allMet)).toBe(true)

    for (const key of DECLARED_INPUT_KEYS) {
      const withoutKey = { ...allMet } as Record<string, unknown>
      delete withoutKey[key]
      expect(resolvePassthrough(withoutKey as unknown as PassthroughInputs)).toBe(false)
    }
  })

  // Clause 6e — source-text evidence. The only clause that speaks to a channel other than the
  // argument, and it is a grep: it proves the module does not name a header or the environment, not
  // that no such channel could ever exist.
  test("Feature: native-api-mode, Property 18: the resolver module names no header and no environment read", async () => {
    const source = await readFile(path.join(process.cwd(), "src/app/passthrough-resolver.ts"), "utf8")
    // Strip comments: the module documents *why* it takes no headers, and that prose legitimately
    // contains `originator` and `user-agent`. Only executable text is searched.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

    for (const forbidden of ["headers", "originator", "user-agent", "userAgent", "process.env", "req.", "request."]) {
      expect(code.toLowerCase()).not.toInclude(forbidden.toLowerCase())
    }
    // And the executable text does read all four declared inputs.
    for (const key of DECLARED_INPUT_KEYS) expect(code).toInclude(key)
  })
})

describe("Property 18: NATIVE_PASSTHROUGH unset takes the canonical path", () => {
  // Clause 7 — Requirement 15.6. `readNativeFlags` is the only reader of the variable; the resolver
  // is the only interpreter of the resulting boolean. Either half alone leaves a hole, so the join
  // is asserted: an environment in, a passthrough decision out.
  test("Feature: native-api-mode, Property 18: an environment without NATIVE_PASSTHROUGH resolves to false", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ minLength: 1 }).filter((key) => key !== "NATIVE_PASSTHROUGH"), fc.string(), { maxKeys: 5 }), (env) => {
        const flagEnabled = readNativeFlags(env).passthrough
        expect(flagEnabled).toBe(false)
        // All three other conditions met, and still canonical.
        expect(resolvePassthrough({ routePath: PASSTHROUGH_ROUTE, providerKind: "codex", stream: true, flagEnabled })).toBe(false)
      }),
      RUNS,
    )
  })

  test("Feature: native-api-mode, Property 18: a disabling NATIVE_PASSTHROUGH value resolves to false and an enabling one to true", () => {
    fc.assert(
      fc.property(fc.constantFrom("1", "true", "TRUE", "yes", "On", "0", "false", "no", "off", "", " 1", "maybe"), (value) => {
        const flagEnabled = readNativeFlags({ NATIVE_PASSTHROUGH: value }).passthrough
        expect(resolvePassthrough({ routePath: PASSTHROUGH_ROUTE, providerKind: "codex", stream: true, flagEnabled })).toBe(flagEnabled)
        // The flag never rescues a route, kind, or stream miss.
        expect(resolvePassthrough({ routePath: MESSAGES_ROUTE, providerKind: "codex", stream: true, flagEnabled })).toBe(false)
        expect(resolvePassthrough({ routePath: PASSTHROUGH_ROUTE, providerKind: "kiro", stream: true, flagEnabled })).toBe(false)
        expect(resolvePassthrough({ routePath: PASSTHROUGH_ROUTE, providerKind: "codex", stream: false, flagEnabled })).toBe(false)
      }),
      RUNS,
    )
  })
})
