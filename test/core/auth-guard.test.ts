import { describe, expect, test } from "bun:test"

import {
  checkAuth,
  extractPasswordFromHeaders,
  isUnprotectedEndpoint,
  timingSafeCompare,
} from "../../src/core/auth-guard"

describe("isUnprotectedEndpoint", () => {
  test("OPTIONS requests to any path return true", () => {
    expect(isUnprotectedEndpoint("OPTIONS", "/v1/messages")).toBe(true)
    expect(isUnprotectedEndpoint("OPTIONS", "/")).toBe(true)
    expect(isUnprotectedEndpoint("OPTIONS", "/anything")).toBe(true)
  })

  test("GET / returns true", () => {
    expect(isUnprotectedEndpoint("GET", "/")).toBe(true)
  })

  test("HEAD / returns true", () => {
    expect(isUnprotectedEndpoint("HEAD", "/")).toBe(true)
  })

  test("GET /health returns true", () => {
    expect(isUnprotectedEndpoint("GET", "/health")).toBe(true)
  })

  test("HEAD /health returns true", () => {
    expect(isUnprotectedEndpoint("HEAD", "/health")).toBe(true)
  })

  test("GET /test-connection returns true", () => {
    expect(isUnprotectedEndpoint("GET", "/test-connection")).toBe(true)
  })

  test("POST /v1/messages returns false", () => {
    expect(isUnprotectedEndpoint("POST", "/v1/messages")).toBe(false)
  })

  test("GET /usage returns false", () => {
    expect(isUnprotectedEndpoint("GET", "/usage")).toBe(false)
  })

  test("POST /v1/chat/completions returns false", () => {
    expect(isUnprotectedEndpoint("POST", "/v1/chat/completions")).toBe(false)
  })
})

describe("extractPasswordFromHeaders", () => {
  test("X-Api-Key header extracts the value", () => {
    const headers = new Headers({ "x-api-key": "my-secret" })
    expect(extractPasswordFromHeaders(headers)).toBe("my-secret")
  })

  test("Authorization: Bearer <token> extracts the token", () => {
    const headers = new Headers({ authorization: "Bearer my-token" })
    expect(extractPasswordFromHeaders(headers)).toBe("my-token")
  })

  test("both headers present, X-Api-Key takes precedence", () => {
    const headers = new Headers({
      "x-api-key": "key-value",
      authorization: "Bearer bearer-value",
    })
    expect(extractPasswordFromHeaders(headers)).toBe("key-value")
  })

  test("no auth headers returns undefined", () => {
    const headers = new Headers({ "content-type": "application/json" })
    expect(extractPasswordFromHeaders(headers)).toBeUndefined()
  })

  test("Authorization without Bearer prefix returns undefined", () => {
    const headers = new Headers({ authorization: "Basic dXNlcjpwYXNz" })
    expect(extractPasswordFromHeaders(headers)).toBeUndefined()
  })

  test("Authorization: Bearer with empty token returns undefined", () => {
    const headers = new Headers({ authorization: "Bearer " })
    expect(extractPasswordFromHeaders(headers)).toBeUndefined()
  })
})

describe("timingSafeCompare", () => {
  test("equal strings return true", () => {
    expect(timingSafeCompare("hello", "hello")).toBe(true)
  })

  test("different strings return false", () => {
    expect(timingSafeCompare("hello", "world")).toBe(false)
  })

  test("different length strings return false", () => {
    expect(timingSafeCompare("short", "much-longer-string")).toBe(false)
  })

  test("empty strings return true", () => {
    expect(timingSafeCompare("", "")).toBe(true)
  })
})

/** Helper to build a minimal Request for checkAuth tests. */
function makeRequest(method: string, pathname: string, headers?: Record<string, string>): { request: Request; url: URL } {
  const url = new URL(`http://localhost${pathname}`)
  const request = new Request(url.toString(), { method, headers })
  return { request, url }
}

describe("checkAuth", () => {
  test("no password configured (undefined) returns null for any request", () => {
    const { request, url } = makeRequest("POST", "/v1/messages")
    expect(checkAuth(request, url, undefined)).toBeNull()
  })

  test("empty string password returns null for any request", () => {
    const { request, url } = makeRequest("POST", "/v1/messages")
    expect(checkAuth(request, url, "")).toBeNull()
  })

  test("unprotected endpoint returns null even with password configured", () => {
    const { request, url } = makeRequest("GET", "/health")
    expect(checkAuth(request, url, "secret")).toBeNull()
  })

  test("valid X-Api-Key returns null", () => {
    const { request, url } = makeRequest("POST", "/v1/messages", { "x-api-key": "secret" })
    expect(checkAuth(request, url, "secret")).toBeNull()
  })

  test("valid Bearer token returns null", () => {
    const { request, url } = makeRequest("POST", "/v1/messages", { authorization: "Bearer secret" })
    expect(checkAuth(request, url, "secret")).toBeNull()
  })

  test("missing credentials returns 401 with 'Unauthorized: API password required'", async () => {
    const { request, url } = makeRequest("POST", "/v1/messages")
    const response = checkAuth(request, url, "secret")

    expect(response).not.toBeNull()
    expect(response!.status).toBe(401)

    const body = await response!.json()
    expect(body.error.message).toBe("Unauthorized: API password required")
  })

  test("invalid credentials returns 401 with 'Unauthorized: Invalid API password'", async () => {
    const { request, url } = makeRequest("POST", "/v1/messages", { "x-api-key": "wrong" })
    const response = checkAuth(request, url, "secret")

    expect(response).not.toBeNull()
    expect(response!.status).toBe(401)

    const body = await response!.json()
    expect(body.error.message).toBe("Unauthorized: Invalid API password")
  })

  test("401 responses include CORS headers", () => {
    const { request, url } = makeRequest("POST", "/v1/messages")
    const response = checkAuth(request, url, "secret")

    expect(response).not.toBeNull()
    expect(response!.headers.get("access-control-allow-origin")).toBe("*")
    expect(response!.headers.get("access-control-allow-methods")).toBe("GET,POST,OPTIONS")
    expect(response!.headers.get("access-control-allow-headers")).toBe("*")
  })

  test("401 responses have content-type: application/json", () => {
    const { request, url } = makeRequest("POST", "/v1/messages")
    const response = checkAuth(request, url, "secret")

    expect(response).not.toBeNull()
    expect(response!.headers.get("content-type")).toBe("application/json")
  })

  test("Authorization: Bearer with empty token is treated as missing credentials", async () => {
    const { request, url } = makeRequest("POST", "/v1/messages", { authorization: "Bearer " })
    const response = checkAuth(request, url, "secret")

    expect(response).not.toBeNull()
    expect(response!.status).toBe(401)

    const body = await response!.json()
    expect(body.error.message).toBe("Unauthorized: API password required")
  })
})
