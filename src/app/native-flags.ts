/**
 * The only reader of the native-mode environment.
 *
 * Role, and only this role: environment in, booleans out. This module reads the
 * five native-mode variables and returns their resolved values. It decides
 * nothing — no policy escalation, no provider selection, no wire behavior — so
 * every consumer downstream receives a plain boolean and stays testable without
 * touching `process.env`.
 *
 * Environment reading is application-level composition, which is why this lives
 * in `src/app/`. `src/core/` stays provider-agnostic *and* environment-free:
 * `resolveFeature()` in `src/core/feature-policy.ts` is the only function in the
 * repository that interprets `strict`, and it takes it as a parameter
 * (design decision D3). Task 11.2 threads these values from
 * `src/app/bootstrap.ts` into provider construction; `src/app/runtime.ts` is not
 * involved and is not modified (Requirements 27.5, 27.6).
 *
 * Every flag is **opt-in**. With nothing set in the environment, every member of
 * {@link NativeFlags} is `false` and gateway behavior is exactly what it was
 * before the flag existed — that default-off property is what lets the live
 * baseline stay unchanged when a flag lands.
 *
 * There is deliberately no module-level cached read. A cached snapshot would
 * make the `env` parameter cosmetic and force tests to mutate the process to
 * exercise a flag.
 */

/**
 * Resolved state of the five native-mode environment variables.
 *
 * Every member is required and boolean: an absent variable is `false`, not
 * `undefined`, so a consumer can never accidentally treat "unset" as a third
 * state.
 */
export interface NativeFlags {
  /** `NATIVE_STRICT` — `degrade` outcomes escalate to `reject` (Requirement 11.1). */
  strict: boolean
  /** `NATIVE_PASSTHROUGH` — the passthrough resolver may return a byte-passthrough decision (task 19). */
  passthrough: boolean
  /** `NATIVE_MCP_EMULATION` — upstreams that declare `mcpToolset: "emulate"` may emulate it (tasks 35, 36). */
  mcpEmulation: boolean
  /** `KIRO_WEB_SEARCH_HEURISTICS` — restores the pre-native-mode Kiro web-search heuristics (task 27). */
  kiroWebSearchHeuristics: boolean
  /**
   * `NATIVE_FEATURE_NOTICES` — `degrade` notices are rendered into the client's own text.
   *
   * Off by default, unlike the reporting this replaces. The notices describe the upstream rather
   * than the request, so they repeat verbatim on every turn of a session while naming nothing the
   * client can act on; prepended to each reply they crowd out the model's text and accumulate in
   * the transcript. What the client loses is only the *rendering* — every notice still reaches
   * `Canonical_Response.featureNotices`, stream telemetry, and the request log, so the operator
   * can still read which fields were changed and why (`/logs`), and the native harness still
   * observes them through telemetry.
   */
  featureNotices: boolean
}

/**
 * The documented enabling values, matching `kiroDebugOnErrorEnabled()` in
 * `src/core/debug-capture.ts` exactly — same four literals, same
 * `.toLowerCase()` comparison, no trimming. Anything else is disabled
 * (Requirement 11.4).
 *
 * Not imported from `debug-capture.ts`: that module owns a Kiro-specific debug
 * bundle and exports a variable-specific predicate (`KIRO_DEBUG_ON_ERROR` is
 * baked in), not a reusable parser. Sharing one four-literal array across a
 * layer boundary would buy nothing and couple this module to a provider's debug
 * capture. `test/app/native-flags.test.ts` asserts the two agree on every input
 * instead, so the convention is enforced rather than assumed.
 */
const ENABLING_VALUES = ["1", "true", "yes", "on"] as const

/**
 * Whether one environment value enables its flag.
 *
 * Case-insensitive, exact otherwise: `"1"`, `"true"`, `"yes"`, `"on"` in any
 * casing enable; an unset variable, the empty string, `"0"`, `"false"`, and
 * whitespace-padded spellings such as `" 1"` all disable.
 */
export function isEnablingValue(value: string | undefined): boolean {
  return (ENABLING_VALUES as readonly string[]).includes((value ?? "").toLowerCase())
}

/**
 * Read all five native-mode flags from `env`.
 *
 * Total and side-effect-free: it never throws, never writes, and never caches.
 * `env` defaults to `process.env` for production callers and is passed
 * explicitly by tests, so no test needs to mutate the process to cover a flag
 * combination.
 */
export function readNativeFlags(env: Record<string, string | undefined> = process.env): NativeFlags {
  return {
    strict: isEnablingValue(env.NATIVE_STRICT),
    passthrough: isEnablingValue(env.NATIVE_PASSTHROUGH),
    mcpEmulation: isEnablingValue(env.NATIVE_MCP_EMULATION),
    kiroWebSearchHeuristics: isEnablingValue(env.KIRO_WEB_SEARCH_HEURISTICS),
    featureNotices: isEnablingValue(env.NATIVE_FEATURE_NOTICES),
  }
}
