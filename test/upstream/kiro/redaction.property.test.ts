// Property 12 for the Kiro error-text redactor (task 34.2).
//
// Scope. Property 12 has two halves. The transcript half lives in `test/native/redaction.test.ts`,
// which scans every rendered Transcript and is driven by the two redactors in
// `src/core/debug-capture.ts`. This file is the other half: `redact()` in
// `src/upstream/kiro/errors.ts`, the function every Kiro error message, HTTP error body, and
// network-failure detail passes through before it reaches a log or a client response.
//
// Why task 34.1 adds the `signature` key form at all. `redact()` runs two independent rules:
//
//   1. `TOKEN_LIKE` — any run of 24-plus token characters, regardless of the key it sits under.
//   2. `SECRET_KEYS` — a named key, whatever its value looks like.
//
// The measured Kiro reasoning signature is ~360 characters over the base64 alphabet, so rule 1
// very likely already caught it, and the unit below confirms that it did. That is not enough. Rule
// 1 is a guess about the value; rule 2 is a guarantee about the key. A signature is a
// provider-chosen opaque string — nothing in the Kiro contract fixes its length or its alphabet,
// and a 12-character signature is not hypothetical shorthand for "unlikely", it is the exact case
// that leaks on the pre-change function. `PRE_CHANGE_SECRET_KEYS` below is the old alternation kept
// verbatim so that leak is asserted rather than described: the short-value unit shows the
// pre-change redactor emitting the value and the current one emitting the placeholder. That single
// contrast is the whole evidence that 34.1 changes behavior; the long-value unit only shows what
// was already covered.
//
// **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 22.7, 25.5, 25.10**

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { classifyNetworkError, publicHttpErrorBody, redact } from "../../../src/upstream/kiro/errors"

const PLACEHOLDER = "[redacted]"

/** Property 12 calls a surviving run of eight characters a leak. */
const MIN_LEAK_LENGTH = 8

/** The five keys Requirement 25.10 names, in the spelling Kiro payloads use. */
const SCANNED_SECRET_KEYS = ["authorization", "accessToken", "refreshToken", "idToken", "signature"] as const

/** `TOKEN_LIKE`'s threshold in `src/upstream/kiro/errors.ts` — the length rule 1 starts covering at. */
const TOKEN_LIKE_FLOOR = 24

/** The token alphabet `TOKEN_LIKE` recognises, minus `"` (which cannot appear inside a JSON value). */
const TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~+/=-"
const TOKEN_CHAR_LIST = TOKEN_CHARS.split("")

/** `Bearer` followed by token characters. `Bearer [redacted]` cannot match: `[` is not a token char. */
const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._~+/=-]+/g

/**
 * `SECRET_KEYS` as it stood before task 34.1 — `signature` absent, everything else identical.
 * Mirrored rather than imported because the point is to compare against behavior that no longer
 * exists in the source. If the source alternation changes for any other reason, the
 * `matches the current source apart from signature` test below fails and points here.
 */
const PRE_CHANGE_SECRET_KEYS =
  /authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|profile[_-]?arn|mcp[_-]?authorization|client[_-]?secret/i

