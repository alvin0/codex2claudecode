import type { Canonical_ErrorResponse, Canonical_PassthroughResponse, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import type { Inbound_Provider, RequestHandlerContext, Route_Descriptor, UpstreamProviderKind, UpstreamResult, Upstream_Provider } from "../../core/interfaces"
import { LOG_BODY_PREVIEW_LIMIT } from "../../core/constants"
import { createKiroDebugBundle, kiroDebugOnErrorEnabled, redactSensitiveText } from "../../core/debug-capture"
import { createLogPreview } from "../../core/log-preview"
import type { RequestOptions, RequestProxyLog } from "../../core/types"
import { claudeToCanonicalRequest, countClaudeInputTokens } from "./convert"
import { claudeUpstreamErrorMessage } from "./context-limit"
import { claudeErrorResponse } from "./errors"
import { canonicalResponseToClaudeMessage, claudeCanonicalStreamResponse } from "./response"
import { Model_Catalog, claudeSettingsModelResolver } from "./models"
import type { ClaudeMessagesRequest } from "./types"

export interface ClaudeInboundProviderOptions {
  name?: string
  modelResolver?: () => Promise<string[]>
  upstreamLogLabel?: string
  inputTokensLogLabel?: string
  expectedUpstreamKind?: UpstreamProviderKind
  localCountTokens?: boolean
  countTokens?: (body: ClaudeMessagesRequest) => number
}

export class Claude_Inbound_Provider implements Inbound_Provider {
  readonly name: string
  private readonly modelCatalog: Model_Catalog
  private readonly modelResolver: () => Promise<string[]>
  private readonly upstreamLogLabel: string
  private readonly inputTokensLogLabel: string
  private readonly expectedUpstreamKind?: UpstreamProviderKind
  private readonly localCountTokens: boolean
  private readonly countTokens: (body: ClaudeMessagesRequest) => number

  constructor(optionsOrModelResolver: ClaudeInboundProviderOptions | (() => Promise<string[]>) = {}) {
    const options = typeof optionsOrModelResolver === "function" ? { modelResolver: optionsOrModelResolver } : optionsOrModelResolver
    this.name = options.name ?? "claude"
    this.modelResolver = options.modelResolver ?? claudeSettingsModelResolver
    this.upstreamLogLabel = options.upstreamLogLabel ?? "Upstream responses"
    this.inputTokensLogLabel = options.inputTokensLogLabel ?? "OpenAI input tokens"
    this.expectedUpstreamKind = options.expectedUpstreamKind
    this.localCountTokens = options.localCountTokens ?? false
    this.countTokens = options.countTokens ?? countClaudeInputTokens
    this.modelCatalog = new Model_Catalog()
  }

  routes(): Route_Descriptor[] {
    return [
      { path: "/v1/messages", method: "POST" },
      { path: "/v1/message", method: "POST" },
      { path: "/v1/messages/count_tokens", method: "POST" },
      { path: "/v1/models", method: "GET" },
      { path: "/v1/models/:model_id", method: "GET" },
    ]
  }

  async handle(request: Request, route: Route_Descriptor, upstream: Upstream_Provider, context: RequestHandlerContext): Promise<Response> {
    const upstreamMismatch = this.upstreamMismatch(upstream)
    if (upstreamMismatch) return claudeErrorResponse(upstreamMismatch, 500)

    if (route.path === "/v1/models") {
      return Response.json(await this.modelCatalog.listModels(this.modelResolver, {
        afterId: new URL(request.url).searchParams.get("after_id") ?? undefined,
        beforeId: new URL(request.url).searchParams.get("before_id") ?? undefined,
        limit: new URL(request.url).searchParams.get("limit") ? Number(new URL(request.url).searchParams.get("limit")) : undefined,
      }))
    }

    if (route.path === "/v1/models/:model_id") {
      const pathname = new URL(request.url).pathname
      const modelId = decodeURIComponent(pathname.slice("/v1/models/".length))
      const model = this.modelCatalog.getModel(modelId)
      if (!model) {
        return Response.json(
          {
            type: "error",
            error: {
              type: "not_found_error",
              message: `Model '${modelId}' not found. Use GET /v1/models to list available models.`,
            },
          },
          { status: 404 },
        )
      }
      return Response.json(model)
    }

    if (route.path === "/v1/messages/count_tokens") {
      return this.handleCountTokens(request, upstream, context)
    }

    let body: ClaudeMessagesRequest
    try {
      body = (await request.json()) as ClaudeMessagesRequest
    } catch (error) {
      return claudeErrorResponse(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, 400)
    }

    if (!Array.isArray(body.messages)) return claudeErrorResponse("Claude messages request requires messages", 400)

    let canonicalRequest
    try {
      canonicalRequest = claudeToCanonicalRequest(body)
    } catch (error) {
      return claudeErrorResponse(error instanceof Error ? error.message : String(error), 400)
    }

    const shouldCaptureProxyBody = context.logBody && context.onProxy !== undefined
    let requestBody = shouldCaptureProxyBody ? previewText(JSON.stringify(canonicalRequest)) : undefined
    let upstreamResponseBody: (() => string | undefined) | undefined
    const proxyBodyOptions: RequestOptions = {}
    if (shouldCaptureProxyBody) {
      const upstreamResponsePreview = createLogPreview()
      upstreamResponseBody = () => upstreamResponsePreview.text()
      proxyBodyOptions.onRequestBody = (body) => {
        requestBody = previewText(body)
      }
      proxyBodyOptions.onResponseBodyChunk = (chunk) => upstreamResponsePreview.append(chunk)
    }
    const started = Date.now()
    let result: UpstreamResult
    try {
      result = await upstream.proxy(canonicalRequest, {
        headers: request.headers,
        signal: request.signal,
        ...proxyBodyOptions,
      })
    } catch (error) {
      return claudeErrorResponse(error instanceof Error ? error.message : String(error), 500)
    }
    const durationMs = Date.now() - started

    if (isCanonicalError(result)) {
      if (context.onProxy) {
        const proxyLog: RequestProxyLog = {
          label: this.upstreamLogLabel,
          method: "POST",
          target: "upstream",
          status: result.status,
          durationMs,
          error: previewText(result.body) || "-",
          requestBody,
          responseBody: shouldCaptureProxyBody ? previewText(result.body) || undefined : undefined,
        }
        if (this.expectedUpstreamKind === "kiro" && kiroDebugOnErrorEnabled()) {
          proxyLog.debug = createKiroDebugBundle({
            route: route.path,
            status: result.status,
            model: body.model,
            error: result.body,
            requestBody: shouldCaptureProxyBody ? previewText(JSON.stringify(body)) : undefined,
            upstreamRequestBody: requestBody,
            upstreamResponseBody: upstreamResponseBody?.(),
            transformedResponseBody: result.body,
          })
        }
        context.onProxy(proxyLog)
      }
      return claudeErrorResponse(claudeUpstreamErrorMessage(result.status, result.body), result.status)
    }

    const proxyLog: RequestProxyLog | undefined = context.onProxy ? {
      label: this.upstreamLogLabel,
      method: "POST",
      target: "upstream",
      status: "status" in result ? result.status : 200,
      durationMs,
      error: "-",
      requestBody,
    } : undefined
    if (proxyLog) context.onProxy?.(proxyLog)

    if (isCanonicalStream(result)) {
      if (!proxyLog) return claudeCanonicalStreamResponse(result, body)
      return claudeCanonicalStreamResponse(withLoggedCanonicalStream(result, proxyLog, started, upstreamResponseBody), body, {
        onCancel: (reason) => {
          proxyLog.durationMs = Date.now() - started
          proxyLog.error = `stream cancelled: ${reasonText(reason)}`
          if (shouldCaptureProxyBody) proxyLog.responseBody = upstreamResponseBody?.()
        },
      })
    }
    if (isCanonicalResponse(result)) {
      if (proxyLog && shouldCaptureProxyBody) proxyLog.responseBody = upstreamResponseBody?.()
      return Response.json(await canonicalResponseToClaudeMessage(result, body))
    }
    if (isCanonicalPassthrough(result)) return claudeErrorResponse("Unexpected passthrough response for Claude inbound provider", 500)
    return claudeErrorResponse("Unexpected upstream response", 500)
  }

  private async handleCountTokens(request: Request, upstream: Upstream_Provider, context: RequestHandlerContext): Promise<Response> {
    let body: ClaudeMessagesRequest
    try {
      body = (await request.json()) as ClaudeMessagesRequest
    } catch (error) {
      return claudeErrorResponse(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, 400)
    }
    if (!body.model || typeof body.model !== "string") return claudeErrorResponse("Claude count_tokens request requires model", 400)
    if (!Array.isArray(body.messages)) return claudeErrorResponse("Claude count_tokens request requires messages", 400)

    let canonicalRequest
    try {
      canonicalRequest = claudeToCanonicalRequest({ ...body, stream: false })
    } catch (error) {
      return claudeErrorResponse(error instanceof Error ? error.message : String(error), 400)
    }

    if (this.localCountTokens) {
      if (body.messages.length === 0) return claudeErrorResponse("Claude count_tokens request requires messages", 400)
      return localCountTokensResponse(body, this.countTokens)
    }

    if (!upstream.inputTokens) return localCountTokensResponse(body, this.countTokens)

    const shouldCaptureProxyBody = context.logBody && context.onProxy !== undefined
    const requestBody = shouldCaptureProxyBody ? previewText(JSON.stringify(canonicalRequest)) : undefined
    const started = Date.now()
    let response: Response
    try {
      response = await upstream.inputTokens(canonicalRequest, {
        headers: request.headers,
        signal: request.signal,
      })
    } catch (error) {
      return claudeErrorResponse(error instanceof Error ? error.message : String(error), 500)
    }
    const durationMs = Date.now() - started

    if (!response.ok) {
      const text = await response.text()
      if (context.onProxy) {
        context.onProxy({
          label: this.inputTokensLogLabel,
          method: "POST",
          target: "/v1/responses/input_tokens",
          status: response.status,
          durationMs,
          error: previewText(text) || "-",
          requestBody,
          responseBody: shouldCaptureProxyBody ? previewText(text) || undefined : undefined,
        })
      }
      if (response.status === 401 || response.status === 403) return localCountTokensResponse(body, this.countTokens)
      return claudeErrorResponse(`Upstream input token count failed: ${response.status} ${text}`, response.status)
    }

    const text = await response.text()
    if (context.onProxy) {
      context.onProxy({
        label: this.inputTokensLogLabel,
        method: "POST",
        target: "/v1/responses/input_tokens",
        status: response.status,
        durationMs,
        error: "-",
        requestBody,
        responseBody: shouldCaptureProxyBody ? previewText(text) || undefined : undefined,
      })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return claudeErrorResponse(`Invalid input token response: ${error instanceof Error ? error.message : String(error)}`, 502)
    }
    const inputTokens = parsed && typeof parsed === "object" && typeof (parsed as { input_tokens?: unknown }).input_tokens === "number"
      ? (parsed as { input_tokens: number }).input_tokens
      : undefined
    if (inputTokens === undefined) return claudeErrorResponse("Invalid input token response: missing input_tokens", 502)

    return Response.json({ input_tokens: inputTokens })
  }

  private upstreamMismatch(upstream: Upstream_Provider) {
    if (!this.expectedUpstreamKind || upstream.providerKind === this.expectedUpstreamKind) return
    return `Claude inbound provider '${this.name}' expected ${this.expectedUpstreamKind} upstream, received ${upstream.providerKind}`
  }
}


function previewText(text: string) {
  return redactSensitiveText(text).slice(0, LOG_BODY_PREVIEW_LIMIT)
}

function localCountTokensResponse(body: ClaudeMessagesRequest, countTokens: (body: ClaudeMessagesRequest) => number) {
  return Response.json({ input_tokens: countTokens(body) })
}

function withLoggedCanonicalStream(response: Canonical_StreamResponse, proxyLog: RequestProxyLog, started: number, responseBody?: () => string | undefined): Canonical_StreamResponse {
  async function* events() {
    let completed = false
    try {
      for await (const event of response.events) {
        yield event
      }
      completed = true
    } catch (error) {
      proxyLog.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      proxyLog.durationMs = Date.now() - started
      if (!completed && proxyLog.error === "-") proxyLog.error = "stream cancelled"
      if (responseBody) proxyLog.responseBody = responseBody()
    }
  }

  return {
    ...response,
    events: events(),
  }
}

function reasonText(reason: unknown) {
  if (reason === undefined) return "client disconnected"
  if (reason instanceof Error) return reason.message
  return String(reason)
}

function isCanonicalError(result: UpstreamResult): result is Canonical_ErrorResponse {
  return result.type === "canonical_error"
}

function isCanonicalPassthrough(result: UpstreamResult): result is Canonical_PassthroughResponse {
  return result.type === "canonical_passthrough"
}

function isCanonicalResponse(result: UpstreamResult): result is Canonical_Response {
  return result.type === "canonical_response"
}

function isCanonicalStream(result: UpstreamResult): result is Canonical_StreamResponse {
  return result.type === "canonical_stream"
}
