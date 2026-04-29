import type { Canonical_ErrorResponse, Canonical_PassthroughResponse, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import type { Inbound_Provider, RequestHandlerContext, Route_Descriptor, UpstreamProviderKind, UpstreamResult, Upstream_Provider } from "../../core/interfaces"
import { responseHeaders } from "../../core/http"
import { LOG_BODY_PREVIEW_LIMIT } from "../../core/constants"
import { createKiroDebugBundle, kiroDebugOnErrorEnabled, redactSensitiveText } from "../../core/debug-capture"
import { createLogPreview } from "../../core/log-preview"
import type { JsonObject, RequestProxyLog } from "../../core/types"
import { normalizeCanonicalRequest, normalizeRequestBody } from "./normalize"
import { openAICanonicalResponse, openAICanonicalStreamResponse } from "./response"

interface OpenAIInboundProviderOptions {
  name?: string
  routes?: Route_Descriptor[]
  passthrough?: boolean
  upstreamLogLabel?: string
  upstreamTarget?: string
  expectedUpstreamKind?: UpstreamProviderKind
}

export class OpenAI_Inbound_Provider implements Inbound_Provider {
  readonly name: string
  private readonly routeDescriptors: Route_Descriptor[]
  private readonly passthrough: boolean
  private readonly upstreamLogLabel: string
  private readonly upstreamTarget: string
  private readonly expectedUpstreamKind?: UpstreamProviderKind

  constructor(options: OpenAIInboundProviderOptions = {}) {
    this.name = options.name ?? "openai"
    this.routeDescriptors = options.routes ?? [
      { path: "/v1/responses", method: "POST" },
      { path: "/v1/chat/completions", method: "POST" },
    ]
    this.passthrough = options.passthrough ?? true
    this.upstreamLogLabel = options.upstreamLogLabel ?? "Codex responses"
    this.upstreamTarget = options.upstreamTarget ?? "/v1/responses"
    this.expectedUpstreamKind = options.expectedUpstreamKind
  }

  routes(): Route_Descriptor[] {
    return this.routeDescriptors
  }

  async handle(request: Request, route: Route_Descriptor, upstream: Upstream_Provider, context: RequestHandlerContext): Promise<Response> {
    const upstreamMismatch = this.upstreamMismatch(upstream)
    if (upstreamMismatch) return openAIErrorResponse(upstreamMismatch, 500, "server_error")

    let body: unknown
    try {
      body = await request.json()
    } catch (error) {
      if (!this.passthrough) {
        return openAIErrorResponse(
          `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          400,
          "invalid_request_error",
        )
      }
      return Response.json(
        {
          error: {
            message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          },
        },
        { status: 500 },
      )
    }

    if (!isJsonObject(body)) {
      return openAIErrorResponse("Request body must be a JSON object", 400, "invalid_request_error")
    }

    const wireBody = body as JsonObject
    if (!this.passthrough) {
      const validationError = validateOpenAIRequestShape(route.path, wireBody)
      if (validationError) return openAIErrorResponse(validationError, 400, "invalid_request_error")
    }

    const shouldCaptureProxyBody = context.logBody && context.onProxy !== undefined
    const requestBody = shouldCaptureProxyBody ? previewText(JSON.stringify(normalizeRequestBody(route.path, wireBody))) : undefined
    const upstreamRequestPreview = shouldCaptureProxyBody && !this.passthrough ? createLogPreview() : undefined
    const upstreamResponsePreview = shouldCaptureProxyBody && !this.passthrough ? createLogPreview() : undefined
    const started = Date.now()
    const result = await upstream.proxy(normalizeCanonicalRequest(route.path, wireBody, { passthrough: this.passthrough }), {
      headers: request.headers,
      signal: request.signal,
      ...(upstreamRequestPreview && upstreamResponsePreview ? {
        onRequestBody: (nextBody) => upstreamRequestPreview.append(nextBody),
        onResponseBodyChunk: (chunk) => upstreamResponsePreview.append(chunk),
      } : {}),
    })
    const durationMs = Date.now() - started
    const proxyRequestBody = upstreamRequestPreview?.text() || requestBody

    if (isCanonicalPassthrough(result)) {
      const proxyLog: RequestProxyLog | undefined = context.onProxy ? {
        label: this.upstreamLogLabel,
        method: "POST",
        target: this.upstreamTarget,
        status: result.status,
        durationMs,
        error: "-",
        requestBody: proxyRequestBody,
      } : undefined
      if (proxyLog) context.onProxy?.(proxyLog)
      const response = new Response(passthroughBodyInit(result.body), {
        status: result.status,
        statusText: result.statusText,
        headers: responseHeaders(result.headers),
      })
      if (!response.body || !shouldCaptureProxyBody || !proxyLog) return response
      return responseWithLoggedBody(response as Response & { body: ReadableStream<Uint8Array> }, (responseBody) => {
        proxyLog.responseBody = responseBody
      })
    }

    if (isCanonicalError(result)) {
      const proxyLog: RequestProxyLog | undefined = context.onProxy ? {
        label: this.upstreamLogLabel,
        method: "POST",
        target: this.upstreamTarget,
        status: result.status,
        durationMs,
        error: previewText(result.body) || "-",
        requestBody: proxyRequestBody,
        responseBody: shouldCaptureProxyBody ? previewText(result.body) || undefined : undefined,
      } : undefined
      if (proxyLog && this.expectedUpstreamKind === "kiro" && kiroDebugOnErrorEnabled()) {
        proxyLog.debug = createKiroDebugBundle({
          route: route.path,
          status: result.status,
          model: wireBody.model,
          error: result.body,
          requestBody,
          upstreamRequestBody: proxyRequestBody,
          upstreamResponseBody: upstreamResponsePreview?.text(),
          transformedResponseBody: result.body,
        })
      }
      if (proxyLog) context.onProxy?.(proxyLog)
      if (!this.passthrough) {
        return openAIErrorResponse(result.body, result.status, "upstream_error", result.headers)
      }
      return new Response(result.body, {
        status: result.status,
        headers: responseHeaders(result.headers),
      })
    }

    if (isCanonicalResponse(result)) {
      if (this.passthrough) return unexpectedNonPassthroughResponse()
      const response = openAICanonicalResponse(result, route.path, wireBody)
      if (context.onProxy) {
        context.onProxy({
          label: this.upstreamLogLabel,
          method: "POST",
          target: this.upstreamTarget,
          status: 200,
          durationMs,
          error: "-",
          requestBody: proxyRequestBody,
          responseBody: shouldCaptureProxyBody ? upstreamResponsePreview?.text() || undefined : undefined,
        })
      }
      return response
    }

    if (isCanonicalStream(result)) {
      if (this.passthrough) return unexpectedNonPassthroughResponse()
      const proxyLog: RequestProxyLog | undefined = context.onProxy ? {
        label: this.upstreamLogLabel,
        method: "POST",
        target: this.upstreamTarget,
        status: result.status,
        durationMs,
        error: "-",
        requestBody: proxyRequestBody,
        responseBody: shouldCaptureProxyBody ? upstreamResponsePreview?.text() || undefined : undefined,
      } : undefined
      if (proxyLog) context.onProxy?.(proxyLog)
      const response = openAICanonicalStreamResponse(result, route.path, wireBody)
      if (!response.body || !shouldCaptureProxyBody || !proxyLog) return response
      return responseWithLoggedBody(response as Response & { body: ReadableStream<Uint8Array> }, (responseBody) => {
        proxyLog.responseBody = upstreamResponsePreview?.text() || responseBody
      })
    }

    return unexpectedNonPassthroughResponse()
  }

  private upstreamMismatch(upstream: Upstream_Provider) {
    if (!this.expectedUpstreamKind || upstream.providerKind === this.expectedUpstreamKind) return
    return `OpenAI inbound provider '${this.name}' expected ${this.expectedUpstreamKind} upstream, received ${upstream.providerKind}`
  }
}

function unexpectedNonPassthroughResponse() {
  return Response.json(
    {
      error: {
        message: "Unexpected non-passthrough response for OpenAI inbound provider",
      },
    },
    { status: 500 },
  )
}

function isCanonicalPassthrough(result: UpstreamResult): result is Canonical_PassthroughResponse {
  return result.type === "canonical_passthrough"
}

function isCanonicalError(result: UpstreamResult): result is Canonical_ErrorResponse {
  return result.type === "canonical_error"
}

function isCanonicalResponse(result: UpstreamResult): result is Canonical_Response {
  return result.type === "canonical_response"
}

function isCanonicalStream(result: UpstreamResult): result is Canonical_StreamResponse {
  return result.type === "canonical_stream"
}

function previewText(text: string) {
  return redactSensitiveText(text).slice(0, LOG_BODY_PREVIEW_LIMIT)
}

function openAIErrorResponse(message: string, status: number, type: string, sourceHeaders = new Headers()) {
  const headers = responseHeaders(sourceHeaders)
  headers.set("content-type", "application/json; charset=utf-8")
  return Response.json(
    {
      error: {
        message,
        type,
        param: null,
        code: null,
      },
    },
    { status, headers },
  )
}

function validateOpenAIRequestShape(pathname: string, body: JsonObject): string | undefined {
  if (!hasRequiredModel(body)) return "Missing required parameter: 'model'."

  if (pathname === "/v1/responses") {
    if ("messages" in body) return "Unsupported parameter: 'messages'. Use 'input' with /v1/responses."
    if ("response_format" in body) return "Unsupported parameter: 'response_format'. Use 'text.format' with /v1/responses."
    if (!hasResponsesInput(body.input)) return "Missing required parameter: 'input'."
    return
  }

  if (pathname === "/v1/chat/completions") {
    if ("input" in body) return "Unsupported parameter: 'input'. Use 'messages' with /v1/chat/completions."
    if ("text" in body) return "Unsupported parameter: 'text'. Use 'response_format' with /v1/chat/completions."
    if (!Array.isArray(body.messages) || body.messages.length === 0) return "Missing required parameter: 'messages'."
  }
}

function hasRequiredModel(body: JsonObject) {
  return typeof body.model === "string" && body.model.trim().length > 0
}

function hasResponsesInput(value: unknown) {
  if (typeof value === "string") return value.length > 0
  return Array.isArray(value) && value.length > 0
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
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