/** `redact()` as it stood before task 34.1, structure for structure. */
function redactPreChange(value: string) {
  const TOKEN_LIKE = /\b(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{24,}\b/g
  let redacted = value.replace(TOKEN_LIKE, PLACEHOLDER)
  redacted = redacted.replace(
    new RegExp(`("(?:${PRE_CHANGE_SECRET_KEYS.source})"\\s*:\\s*")([^"]+)(")`, "gi"),
    `$1${PLACEHOLDER}$3`,
  )
  redacted = redacted.replace(
    new RegExp(`((?:${PRE_CHANGE_SECRET_KEYS.source})\\s*[=:]\\s*)([^\\s,;]+)`, "gi"),
    `$1${PLACEHOLDER}`,
  )
  return redacted
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** Stride 7 is coprime with the alphabet length, so a generated value has no short repeating run. */
function tokenValue(length: number, offset = 0) {
  return Array.from({ length }, (_, index) => TOKEN_CHARS[(index * 7 + offset) % TOKEN_CHARS.length]).join("")
}

/**
 * The measured Kiro reasoning signature: ~360 characters, opening with the recorded `EqwCCpEB`
 * prefix (`.omc/research/kiro-wire-spike.md` §2 records the shape; the body here is synthetic).
 */
const MEASURED_SIGNATURE = `EqwCCpEB${tokenValue(352, 3)}`

/** The case rule 1 cannot reach: shorter than `TOKEN_LIKE_FLOOR`, so only the key form covers it. */
const SHORT_SIGNATURE = "EqwCCpEB1234"

/**
 * A body with no secret key at all, used for the identity unit. It still carries a 32-character
 * request id so the unit also pins that rule 1 is untouched — "identical to the pre-change output"
 * means identical including what was already being redacted, not merely unredacted.
 */
const NO_SECRET_FIXTURE =
  'Kiro upstream 500 for model kiro-claude-sonnet-4: {"requestId":"1f6c9e2a4b8d0c7e5a3f1b9d7c5e3a10","note":"retry later"}'

const NO_SECRET_EXPECTED =
  'Kiro upstream 500 for model kiro-claude-sonnet-4: {"requestId":"[redacted]","note":"retry later"}'

/**
 * Every place a secret is observed to ride in Kiro error text: as a JSON value, nested, and in the
 * bare `key=value` / `key: value` forms an echoed header line produces. The `key: Bearer value`
 * form is deliberately *not* here — see `recorded redaction gaps` at the foot of this file.
 */
function embeddings(key: string, secret: string): string[] {
  return [
    `{"${key}":"${secret}"}`,
    `{"reasoningContentEvent":{"${key}":"${secret}"},"note":"ok"}`,
    `Kiro request failed (${key}=${secret})`,
    `${key}: ${secret}`,
  ]
}

function windows(value: string, length: number): string[] {
  if (value.length < length) return []
  return Array.from({ length: value.length - length + 1 }, (_, index) => value.slice(index, index + length))
}

/**
 * The Property 12 clause, applied to one redacted string: the placeholder is present, no `Bearer`
 * token match survives, and no run of `MIN_LEAK_LENGTH` characters of the value survives.
 *
 * The whole-value check is gated on that same floor rather than applied unconditionally, because
 * Property 12 sets its leak criterion at eight characters and below that the check is not merely
 * stricter, it is unsound: `publicHttpErrorBody` wraps the body in fixed guidance prose, so a
 * one-character secret `a` "survives" inside the word `account` no matter what redaction does.
 */
function assertNoLeak(redacted: string, secret: string) {
  expect(redacted).toContain(PLACEHOLDER)
  expect(redacted.match(BEARER_TOKEN) ?? []).toEqual([])
  if (secret.length < MIN_LEAK_LENGTH) return
  expect(redacted).not.toContain(secret)
  for (const window of windows(secret, MIN_LEAK_LENGTH)) {
    expect(redacted.includes(window), `a ${MIN_LEAK_LENGTH}-character run survived: ${window}`).toBe(false)
  }
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

/**
 * Secret values from one character up. The lower bound is deliberately 1, not `TOKEN_LIKE_FLOOR`:
 * generating only values rule 1 already covers would make the property pass on the pre-change
 * function and prove nothing about task 34.1.
 */
const secretArb = fc
  .array(fc.constantFrom(...TOKEN_CHAR_LIST), { minLength: 1, maxLength: 96 })
  .map((chars) => chars.join(""))

/**
 * Words of at most 12 token characters joined by single spaces: no run reaches
 * `TOKEN_LIKE_FLOOR`, and the filter drops the (vanishingly rare) draw that spells a secret key,
 * so these are exactly the inputs on which redaction must be the identity.
 */
const safeTextArb = fc
  .array(
    fc.array(fc.constantFrom(...TOKEN_CHAR_LIST), { minLength: 1, maxLength: 12 }).map((chars) => chars.join("")),
    { minLength: 1, maxLength: 10 },
  )
  .map((words) => words.join(" "))
  .filter((text) => !/authorization|token|profile[_-]?arn|client[_-]?secret|signature/i.test(text))

// ---------------------------------------------------------------------------------------------
// Property 12
// ---------------------------------------------------------------------------------------------

describe("Kiro error redaction properties", () => {
  test("Feature: native-api-mode, Property 12: Redaction leaves no secret value in any output", () => {
    fc.assert(
      fc.property(secretArb, fc.constantFrom(...SCANNED_SECRET_KEYS), (secret, key) => {
        for (const text of embeddings(key, secret)) assertNoLeak(redact(text), secret)
      }),
      { numRuns: 200 },
    )
  })

  test("Feature: native-api-mode, Property 12: Redaction leaves no secret value in any output — through the public error surfaces", () => {
    fc.assert(
      fc.property(secretArb, fc.constantFrom(...SCANNED_SECRET_KEYS), (secret, key) => {
        const body = `{"message":"denied","${key}":"${secret}"}`

        // Every caller-visible string built out of an upstream body or a thrown error.
        assertNoLeak(publicHttpErrorBody(401, body), secret)
        assertNoLeak(publicHttpErrorBody(429, body), secret)
        assertNoLeak(publicHttpErrorBody(500, body), secret)

        const classified = classifyNetworkError(new Error(`fetch failed for ${key}=${secret}`))
        assertNoLeak(classified.detail, secret)
        assertNoLeak(classified.message, secret)
      }),
      { numRuns: 200 },
    )
  })

  test("Feature: native-api-mode, Property 12: Redaction leaves no secret value in any output — redaction is the identity on text carrying neither a secret key nor a token-like run", () => {
    fc.assert(
      fc.property(safeTextArb, (text) => {
        expect(redact(text)).toBe(text)
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------------------------
// The three units task 34.2 names
// ---------------------------------------------------------------------------------------------

describe("Kiro error redaction units", () => {
  test("the measured ~360-character signature emits zero characters of that value", () => {
    expect(MEASURED_SIGNATURE.length).toBe(360)

    const redacted = redact(`{"reasoningContentEvent":{"signature":"${MEASURED_SIGNATURE}"}}`)

    expect(redacted).toBe(`{"reasoningContentEvent":{"signature":"${PLACEHOLDER}"}}`)
    assertNoLeak(redacted, MEASURED_SIGNATURE)
    // This one was already covered by `TOKEN_LIKE` before task 34.1 — stated so the short-value
    // unit below is read as the evidence for the change, not this one.
    expect(redactPreChange(`{"signature":"${MEASURED_SIGNATURE}"}`)).not.toContain(MEASURED_SIGNATURE)
  })

  test("a short signature value is redacted too, which the pre-change key set did not do", () => {
    expect(SHORT_SIGNATURE.length).toBeLessThan(TOKEN_LIKE_FLOOR)

    // The leak as it stood: below the token floor and under a key the old set did not name.
    expect(redactPreChange(`{"signature":"${SHORT_SIGNATURE}"}`)).toContain(SHORT_SIGNATURE)

    expect(redact(`{"signature":"${SHORT_SIGNATURE}"}`)).toBe(`{"signature":"${PLACEHOLDER}"}`)
    expect(redact(`signature=${SHORT_SIGNATURE}`)).toBe(`signature=${PLACEHOLDER}`)
    expect(redact(`signature: ${SHORT_SIGNATURE}`)).toBe(`signature: ${PLACEHOLDER}`)
    expect(publicHttpErrorBody(401, `{"signature":"${SHORT_SIGNATURE}"}`)).not.toContain(SHORT_SIGNATURE)
  })

  test("a fixture with no secret keys emits text identical to the pre-change output", () => {
    expect(redact(NO_SECRET_FIXTURE)).toBe(NO_SECRET_EXPECTED)
    expect(redact(NO_SECRET_FIXTURE)).toBe(redactPreChange(NO_SECRET_FIXTURE))
  })

  test("a `Bearer` credential at or above the token floor is redacted whole", () => {
    expect(redact(`authorization: Bearer ${MEASURED_SIGNATURE}`)).toBe(`authorization: ${PLACEHOLDER}`)
    // `TOKEN_LIKE`'s optional `Bearer\s+` prefix is what takes the scheme word with it.
    expect(redact(`authorization: Bearer ${tokenValue(TOKEN_LIKE_FLOOR, 5)}`)).toBe(`authorization: ${PLACEHOLDER}`)
  })

  test("the pre-change reference matches the current source apart from `signature`", () => {
    // Guards the two units above: if `SECRET_KEYS` gains or loses any other member, the reference
    // stops standing in for "before task 34.1" and this test says so instead of silently drifting.
    for (const key of ["authorization", "accessToken", "refreshToken", "idToken", "profileArn", "mcpAuthorization", "clientSecret"]) {
      expect(redactPreChange(`{"${key}":"ab"}`), `${key} should be redacted by both`).toBe(`{"${key}":"${PLACEHOLDER}"}`)
      expect(redact(`{"${key}":"ab"}`)).toBe(`{"${key}":"${PLACEHOLDER}"}`)
    }
    expect(redactPreChange('{"signature":"ab"}')).toBe('{"signature":"ab"}')
    expect(redact('{"signature":"ab"}')).toBe(`{"signature":"${PLACEHOLDER}"}`)
  })
})

// ---------------------------------------------------------------------------------------------
// Recorded gap — asserts the requirement, fails until the gap closes
// ---------------------------------------------------------------------------------------------

describe("recorded redaction gaps", () => {
  /**
   * Found while writing the property above, pre-existing, and **outside task 34's scope** (34.1 is
   * the `signature` key and nothing else, zero structural change).
   *
   * In the bare form `authorization: Bearer <value>`, the `SECRET_KEYS` rule's value class is
   * `[^\s,;]+`, which stops at the first space — so it consumes only the scheme word `Bearer` and
   * leaves the credential standing:
   *
   *     authorization: Bearer ABCDEFGH   ->   authorization: [redacted] ABCDEFGH
   *
   * `TOKEN_LIKE` covers this shape whole, scheme word included, from `TOKEN_LIKE_FLOOR` characters
   * up, which is why real bearer tokens are redacted and why the unit above passes. The exposed band
   * is a value of `MIN_LEAK_LENGTH` to `TOKEN_LIKE_FLOOR - 1` characters: long enough to count as a
   * leak under Property 12, short enough that neither rule reaches it. Closing it means letting the
   * bare rule span an optional scheme word, which is a structural change to `redact()` and belongs
   * to whoever owns the next Kiro error-handling task.
   *
   * Recorded as `.failing` rather than left unsaid so the green property above is not read as
   * "every embedding is covered", and so this flips loudly the moment the behavior changes.
   */
  test.failing("a `Bearer` credential below the token floor does not survive the scheme word", () => {
    const secret = "ABCDEFGH"
    expect(secret.length).toBeGreaterThanOrEqual(MIN_LEAK_LENGTH)
    expect(secret.length).toBeLessThan(TOKEN_LIKE_FLOOR)

    const redacted = redact(`authorization: Bearer ${secret}`)
    expect(redacted).not.toContain(secret)
  })

  /** The measured bound on that gap: it is the scheme word, not the key rule, that ends the match. */
  test("bounds the gap: the same value with no scheme word is redacted", () => {
    const secret = "ABCDEFGH"
    expect(redact(`authorization: ${secret}`)).toBe(`authorization: ${PLACEHOLDER}`)
    expect(redact(`{"authorization":"Bearer ${secret}"}`)).toBe(`{"authorization":"${PLACEHOLDER}"}`)
  })
})
