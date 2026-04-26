import type { Canonical_ErrorResponse, Canonical_PassthroughResponse } from "../../core/canonical"
import type { Inbound_Provider, RequestHandlerContext, Route_Descriptor, UpstreamResult, Upstream_Provider } from "../../core/interfaces"
import { responseHeaders } from "../../core/http"
import { LOG_BODY_PREVIEW_LIMIT } from "../../core/constants"
import { createLogPreview } from "../../core/log-preview"
import type { RequestProxyLog } from "../../core/types"
import { normalizeCanonicalRequest, normalizeRequestBody } from "./normalize"

export class OpenAI_Inbound_Provider implements Inbound_Provider {
  readonly name = "openai"

  routes(): Route_Descriptor[] {
    return [
      { path: "/v1/responses", method: "POST" },
      { path: "/v1/chat/completions", method: "POST" },
    ]
  }

  async handle(request: Request, route: Route_Descriptor, upstream: Upstream_Provider, context: RequestHandlerContext): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch (error) {
      return Response.json(
        {
          error: {
            message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          },
        },
        { status: 500 },
      )
    }

    const requestBody = context.logBody ? previewText(JSON.stringify(normalizeRequestBody(route.path, body as Record<string, unknown>))) : undefined
    const started = Date.now()
    const result = await upstream.proxy(normalizeCanonicalRequest(route.path, body as Record<string, unknown>), {
      headers: request.headers,
      signal: request.signal,
    })
    const durationMs = Date.now() - started

    if (isCanonicalPassthrough(result)) {
      const proxyLog: RequestProxyLog = {
        label: "Codex responses",
        method: "POST",
        target: "/v1/responses",
        status: result.status,
        durationMs,
        error: "-",
        requestBody,
      }
      context.onProxy?.(proxyLog)
      const response = new Response(passthroughBodyInit(result.body), {
        status: result.status,
        statusText: result.statusText,
        headers: responseHeaders(result.headers),
      })
      if (!response.body) return response
      return responseWithLoggedBody(response as Response & { body: ReadableStream<Uint8Array> }, (responseBody) => {
        proxyLog.responseBody = responseBody
      })
    }

    if (isCanonicalError(result)) {
      context.onProxy?.({
        label: "Codex responses",
        method: "POST",
        target: "/v1/responses",
        status: result.status,
        durationMs,
        error: previewText(result.body) || "-",
        requestBody,
        responseBody: previewText(result.body) || undefined,
      })
      return new Response(result.body, {
        status: result.status,
        headers: responseHeaders(result.headers),
      })
    }

    return Response.json(
      {
        error: {
          message: "Unexpected non-passthrough response for OpenAI inbound provider",
        },
      },
      { status: 500 },
    )
  }
}

function isCanonicalPassthrough(result: UpstreamResult): result is Canonical_PassthroughResponse {
  return result.type === "canonical_passthrough"
}

function isCanonicalError(result: UpstreamResult): result is Canonical_ErrorResponse {
  return result.type === "canonical_error"
}

function previewText(text: string) {
  return text.slice(0, LOG_BODY_PREVIEW_LIMIT)
}

function passthroughBodyInit(body: Canonical_PassthroughResponse["body"]): BodyInit | null {
  if (body instanceof Uint8Array) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  return body
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
