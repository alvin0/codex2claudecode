import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { checkAuth, timingSafeCompare } from "../../src/core/auth-guard"
import { parseCliOptions } from "../../src/app/cli"

// ---------------------------------------------------------------------------
// Shared helpers & generators
// ---------------------------------------------------------------------------

/** Protected endpoint paths that require authentication. */
const PROTECTED_PATHS = [
  "/v1/messages",
  "/v1/chat/completions",
  "/v1/responses",
  "/usage",
  "/environments",
]

/** HTTP methods used for protected endpoints. */
const PROTECTED_METHODS = ["POST", "GET", "PUT", "PATCH", "DELETE"]

/**
 * Arbitrary for non-empty password strings suitable for HTTP header transport.
 * Excludes strings starting with "--" (CLI flag ambiguity) and strings where
 * leading/trailing whitespace would be trimmed by the HTTP Headers API,
 * causing a mismatch between the configured password and the header value.
 */
const passwordArb = fc
  .string({ minLength: 1 })
  .filter((s) => !s.startsWith("-") && s.trim().length > 0 && s === s.trim())

/** Arbitrary for a protected endpoint (method + path). */
const protectedEndpointArb = fc.record({
  method: fc.constantFrom(...PROTECTED_METHODS),
  path: fc.constantFrom(...PROTECTED_PATHS),
})

/** Build a Request + URL pair for checkAuth. */
function makeRequest(
  method: string,
  pathname: string,
  headers?: Record<string, string>,
): { request: Request; url: URL } {
  const url = new URL(`http://localhost${pathname}`)
  const request = new Request(url.toString(), { method, headers })
  return { request, url }
}

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe("Auth Guard correctness properties", () => {
  // Feature: api-password-lock, Property 1: CLI password parsing round-trip
  // **Validates: Requirements 1.1, 1.2**
  test("Property 1: CLI password parsing round-trip", () => {
    fc.assert(
      fc.property(passwordArb, (s) => {
        // --password <value> form
        const opts1 = parseCliOptions(["--password", s])
        expect(opts1.password).toBe(s)

        // --password=<value> form
        const opts2 = parseCliOptions([`--password=${s}`])
        expect(opts2.password).toBe(s)
      }),
      { numRuns: 100 },
    )
  })

  // Feature: api-password-lock, Property 2: Valid credential allows request
  // **Validates: Requirements 3.1, 3.2, 3.3**
  test("Property 2: Valid credential allows request", () => {
    fc.assert(
      fc.property(passwordArb, protectedEndpointArb, (password, endpoint) => {
        // X-Api-Key header
        const { request: req1, url: url1 } = makeRequest(endpoint.method, endpoint.path, {
          "x-api-key": password,
        })
        expect(checkAuth(req1, url1, password)).toBeNull()

        // Authorization: Bearer header
        const { request: req2, url: url2 } = makeRequest(endpoint.method, endpoint.path, {
          authorization: `Bearer ${password}`,
        })
        expect(checkAuth(req2, url2, password)).toBeNull()
      }),
      { numRuns: 100 },
    )
  })

  // Feature: api-password-lock, Property 3: Constant-time comparison correctness
  // **Validates: Requirements 3.4**
  test("Property 3: Constant-time comparison correctness", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const result = timingSafeCompare(a, b)
        if (a === b) {
          expect(result).toBe(true)
        } else {
          expect(result).toBe(false)
        }
      }),
      { numRuns: 100 },
    )
  })

  // Feature: api-password-lock, Property 4: Missing credentials rejected
  // **Validates: Requirements 4.1, 4.4**
  test("Property 4: Missing credentials rejected", async () => {
    await fc.assert(
      fc.asyncProperty(passwordArb, protectedEndpointArb, async (password, endpoint) => {
        const { request, url } = makeRequest(endpoint.method, endpoint.path)
        const response = checkAuth(request, url, password)

        expect(response).not.toBeNull()
        expect(response!.status).toBe(401)

        const body = await response!.json()
        expect(body.error.message).toBe("Unauthorized: API password required")

        // CORS headers present
        expect(response!.headers.get("access-control-allow-origin")).toBe("*")
      }),
      { numRuns: 100 },
    )
  })

  // Feature: api-password-lock, Property 5: Invalid credentials rejected
  // **Validates: Requirements 4.2, 4.3, 4.4**
  test("Property 5: Invalid credentials rejected", async () => {
    const distinctPasswordsArb = fc
      .record({
        configured: passwordArb,
        provided: passwordArb,
      })
      .filter(({ configured, provided }) => configured !== provided)

    await fc.assert(
      fc.asyncProperty(
        distinctPasswordsArb,
        protectedEndpointArb,
        async ({ configured, provided }, endpoint) => {
          // Test with X-Api-Key
          const { request: req1, url: url1 } = makeRequest(endpoint.method, endpoint.path, {
            "x-api-key": provided,
          })
          const response1 = checkAuth(req1, url1, configured)

          expect(response1).not.toBeNull()
          expect(response1!.status).toBe(401)

          const body1 = await response1!.json()
          expect(body1.error.message).toBe("Unauthorized: Invalid API password")
          expect(response1!.headers.get("access-control-allow-origin")).toBe("*")

          // Test with Authorization: Bearer
          const { request: req2, url: url2 } = makeRequest(endpoint.method, endpoint.path, {
            authorization: `Bearer ${provided}`,
          })
          const response2 = checkAuth(req2, url2, configured)

          expect(response2).not.toBeNull()
          expect(response2!.status).toBe(401)

          const body2 = await response2!.json()
          expect(body2.error.message).toBe("Unauthorized: Invalid API password")
          expect(response2!.headers.get("access-control-allow-origin")).toBe("*")
        },
      ),
      { numRuns: 100 },
    )
  })

  // Feature: api-password-lock, Property 6: OPTIONS requests bypass authentication
  // **Validates: Requirements 5.1**
  test("Property 6: OPTIONS requests bypass authentication", () => {
    const pathnameArb = fc.constantFrom(
      "/v1/messages",
      "/v1/chat/completions",
      "/usage",
      "/health",
      "/",
      "/anything",
      "/v1/responses",
    )

    fc.assert(
      fc.property(pathnameArb, passwordArb, (pathname, password) => {
        const { request, url } = makeRequest("OPTIONS", pathname)
        expect(checkAuth(request, url, password)).toBeNull()
      }),
      { numRuns: 100 },
    )
  })

  // Feature: api-password-lock, Property 7: No password means no auth checks
  // **Validates: Requirements 6.1**
  test("Property 7: No password means no auth checks", () => {
    const methodArb = fc.constantFrom("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD")
    const pathArb = fc.constantFrom(
      "/",
      "/health",
      "/v1/messages",
      "/v1/chat/completions",
      "/usage",
      "/environments",
      "/test-connection",
      "/anything",
    )
    const headersArb = fc.constantFrom<Record<string, string>>(
      {},
      { "x-api-key": "some-key" },
      { authorization: "Bearer some-token" },
      { "content-type": "application/json" },
    )

    fc.assert(
      fc.property(methodArb, pathArb, headersArb, (method, pathname, headers) => {
        const { request, url } = makeRequest(method, pathname, headers)
        expect(checkAuth(request, url, undefined)).toBeNull()
      }),
      { numRuns: 100 },
    )
  })
})
