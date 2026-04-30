import { timingSafeEqual } from "crypto"
import { cors } from "./http"

// Endpoints that bypass authentication regardless of password configuration.
const UNPROTECTED_ENDPOINTS: Array<{ method: string; pathname: string }> = [
  { method: "GET", pathname: "/" },
  { method: "HEAD", pathname: "/" },
  { method: "GET", pathname: "/health" },
  { method: "HEAD", pathname: "/health" },
  { method: "GET", pathname: "/test-connection" },
]

export function timingSafeCompare(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const bufA = encoder.encode(a)
  const bufB = encoder.encode(b)
  if (bufA.byteLength !== bufB.byteLength) {
    // Compare bufB (server password) against itself so timing is always
    // proportional to the server password length, not the attacker input.
    timingSafeEqual(bufB, bufB)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

export function extractPasswordFromHeaders(headers: Headers): string | undefined {
  const apiKey = headers.get("x-api-key")
  if (apiKey) return apiKey

  const authorization = headers.get("authorization")
  if (authorization && authorization.startsWith("Bearer ")) {
    const token = authorization.slice(7)
    if (token) return token
  }

  return undefined
}

export function isUnprotectedEndpoint(method: string, pathname: string): boolean {
  const upper = method.toUpperCase()
  if (upper === "OPTIONS") return true
  return UNPROTECTED_ENDPOINTS.some((ep) => ep.method === upper && ep.pathname === pathname)
}

export function checkAuth(
  request: Request,
  url: URL,
  apiPassword: string | undefined,
): Response | null {
  if (!apiPassword) return null
  if (isUnprotectedEndpoint(request.method, url.pathname)) return null

  const provided = extractPasswordFromHeaders(request.headers)

  if (!provided) {
    return cors(
      new Response(JSON.stringify({ error: { message: "Unauthorized: API password required" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    )
  }

  if (!timingSafeCompare(provided, apiPassword)) {
    return cors(
      new Response(
        JSON.stringify({ error: { message: "Unauthorized: Invalid API password" } }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      ),
    )
  }

  return null
}
