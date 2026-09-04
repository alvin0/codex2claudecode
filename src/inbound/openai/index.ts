import type { Canonical_ErrorResponse, Canonical_PassthroughResponse, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import type { Inbound_Provider, PassthroughDecider, ProviderModelDescriptor, RequestHandlerContext, Route_Descriptor, UpstreamProviderKind, UpstreamResult, Upstream_Provider } from "../../core/interfaces"
import { accumulateCanonicalStream } from "../../core/canonical-accumulator"
import { responseHeaders } from "../../core/http"
import { LOG_BODY_PREVIEW_LIMIT } from "../../core/constants"
import { createKiroDebugBundle, kiroDebugOnErrorEnabled, redactSensitiveText } from "../../core/debug-capture"
import { createLogPreview } from "../../core/log-preview"
import { StreamTelemetryCollector } from "../../core/stream-telemetry"
import { canonicalErrorTelemetrySummary, canonicalResponseTelemetrySummary, streamTelemetrySummary } from "../../core/stream-telemetry-summary"
import { interceptResponseStream } from "../../core/stream-utils"
import type { JsonObject, RequestProxyLog } from "../../core/types"
import { countTokens } from "gpt-tokenizer"
import { codex2ClaudeCatalog, codex2ClaudeModelIds, resolveCodex2ClaudeModel } from "./model-alias"
import { normalizeCanonicalRequest, normalizeRequestBody } from "./normalize"
import { prependOpenAIWarning, renderOpenAIFeatureWarning } from "./notice"
import { openAICanonicalResponse, openAICanonicalStreamResponse } from "./response"
import { OPENAI_MODELS_ROUTE, OPENAI_NON_EMBEDDINGS_ROUTES, openAIProxyRouteDescriptor } from "./routes"

export type OpenAIModelResolverFn = () => Promise<Array<string | ProviderModelDescriptor>>

interface OpenAIInboundProviderOptions {
  name?: string
  routes?: Route_Descriptor[]
  /**
   * Two shapes, one option. A boolean is the instance-wide answer, default `true`. A
   * `PassthroughDecider` (the contract type from core — inbound imports zero upstream modules,
   * Requirement 15.10) defers the answer to each request, since the decision depends on the route
   * and on `stream`, which are only known then.
   */
  passthrough?: boolean | PassthroughDecider
  upstreamLogLabel?: string
  upstreamTarget?: string
  expectedUpstreamKind?: UpstreamProviderKind
  modelResolver?: OpenAIModelResolverFn
  /**
   * Whether `degrade` notices are rendered into the client-visible text. The resolved
   * `NATIVE_FEATURE_NOTICES` value, threaded from `src/app/bootstrap.ts` (design decision D3).
   * Defaults to **off**, matching the Claude inbound provider; the notices keep reaching
   * telemetry and the request log either way.
   */
  featureNotices?: boolean
}

export class OpenAI_Inbound_Provider implements Inbound_Provider {
  readonly name: string
  private readonly routeDescriptors: Route_Descriptor[]
  private readonly passthroughOption: boolean | PassthroughDecider
  /**
   * Whether this instance can forward upstream bytes at all, as opposed to whether one request
   * will. The lenient branches below — a malformed-JSON body, shape validation, forwarding an
   * upstream error unrendered — are reached before `stream` is known or on paths where no
   * per-request decision exists, so they key off capability. A decider means "capable".
   *
   * Deliberately *not* flag-aware, reviewed again in task 18.2 and kept. With `NATIVE_PASSTHROUGH`
   * off no request can reach the passthrough path, so "capable" overstates what the instance will
   * do — but narrowing capability to the flag would move those three branches for the codex
   * OpenAI endpoints the moment the option started being read, turning a forwarded upstream error
   * into a rendered one and a lenient 500 into a 400, with the flag still off. That is a live
   * behavior change wearing the costume of a wiring task. The branches are lenient because the
   * *instance* is a byte conduit, not because one request is, and the composition root keeps them
   * honest by binding a decider only where passthrough is ever intended.
   */
  private readonly passthrough: boolean
  private readonly upstreamLogLabel: string
  private readonly upstreamTarget: string
  private readonly expectedUpstreamKind?: UpstreamProviderKind
  private readonly modelResolver?: OpenAIModelResolverFn
  private readonly featureNotices: boolean

  constructor(options: OpenAIInboundProviderOptions = {}) {
    this.name = options.name ?? "openai"
    this.routeDescriptors = options.routes ?? OPENAI_NON_EMBEDDINGS_ROUTES.map(openAIProxyRouteDescriptor)
    this.passthroughOption = options.passthrough ?? true
    this.passthrough = typeof this.passthroughOption === "function" ? true : this.passthroughOption
    this.upstreamLogLabel = options.upstreamLogLabel ?? "Codex responses"
    this.upstreamTarget = options.upstreamTarget ?? "/v1/responses"
    this.expectedUpstreamKind = options.expectedUpstreamKind
    this.modelResolver = options.modelResolver
    this.featureNotices = options.featureNotices ?? false
  }

  routes(): Route_Descriptor[] {
    return this.routeDescriptors
  }

  /** The per-request answer: the boolean form as-is, the decider form asked. */
  private resolvePassthrough(routePath: string, stream: boolean): boolean {
    return typeof this.passthroughOption === "function" ? this.passthroughOption(routePath, stream) : this.passthroughOption
  }

  async handle(request: Request, route: Route_Descriptor, upstream: Upstream_Provider, context: RequestHandlerContext): Promise<Response> {
    const upstreamMismatch = this.upstreamMismatch(upstream)
    if (upstreamMismatch) return openAIErrorResponse(upstreamMismatch, 500, "server_error")

    if (route.path === OPENAI_MODELS_ROUTE.path) return this.handleListModels(request, upstream)

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

    // Codex clients address models as `codex2claude-<slug>_<effort>`; the upstream
    // only knows the bare slug. `wireBody` keeps the client's name for logging and
    // for the model echoed back in the response.
    const upstreamBody = resolveCodex2ClaudeModel(wireBody)

    const shouldCaptureProxyBody = context.logBody && context.onProxy !== undefined
    const requestBody = shouldCaptureProxyBody ? previewText(JSON.stringify(normalizeRequestBody(route.path, upstreamBody))) : undefined
    const upstreamRequestPreview = shouldCaptureProxyBody ? createLogPreview() : undefined
    const upstreamResponsePreview = shouldCaptureProxyBody ? createLogPreview() : undefined
    const started = Date.now()

    if (route.path === "/v1/embeddings") {
      if (!upstream.embeddingsRaw) return openAIErrorResponse("Embeddings are not supported by this upstream provider.", 501, "server_error")

      const embeddingsBody = normalizeRequestBody(route.path, upstreamBody)
      const response = await upstream.embeddingsRaw(embeddingsBody, {
        headers: request.headers,
        signal: request.signal,
        ...(upstreamRequestPreview ? {
          onRequestBody: (nextBody) => upstreamRequestPreview.append(nextBody),
        } : {}),
      })
      const durationMs = Date.now() - started
      const proxyRequestBody = upstreamRequestPreview?.text() || requestBody
      const proxyLog: RequestProxyLog | undefined = context.onProxy ? {
        label: this.upstreamLogLabel,
        method: "POST",
        target: this.upstreamTarget,
        status: response.status,
        durationMs,
        error: response.ok ? "-" : response.statusText || `HTTP ${response.status}`,
        requestBody: proxyRequestBody,
        responseBody: undefined,
      } : undefined
      if (proxyLog) context.onProxy?.(proxyLog)
      if (!response.body || !shouldCaptureProxyBody || !proxyLog) return response
      return interceptResponseStream(response, {
        onComplete: (responseBody) => {
          proxyLog.responseBody = responseBody
          if (response.status >= 400) {
            proxyLog.error = responseBody ? previewText(responseBody) || proxyLog.error : proxyLog.error
          }
        },
      })
    }

    const result = await upstream.proxy(normalizeCanonicalRequest(route.path, upstreamBody, {
      passthrough: this.resolvePassthrough(route.path, Boolean(wireBody.stream)),
    }), {
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
      return interceptResponseStream(response, {
        onComplete: (responseBody) => { proxyLog.responseBody = responseBody },
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
        // A rejected request made no upstream call, so there is no collector and no response
        // to read — but it did decide things before it bailed, and those decisions ride the
        // error result (Requirement 8.8). Same presence semantics as the 200 paths, produced
        // by the same core module rather than by an object literal here. Populated even in
        // passthrough mode, where the body is forwarded unrendered: telemetry is the only
        // channel left for the account, and it is not part of the forwarded bytes.
        telemetry: canonicalErrorTelemetrySummary(result),
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
        // Rendered through the same channel the 200 path uses — one combined warning segment
        // leading the one prose field the OpenAI error shape has (Requirement 9.7). No member
        // is added to the error body, and no field or header appears that a notice-free error
        // lacks. An empty render is a pass-through, so an error with no `degrade` notice —
        // including an `emulate`-only one, which stays telemetry-only (Requirement 9.2) — is
        // byte-identical to what this branch produced before (Requirement 9.8).
        return openAIErrorResponse(
          prependOpenAIWarning(result.body, renderOpenAIFeatureWarning(this.featureNotices ? result.featureNotices ?? [] : [])),
          result.status,
          "upstream_error",
          result.headers,
        )
      }
      // Passthrough mode forwards the upstream's own error bytes. Rendering here would edit
      // bytes the client asked to receive verbatim (Requirement 15.5), so a byte forward stays
      // a byte forward and the notices are reported through telemetry only (Requirement 9.8).
      return new Response(result.body, {
        status: result.status,
        headers: responseHeaders(result.headers),
      })
    }

    if (isCanonicalResponse(result)) {
      backfillInputTokens(result, wireBody)
      const response = openAICanonicalResponse(result, route.path, wireBody, { featureNotices: this.featureNotices })
      if (context.onProxy) {
        // Named rather than passed as a literal so the telemetry projection has an object
        // to write to. Unlike the Claude provider, this site holds the finished response
        // before `onProxy` fires, so the assignment happens up front instead of relying on
        // reference mutation afterwards; the object handed over is the same one either way.
        //
        // No collector on this path — nothing to instrument without a stream — so credits
        // and notices are read off the response, where `mergeCanonicalUsage()` and the
        // `feature_notice` fold already put them. Unconditional on body capture: telemetry
        // is not a body preview.
        const proxyLog: RequestProxyLog = {
          label: this.upstreamLogLabel,
          method: "POST",
          target: this.upstreamTarget,
          status: 200,
          durationMs,
          error: "-",
          requestBody: proxyRequestBody,
          responseBody: shouldCaptureProxyBody ? upstreamResponsePreview?.text() || undefined : undefined,
          telemetry: canonicalResponseTelemetrySummary(result),
        }
        context.onProxy(proxyLog)
      }
      return response
    }

    if (isCanonicalStream(result)) {
      const clientWantsStream = wireBody.stream === true || wireBody.stream === "true"
      if (!clientWantsStream) {
        const accumulated = await accumulateCanonicalStream(result)
        backfillInputTokens(accumulated, wireBody)
        const response = openAICanonicalResponse(accumulated, route.path, wireBody, { featureNotices: this.featureNotices })
        if (context.onProxy) {
          // The client asked for a non-streaming reply from an upstream that only streams,
          // so the stream is accumulated here and the summary comes from the accumulated
          // response rather than from a collector. Same construction as the
          // `isCanonicalResponse` branch above.
          const proxyLog: RequestProxyLog = {
            label: this.upstreamLogLabel,
            method: "POST",
            target: this.upstreamTarget,
            status: 200,
            durationMs,
            error: "-",
            requestBody: proxyRequestBody,
            responseBody: shouldCaptureProxyBody ? upstreamResponsePreview?.text() || undefined : undefined,
            telemetry: canonicalResponseTelemetrySummary(accumulated),
          }
          context.onProxy(proxyLog)
        }
        return response
      }
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
      // One collector per streaming request; the renderer records provider spend and
      // non-native handling decisions into it as canonical events flow past.
      const telemetry = new StreamTelemetryCollector({
        requestId: context.requestId,
        // Optional on `Upstream_Provider`; falls back to the kind this inbound provider
        // expects, then to the collector's own empty default.
        provider: upstream.providerKind ?? this.expectedUpstreamKind ?? "",
        model: typeof wireBody.model === "string" ? wireBody.model : "",
        streaming: true,
      })
      const response = openAICanonicalStreamResponse(result, route.path, wireBody, { telemetry, featureNotices: this.featureNotices })
      // Body capture is no longer part of this guard: telemetry is not a body preview,
      // so the stream-end hook has to run whenever a proxy log exists. The body preview
      // stays behind its own check inside the hook, keeping `responseBody` untouched
      // when capture is off.
      if (!proxyLog) return response
      return interceptResponseStream(response, {
        onComplete: (responseBody) => {
          // Same object already handed to `context.onProxy`, mutated by reference — no
          // edit to `src/app/runtime.ts` (Requirement 27.5). `finalize()` is idempotent,
          // and this hook also runs on cancellation.
          proxyLog.telemetry = streamTelemetrySummary(telemetry.finalize())
          if (shouldCaptureProxyBody) proxyLog.responseBody = upstreamResponsePreview?.text() || responseBody
        },
      })
    }

    return unexpectedNonPassthroughResponse()
  }

  private async handleListModels(request: Request, upstream: Upstream_Provider) {
    // Codex fetches its own catalog shape and tags the request with client_version;
    // every other OpenAI client wants the plain list. When the upstream serves that
    // catalog, use it directly — asking for descriptors as well would fetch the same
    // thing twice and silently downgrade to synthesized entries if the second call fails.
    if (new URL(request.url).searchParams.has("client_version")) {
      const catalog = await this.readUpstreamCatalog(upstream)
      if (catalog) return Response.json(codex2ClaudeCatalog(catalog, []))
    }

    const resolver = this.modelResolver
      ?? (upstream.listModelDescriptors ? () => upstream.listModelDescriptors!() : undefined)

    let models: Array<string | ProviderModelDescriptor> = []
    try {
      models = resolver ? await resolver() : []
    } catch (error) {
      return openAIErrorResponse(error instanceof Error ? error.message : String(error), 502, "upstream_error")
    }

    if (new URL(request.url).searchParams.has("client_version")) {
      return Response.json(codex2ClaudeCatalog(undefined, models))
    }

    const created = Math.floor(Date.now() / 1000)
    return Response.json({
      object: "list",
      data: models.flatMap((model) => codex2ClaudeModelIds(model)).map((id) => ({
        id,
        object: "model",
        created,
        owned_by: "codex2claude",
      })),
    })
  }

  /** The upstream's own catalog, when it serves one, so its fields survive the rename. */
  private async readUpstreamCatalog(upstream: Upstream_Provider) {
    if (!upstream.modelsRaw) return undefined
    try {
      const response = await upstream.modelsRaw()
      if (!response.ok) return undefined
      const body = (await response.json()) as { models?: unknown }
      return Array.isArray(body?.models) && body.models.length > 0 ? body : undefined
    } catch {
      return undefined
    }
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

function backfillInputTokens(response: Canonical_Response, wireBody: JsonObject) {
  if (response.usage.inputTokens === 0) {
    response.usage.inputTokens = countTokens(JSON.stringify(wireBody))
  }
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

  if (pathname === "/v1/embeddings") {
    if (typeof body.input !== "string" && !Array.isArray(body.input)) return "Embeddings request requires `input` (string or array)."
    return
  }

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
