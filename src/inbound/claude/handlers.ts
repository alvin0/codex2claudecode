import { LOG_BODY_PREVIEW_LIMIT } from "../../core/constants"
import type { Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import type { UpstreamResult } from "../../core/interfaces"
import { normalizeReasoningBody } from "../../core/reasoning"
import { interceptResponseStream } from "../../core/stream-utils"
import type { ClaudeMessagesRequest, JsonObject, RequestProxyLog } from "../types"

import { claudeToResponsesBody } from "./codex-convert"
import { countClaudeInputTokens } from "./convert"
import { claudeUpstreamErrorMessage } from "./context-limit"
import { claudeErrorResponse } from "./errors"
import { canonicalResponseToClaudeMessage, claudeCanonicalStreamResponse } from "./response"

/**
 * A proxy function that sends a Codex Responses body upstream and returns
 * canonical types. This abstraction keeps the handler free of upstream imports.
 */
export interface CodexProxyFn {
  proxy(body: JsonObject, options?: { headers?: HeadersInit; signal?: AbortSignal }): Promise<Response>
  collectResponse(response: Response, model: string): Promise<Canonical_Response>
  streamResponse(response: Response, model: string): Canonical_StreamResponse
}

export async function handleClaudeMessages(
  client: CodexProxyFn,
  request: Request,
  requestId: string,
  options?: { logBody?: boolean; onProxy?: (entry: RequestProxyLog) => void },
) {
  let body: ClaudeMessagesRequest
  try {
    body = (await request.json()) as ClaudeMessagesRequest
  } catch (error) {
    return claudeErrorResponse(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, 400)
  }

  if (!Array.isArray(body.messages)) return claudeErrorResponse("Claude messages request requires messages", 400)

  let responsesBody: JsonObject
  try {
    responsesBody = claudeToResponsesBody(body)
  } catch (error) {
    return claudeErrorResponse(errorMessage(error), 400)
  }
  const shouldCaptureProxyBody = options?.logBody === true && options.onProxy !== undefined
  const requestBody = shouldCaptureProxyBody ? previewText(stringifyBody(responsesBody)) : undefined
  if (options?.logBody && options.onProxy) {
    options.onProxy({
      label: "Upstream request body",
      method: "POST",
      target: "upstream",
      status: 0,
      durationMs: 0,
      error: "-",
      requestBody: previewText(stringifyBody(responsesBody)),
    })
  }

  const started = Date.now()
  let response: Response
  try {
    response = await client.proxy(responsesBody, {
      headers: request.headers,
      signal: request.signal,
    })
  } catch (error) {
    return claudeErrorResponse(errorMessage(error), 500)
  }
  const durationMs = Date.now() - started

  if (!response.ok) {
    const text = await response.text()
    if (options?.onProxy) {
      const redactedText = redactSecrets(text)
      options.onProxy({
        label: "Upstream responses",
        method: "POST",
        target: "upstream",
        status: response.status,
        durationMs,
        error: redactedText.slice(0, LOG_BODY_PREVIEW_LIMIT) || "-",
        requestBody,
        responseBody: shouldCaptureProxyBody ? previewText(redactedText) || undefined : undefined,
      })
    }
    console.error(`Claude messages upstream error ${response.status}: ${redactSecrets(text).slice(0, LOG_BODY_PREVIEW_LIMIT)}`)
    return claudeErrorResponse(claudeUpstreamErrorMessage(response.status, text), response.status)
  }

  const proxyLog: RequestProxyLog | undefined = options?.onProxy ? {
    label: "Upstream responses",
    method: "POST",
    target: "upstream",
    status: response.status,
    durationMs,
    error: "-",
    requestBody,
  } : undefined
  if (proxyLog) options?.onProxy?.(proxyLog)

  if (response.body && shouldCaptureProxyBody && proxyLog) {
    response = interceptResponseStream(response, {
      onComplete: (responseBody) => { proxyLog.responseBody = responseBody },
    })
  }

  if (body.stream) {
    const canonicalStream = client.streamResponse(response, body.model)
    return claudeCanonicalStreamResponse(canonicalStream, body, {
      onCancel: (reason) => {
        if (!options?.onProxy) return
        options.onProxy({
          label: "Upstream responses (stream cancelled)",
          method: "POST",
          target: "upstream",
          status: 200,
          durationMs: Date.now() - started,
          error: `stream cancelled: ${reason instanceof Error ? reason.message : String(reason ?? "client disconnected")}`,
          requestBody,
        })
      },
    })
  }
  const canonicalResponse = await client.collectResponse(response, body.model)
  return Response.json(await canonicalResponseToClaudeMessage(canonicalResponse, body))
}

export async function handleClaudeCountTokens(request: Request) {
  let body: ClaudeMessagesRequest
  try {
    body = (await request.json()) as ClaudeMessagesRequest
  } catch (error) {
    return claudeErrorResponse(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, 400)
  }

  if (!body.model || typeof body.model !== "string") return claudeErrorResponse("Claude count_tokens request requires model", 400)
  if (!Array.isArray(body.messages)) return claudeErrorResponse("Claude count_tokens request requires messages", 400)

  return Response.json({
    input_tokens: countClaudeInputTokens(body),
  })
}

function stringifyBody(body: JsonObject) {
  return redactSecrets(JSON.stringify(normalizeReasoningBody(body)))
}

function previewText(text: string) {
  return text.slice(0, LOG_BODY_PREVIEW_LIMIT)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function redactSecrets(text: string) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(
      /"?(api[_-]?key|authorization|authorization_token|x-api-key|anthropic-api-key|access|refresh|access_token|refresh_token)"?\s*:\s*"[^"]+"/gi,
      '"$1":"[redacted]"',
    )
}
