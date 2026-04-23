import type { Canonical_ErrorResponse, Canonical_PassthroughResponse, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import type { Inbound_Provider, RequestHandlerContext, Route_Descriptor, UpstreamResult, Upstream_Provider } from "../../core/interfaces"
import { LOG_BODY_PREVIEW_LIMIT } from "../../core/constants"
import type { RequestProxyLog } from "../../core/types"
import { claudeToCanonicalRequest, countClaudeInputTokens } from "./convert"
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
      let body: ClaudeMessagesRequest
      try {
        body = (await request.json()) as ClaudeMessagesRequest
      } catch (error) {
        return claudeErrorResponse(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      if (!body.model || typeof body.model !== "string") return claudeErrorResponse("Claude count_tokens request requires model", 400)
      if (!Array.isArray(body.messages)) return claudeErrorResponse("Claude count_tokens request requires messages", 400)
      return Response.json({ input_tokens: countClaudeInputTokens(body) })
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
    let result: UpstreamResult
    try {
      result = await upstream.proxy(canonicalRequest, {
        headers: request.headers,
        signal: request.signal,
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
      } satisfies RequestProxyLog)
      return claudeErrorResponse(`Codex request failed: ${result.status} ${result.body}`, result.status)
    }

    context.onProxy?.({
      label: "Codex responses",
      method: "POST",
      target: "/v1/responses",
      status: "status" in result ? result.status : 200,
      durationMs,
      error: "-",
      requestBody,
    } satisfies RequestProxyLog)

    if (isCanonicalStream(result)) return claudeCanonicalStreamResponse(result, body)
    if (isCanonicalResponse(result)) return Response.json(await canonicalResponseToClaudeMessage(result, body))
    if (isCanonicalPassthrough(result)) return claudeErrorResponse("Unexpected passthrough response for Claude inbound provider", 500)
    return claudeErrorResponse("Unexpected upstream response", 500)
  }
}

export { handleClaudeCountTokens, handleClaudeMessages } from "./handlers"

function previewText(text: string) {
  return text.slice(0, LOG_BODY_PREVIEW_LIMIT)
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
