// Role: call the upstream directly, bypassing the gateway, for the one case that needs a
// reference to diff against (`passthrough-bytes`, Requirement 29.3). Only the upstream client
// is used here, never an inbound provider, so nothing about the gateway's own rendering can
// leak into the reference bytes.
//
// The call is made with the credential *copy*, exactly like the gateway (Requirement 24.11).
// The copier strips every `sourceAuthFile` / `sourceAccountKey` link, so a token refresh
// triggered by this call writes to the copy and never to `~/.aws/sso/cache/kiro-auth-token.json`.
//
// Semantics worth stating plainly: two separate model invocations never produce identical
// bytes (response ids, timestamps, and sampled tokens all differ). The reference recorded
// here is therefore a *shape* reference — a genuinely direct call, whose raw bytes the
// transcript shows next to the gateway's. The byte-identity claim of Requirement 29.3 is
// additionally measured, at zero credit cost, by `run-case.ts` comparing the client bytes
// against the upstream bytes captured for the very same request.
import { CodexStandaloneClient } from "../../src/upstream/codex/client"
import type { JsonObject } from "../../src/core/types"

import type { NativeCredentialCopy } from "./credentials"
import type { NativeLiveCase } from "./types"

export interface DirectUpstreamCallInput {
  liveCase: NativeLiveCase
  credentials: NativeCredentialCopy
  /** Body the gateway sent upstream, preferred so the direct call mirrors it field for field. */
  upstreamRequestBody?: string
  /** Fallback body when the gateway captured nothing: the resolved case body. */
  fallbackBody: JsonObject
  signal?: AbortSignal
}

export interface DirectUpstreamCall {
  status: number
  /** Raw response bytes as text: SSE text for a streaming call, JSON text otherwise. */
  body: string
  /** Which body the call sent, so a transcript reader knows what was compared. */
  bodySource: "gateway upstream request" | "case body"
}

/**
 * Issues one direct upstream call for `liveCase`. Codex only — no Kiro case declares
 * `requiresDirectUpstreamCall`, and Kiro's binary EventStream is not byte-comparable through
 * the capture path Requirement 25.4 allows, so asking for one fails loudly instead of
 * returning something misleading.
 */
export async function callUpstreamDirectly(input: DirectUpstreamCallInput): Promise<DirectUpstreamCall> {
  if (input.liveCase.upstream !== "codex") {
    throw new Error(
      `A direct upstream call is implemented for codex only; case ${input.liveCase.id} targets ${input.liveCase.upstream}`,
    )
  }

  const resolved = resolveDirectBody(input)
  const client = await CodexStandaloneClient.fromAuthFile(input.credentials.authFile)
  const response = await client.proxy(resolved.body, input.signal ? { signal: input.signal } : undefined)

  return { status: response.status, body: await response.text(), bodySource: resolved.source }
}

function resolveDirectBody(input: DirectUpstreamCallInput): { body: JsonObject; source: DirectUpstreamCall["bodySource"] } {
  const captured = parseJsonObject(input.upstreamRequestBody)
  if (captured) return { body: captured, source: "gateway upstream request" }
  return { body: input.fallbackBody, source: "case body" }
}

function parseJsonObject(text: string | undefined): JsonObject | undefined {
  if (!text?.trim()) return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined
  } catch {
    return undefined
  }
}
