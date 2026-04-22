import { LOG_BODY_PREVIEW_LIMIT } from "../constants"
import type { CodexStandaloneClient } from "../client"
import { normalizeReasoningBody } from "../reasoning"
import type { ClaudeMessagesRequest, JsonObject, RequestProxyLog } from "../types"

import { claudeToResponsesBody, countClaudeInputTokens } from "./convert"
import { claudeErrorResponse } from "./errors"
import { collectClaudeMessage, claudeStreamResponse } from "./response"

export async function handleClaudeMessages(
  client: CodexStandaloneClient,
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
  const requestBody = previewText(stringifyBody(responsesBody))
  if (options?.logBody) logUpstreamBody(requestId, responsesBody)

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
    options?.onProxy?.({
      label: "Codex responses",
      method: "POST",
      target: "/v1/responses",
      status: response.status,
      durationMs,
      error: redactSecrets(text).slice(0, LOG_BODY_PREVIEW_LIMIT) || "-",
      requestBody,
    })
    console.error(`Claude messages upstream error ${response.status}: ${text.slice(0, LOG_BODY_PREVIEW_LIMIT)}`)
    return claudeErrorResponse(`Codex request failed: ${response.status} ${text}`, response.status)
  }

  options?.onProxy?.({
    label: "Codex responses",
    method: "POST",
    target: "/v1/responses",
    status: response.status,
    durationMs,
    error: "-",
    requestBody,
  })

  if (body.stream) return claudeStreamResponse(response, body)
  return Response.json(await collectClaudeMessage(response, body))
}

export async function handleClaudeCountTokens(request: Request) {
  let body: ClaudeMessagesRequest
  try {
    body = (await request.json()) as ClaudeMessagesRequest
  } catch (error) {
    return claudeErrorResponse(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, 400)
  }

  if (!Array.isArray(body.messages)) return claudeErrorResponse("Claude count_tokens request requires messages", 400)

  return Response.json({
    input_tokens: countClaudeInputTokens(body),
  })
}

function logUpstreamBody(id: string, body: JsonObject) {
  console.log(
    `[${id}] upstream body ${previewText(stringifyBody(body))}`,
  )
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
      /"?(api[_-]?key|authorization|x-api-key|anthropic-api-key|access|refresh|access_token|refresh_token)"?\s*:\s*"[^"]+"/gi,
      '"$1":"[redacted]"',
    )
}
