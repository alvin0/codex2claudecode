import type { Canonical_ErrorResponse, Canonical_PassthroughResponse, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import type { Inbound_Provider, RequestHandlerContext, Route_Descriptor, UpstreamResult, Upstream_Provider } from "../../core/interfaces"
import { LOG_BODY_PREVIEW_LIMIT } from "../../core/constants"
import { createLogPreview } from "../../core/log-preview"
import type { RequestProxyLog } from "../../core/types"
import { claudeToCanonicalRequest } from "./convert"
import { claudeErrorResponse } from "./errors"
import { canonicalResponseToClaudeMessage, claudeCanonicalStreamResponse } from "./response"
import { Model_Catalog, claudeSettingsModelResolver } from "./models"
import type { ClaudeMessagesRequest } from "./types"

export class Claude_Inbound_Provider implements Inbound_Provider {
  readonly name = "claude"
  private readonly modelCatalog: Model_Catalog

  constructor(private readonly modelResolver: () => Promise<string[]> = claudeSettingsModelResolver) {
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

    const requestBody = context.logBody ? previewText(JSON.stringify(canonicalRequest)) : undefined
    const started = Date.now()
    const upstreamResponsePreview = createLogPreview()
    let result: UpstreamResult
    try {
      result = await upstream.proxy(canonicalRequest, {
        headers: request.headers,
        signal: request.signal,
        onResponseBodyChunk: (chunk) => upstreamResponsePreview.append(chunk),
      })
    } catch (error) {
      return claudeErrorResponse(error instanceof Error ? error.message : String(error), 500)
    }
    const durationMs = Date.now() - started

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
      } satisfies RequestProxyLog)
      return claudeErrorResponse(`Codex request failed: ${result.status} ${result.body}`, result.status)
    }

    const proxyLog: RequestProxyLog = {
      label: "Codex responses",
      method: "POST",
      target: "/v1/responses",
      status: "status" in result ? result.status : 200,
      durationMs,
      error: "-",
      requestBody,
    }
    context.onProxy?.(proxyLog)

    if (isCanonicalStream(result)) {
      return claudeCanonicalStreamResponse(withLoggedCanonicalStream(result, proxyLog, started, () => upstreamResponsePreview.text()), body, {
        onCancel: (reason) => {
          proxyLog.durationMs = Date.now() - started
          proxyLog.error = `stream cancelled: ${reasonText(reason)}`
          proxyLog.responseBody = upstreamResponsePreview.text()
        },
      })
    }
    if (isCanonicalResponse(result)) {
      proxyLog.responseBody = upstreamResponsePreview.text()
      return Response.json(await canonicalResponseToClaudeMessage(result, body))
    }
    if (isCanonicalPassthrough(result)) return claudeErrorResponse("Unexpected passthrough response for Claude inbound provider", 500)
    return claudeErrorResponse("Unexpected upstream response", 500)
  }

  private async handleCountTokens(request: Request, upstream: Upstream_Provider, context: RequestHandlerContext): Promise<Response> {
    if (!upstream.inputTokens) return claudeErrorResponse("Codex input token count is not implemented", 501)

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

    const requestBody = context.logBody ? previewText(JSON.stringify(canonicalRequest)) : undefined
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
      context.onProxy?.({
        label: "OpenAI input tokens",
        method: "POST",
        target: "/v1/responses/input_tokens",
        status: response.status,
        durationMs,
        error: previewText(text) || "-",
        requestBody,
        responseBody: previewText(text) || undefined,
      })
      return claudeErrorResponse(`Codex input token count failed: ${response.status} ${text}`, response.status)
    }

    const text = await response.text()
    context.onProxy?.({
      label: "OpenAI input tokens",
      method: "POST",
      target: "/v1/responses/input_tokens",
      status: response.status,
      durationMs,
      error: "-",
      requestBody,
      responseBody: previewText(text) || undefined,
    })

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
}

export { handleClaudeCountTokens, handleClaudeMessages } from "./handlers"

function previewText(text: string) {
  return text.slice(0, LOG_BODY_PREVIEW_LIMIT)
}

function withLoggedCanonicalStream(response: Canonical_StreamResponse, proxyLog: RequestProxyLog, started: number, responseBody: () => string | undefined): Canonical_StreamResponse {
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
      proxyLog.responseBody = responseBody()
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
