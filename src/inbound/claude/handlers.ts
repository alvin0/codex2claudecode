import { LOG_BODY_PREVIEW_LIMIT } from "../../core/constants"
import { createLogPreview } from "../../core/log-preview"
import type { CodexStandaloneClient } from "../../upstream/codex/client"
import { normalizeReasoningBody } from "../../core/reasoning"
import type { ClaudeMessagesRequest, JsonObject, RequestProxyLog } from "../types"

import { claudeToResponsesBody } from "./codex-convert"
import { countClaudeInputTokens } from "./convert"
import { claudeUpstreamErrorMessage } from "./context-limit"
import { claudeErrorResponse } from "./errors"
import { collectClaudeMessage, claudeStreamResponse } from "./codex-response"

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
  const shouldCaptureProxyBody = options?.logBody === true && options.onProxy !== undefined
  const requestBody = shouldCaptureProxyBody ? previewText(stringifyBody(responsesBody)) : undefined
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
    console.error(`Claude messages upstream error ${response.status}: ${text.slice(0, LOG_BODY_PREVIEW_LIMIT)}`)
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
    response = responseWithLoggedBody(response as Response & { body: ReadableStream<Uint8Array> }, (responseBody) => {
      proxyLog.responseBody = responseBody
    })
  }

  if (body.stream) return claudeStreamResponse(response, body, {
    onStreamError: (error) => {
      if (!options?.onProxy) return
      options.onProxy({
        label: "Upstream responses (stream error)",
        method: "POST",
        target: "upstream",
        status: 200,
        durationMs: Date.now() - started,
        error,
        requestBody,
      })
    },
  })
  return Response.json(await collectClaudeMessage(response, body))
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

function responseWithLoggedBody(response: Response & { body: ReadableStream<Uint8Array> }, onComplete: (responseBody?: string) => void) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const preview = createLogPreview()
  let completed = false

  function complete() {
    if (completed) return
    completed = true
    const tail = decoder.decode()
    preview.append(tail)
    onComplete(preview.text())
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          complete()
          controller.close()
          return
        }
        controller.enqueue(chunk.value)
        preview.append(decoder.decode(chunk.value, { stream: true }))
      } catch (error) {
        complete()
        controller.error(error)
      }
    },
    cancel(reason) {
      complete()
      return reader.cancel(reason)
    },
  })

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
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
