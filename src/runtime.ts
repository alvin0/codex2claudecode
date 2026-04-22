import { LOG_BODY_PREVIEW_LIMIT } from "./constants"
import { handleListModels, handleGetModel } from "./models"
import { claudeErrorResponse } from "./claude/errors"
import { cors, responseHeaders } from "./http"
import { resolveAuthFile } from "./paths"
import { appendRequestLog, ensureRequestLogFile, requestLogFilePath } from "./request-logs"
import { normalizeReasoningBody, normalizeRequestBody } from "./reasoning"
import { createProvider, CodexProvider, KiroProvider } from "./llm-connect"
import type { LlmProvider, HealthResult } from "./llm-connect"
import type { ProviderName } from "./llm-connect/factory"
import type { JsonObject, RequestLogEntry, RequestProxyLog, RuntimeOptions } from "./types"

export async function startRuntime(options?: RuntimeOptions) {
  const authFile = resolveAuthFile(options?.authFile ?? process.env.CODEX_AUTH_FILE)
  const authAccount = options?.authAccount ?? process.env.CODEX_AUTH_ACCOUNT
  const hostname = options?.hostname ?? process.env.HOST ?? "127.0.0.1"
  const preferredPort = options?.port ?? Number(process.env.PORT || 8787)
  const providerName: ProviderName = options?.provider ?? (process.env.LLM_PROVIDER as ProviderName) ?? "codex"
  const healthIntervalMs = options?.healthIntervalMs ?? Number(process.env.HEALTH_INTERVAL_MS || 30_000)
  const healthTimeoutMs = options?.healthTimeoutMs ?? Number(process.env.HEALTH_TIMEOUT_MS || 5000)
  const logBody = options?.logBody ?? process.env.LOG_BODY !== "0"
  const quiet = options?.quiet ?? false
  const onRequestLogStart = options?.onRequestLogStart
  const onRequestLog = options?.onRequestLog

  const provider = await createProvider({
    provider: providerName,
    authFile,
    authAccount,
    kiroAccount: options?.kiroAccount,
  })

  await ensureRequestLogFile(authFile).catch((error) => {
    if (!quiet) warnRequestLogError(authFile, error)
  })
  const health = createHealthMonitor(provider, healthIntervalMs, healthTimeoutMs, quiet)

  health.start()

  let server: ReturnType<typeof Bun.serve>
  try {
    server = serveWithPortFallback(hostname, preferredPort, (port) =>
      Bun.serve({
        hostname,
        port,
        async fetch(request) {
        const requestId = crypto.randomUUID().slice(0, 8)
        const started = Date.now()
        const url = new URL(request.url)
        const requestBody = logBody ? await readLoggedBody(request) : undefined
        const headersPreview = interestingHeaders(request.headers)

        if (!quiet) logRequestStart(requestId, request, url, requestBody)

        async function requestLog(
          response: Response,
          durationMs: number,
          error?: string,
          proxy?: RequestProxyLog,
          responseBody?: string,
        ): Promise<RequestLogEntry> {
          return {
            id: requestId,
            state: "complete",
            at: new Date().toISOString(),
            method: request.method,
            path: `${url.pathname}${url.search}`,
            status: response.status,
            durationMs,
            error: error ?? (response.status >= 400 && responseBody !== undefined ? responseErrorText(responseBody) : await responseErrorMessage(response)),
            requestHeaders: headersPreview,
            requestBody,
            responseBody,
            proxy,
          }
        }

        function pendingRequestLog(): RequestLogEntry {
          return {
            id: requestId,
            state: "pending",
            at: new Date().toISOString(),
            method: request.method,
            path: `${url.pathname}${url.search}`,
            status: 0,
            durationMs: 0,
            error: "-",
            requestHeaders: headersPreview,
            requestBody,
          }
        }

        async function emitRequestLog(response: Response, durationMs: number, error?: string, proxy?: RequestProxyLog, responseBody?: string) {
          const entry = await requestLog(response, durationMs, error, proxy, responseBody)
          try {
            await appendRequestLog(authFile, entry)
          } catch (logError) {
            warnRequestLogError(authFile, logError)
          }
          onRequestLog?.(entry)
        }

        onRequestLogStart?.(pendingRequestLog())

        async function finish(response: Response, proxy?: RequestProxyLog) {
          if (!logBody || request.method === "HEAD" || response.body === null || response.body === undefined) {
            const durationMs = Date.now() - started
            if (!quiet) logResponseEnd(requestId, request, url, response, durationMs)
            await emitRequestLog(response, durationMs, undefined, proxy)
            return response
          }
          return responseWithLoggedBody(response as Response & { body: ReadableStream<Uint8Array> }, async (responseBody, responseError) => {
            const durationMs = Date.now() - started
            if (!quiet) logResponseEnd(requestId, request, url, response, durationMs)
            await emitRequestLog(response, durationMs, responseError, proxy, responseBody)
          })
        }

        async function fail(error: unknown, proxy?: RequestProxyLog) {
          const durationMs = Date.now() - started
          if (!quiet) logRequestError(requestId, request, url, error, durationMs)
          const response = cors(
            Response.json(
              {
                error: {
                  message: error instanceof Error ? error.message : String(error),
                },
              },
              { status: 500 },
            ),
          )
          await emitRequestLog(response, durationMs, error instanceof Error ? error.message : String(error), proxy)
          return response
        }

        async function failClaude(error: unknown, proxy?: RequestProxyLog) {
          const durationMs = Date.now() - started
          const message = errorMessage(error)
          if (!quiet) logRequestError(requestId, request, url, error, durationMs)
          const response = cors(claudeErrorResponse(message, 500))
          await emitRequestLog(response, durationMs, message, proxy)
          return response
        }

        if (request.method === "OPTIONS") return finish(cors(new Response(null, { status: 204 })))

        // ---- Root info ----
        if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
          return finish(
            cors(
              Response.json({
                message: "Codex2ClaudeCode",
                status: "running",
                provider: provider.name,
                config: {
                  hostname,
                  port: server.port,
                  health_interval_ms: healthIntervalMs,
                  health_timeout_ms: healthTimeoutMs,
                  log_body: logBody,
                },
                endpoints: {
                  messages: "/v1/messages",
                  count_tokens: "/v1/messages/count_tokens",
                  models: "/v1/models",
                  ...(providerName === "kiro" ? { kiro_models: "/kiro/models" } : {}),
                  responses: "/v1/responses",
                  chat_completions: "/v1/chat/completions",
                  health: "/health",
                  ...(providerName === "codex" ? { usage: "/usage", environments: "/environments" } : {}),
                  ...(providerName === "kiro" ? { usage: "/usage" } : {}),
                  test_connection: "/test-connection",
                },
              }),
            ),
          )
        }

        // ---- Test connection ----
        if (request.method === "GET" && url.pathname === "/test-connection") {
          try {
            const testStarted = Date.now()
            const testHealth = await provider.checkHealth(healthTimeoutMs)
            const testDurationMs = Date.now() - testStarted
            if (testHealth.ok) {
              return finish(
                cors(
                  Response.json({
                    status: "success",
                    message: `Successfully connected to ${provider.name} upstream`,
                    provider: provider.name,
                    timestamp: new Date().toISOString(),
                    latency_ms: testDurationMs,
                    upstream: {
                      status: testHealth.status,
                      latency_ms: testHealth.latencyMs,
                    },
                  }),
                ),
              )
            }
            return finish(
              cors(
                Response.json(
                  {
                    status: "failed",
                    error_type: "Connection Error",
                    message: testHealth.error ?? `Unable to reach ${provider.name} upstream`,
                    provider: provider.name,
                    timestamp: new Date().toISOString(),
                    latency_ms: testDurationMs,
                    suggestions: [
                      "Check your auth credentials are valid",
                      "Verify your auth file is correctly configured",
                      "Check if the upstream service is available",
                    ],
                  },
                  { status: 503 },
                ),
              ),
            )
          } catch (error) {
            return finish(
              cors(
                Response.json(
                  {
                    status: "failed",
                    error_type: "API Error",
                    message: error instanceof Error ? error.message : String(error),
                    provider: provider.name,
                    timestamp: new Date().toISOString(),
                    suggestions: [
                      "Check your auth credentials are valid",
                      "Verify your auth file is correctly configured",
                      "Check if the upstream service is available",
                    ],
                  },
                  { status: 503 },
                ),
              ),
            )
          }
        }

        // ---- Health ----
        if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/health") {
          return finish(
            cors(
              Response.json(
                {
                  ok: health.current.ok,
                  provider: provider.name,
                  runtime: { ok: true },
                  upstream: health.current,
                },
                { status: health.current.ok ? 200 : 503 },
              ),
            ),
          )
        }

        // ---- Codex-specific: usage & environments (only when codex provider) ----
        if (request.method === "GET" && (url.pathname === "/usage" || url.pathname === "/wham/usage")) {
          if (provider instanceof CodexProvider) {
            const proxy = await proxyRequestLog("Codex usage", "GET", "/usage", () => provider.raw.usage({ headers: request.headers, signal: request.signal }))
            return finish(cors(proxy.response), proxy.entry)
          }
          if (provider instanceof KiroProvider) {
            const proxy = await proxyRequestLog("Kiro usage", "GET", "/usage", async () => {
              const data = await provider.raw.getUsageLimits()
              return Response.json(data)
            })
            return finish(cors(proxy.response), proxy.entry)
          }
          return finish(cors(Response.json({ error: { message: `Usage endpoint not available for ${provider.name} provider` } }, { status: 404 })))
        }

        if (
          request.method === "GET" &&
          (url.pathname === "/environments" || url.pathname === "/wham/environments")
        ) {
          if (provider instanceof CodexProvider) {
            const proxy = await proxyRequestLog("Codex environments", "GET", "/environments", () =>
              provider.raw.environments({ headers: request.headers, signal: request.signal }),
            )
            return finish(cors(proxy.response), proxy.entry)
          }
          return finish(cors(Response.json({ error: { message: `Environments endpoint not available for ${provider.name} provider` } }, { status: 404 })))
        }

        // ---- Models API ----
        if (request.method === "GET" && url.pathname === "/v1/models") {
          return finish(cors(await handleListModels(url, providerName)))
        }

        if (request.method === "GET" && url.pathname.startsWith("/v1/models/")) {
          const modelId = decodeURIComponent(url.pathname.slice("/v1/models/".length))
          if (modelId) {
            return finish(cors(handleGetModel(modelId)))
          }
        }

        // ---- Kiro native models (proxy to Kiro ListAvailableModels API) ----
        if (request.method === "GET" && url.pathname === "/kiro/models") {
          if (!(provider instanceof KiroProvider)) {
            return finish(cors(Response.json({ error: { message: "Kiro models endpoint is only available when using the kiro provider" } }, { status: 404 })))
          }
          try {
            const models = await provider.raw.listAvailableModels()
            return finish(cors(Response.json(models)))
          } catch (error) {
            return finish(cors(Response.json({ error: { message: error instanceof Error ? error.message : String(error) } }, { status: 502 })))
          }
        }

        // ---- Claude Messages API (provider-agnostic) ----
        if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
          try {
            return finish(cors(await provider.handleCountTokens(request)))
          } catch (error) {
            return failClaude(error)
          }
        }

        if (request.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/v1/message")) {
          let proxy: RequestProxyLog | undefined
          try {
            return finish(
              cors(
                await provider.handleMessages(request, requestId, {
                  logBody: logBody && !quiet,
                  onProxy: (entry) => {
                    proxy = entry
                  },
                }),
              ),
              proxy,
            )
          } catch (error) {
            return failClaude(error, proxy)
          }
        }

        if (request.method !== "POST") {
          return finish(cors(Response.json({ error: { message: "Method not allowed" } }, { status: 405 })))
        }

        if (url.pathname !== "/v1/responses" && url.pathname !== "/v1/chat/completions") {
          return finish(cors(Response.json({ error: { message: "Not found" } }, { status: 404 })))
        }

        // ---- OpenAI-shaped proxy (responses / chat completions) ----
        try {
          const body = normalizeRequestBody(url.pathname, (await request.json()) as JsonObject)
          if (logBody && !quiet) logUpstreamBody(requestId, body)
          const proxyStarted = Date.now()
          const proxyRequestBody = previewText(stringifyNormalizedBody(body))
          const response = await provider.proxy(body, {
            headers: request.headers,
            signal: request.signal,
          })
          const proxyDurationMs = Date.now() - proxyStarted
          if (!response.ok) {
            const text = await response.text()
            if (!quiet) console.error(`[${requestId}] upstream error ${response.status}: ${text.slice(0, LOG_BODY_PREVIEW_LIMIT)}`)
            const proxy: RequestProxyLog = {
              label: `${provider.name} responses`,
              method: "POST",
              target: url.pathname,
              status: response.status,
              durationMs: proxyDurationMs,
              error: redactSecrets(text).slice(0, LOG_BODY_PREVIEW_LIMIT) || "-",
              requestBody: proxyRequestBody,
            }
            const errorResponse = cors(
              new Response(text, {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders(response.headers),
              }),
            )
            return finish(errorResponse, proxy)
          }
          const proxy: RequestProxyLog = {
            label: `${provider.name} responses`,
            method: "POST",
            target: url.pathname,
            status: response.status,
            durationMs: proxyDurationMs,
            error: "-",
            requestBody: proxyRequestBody,
          }
          return finish(
            cors(
              new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders(response.headers),
              }),
            ),
            proxy,
          )
        } catch (error) {
          return fail(error)
        }
        },
      }),
    )
  } catch (error) {
    health.stop()
    throw error
  }

  const stop = server.stop.bind(server)
  server.stop = (closeActiveConnections?: boolean) => {
    health.stop()
    return stop(closeActiveConnections)
  }

  if (!quiet) {
    console.log(`Runtime listening on http://${server.hostname}:${server.port} [provider: ${provider.name}]`)
    console.log(`Root:             http://${server.hostname}:${server.port}/`)
    console.log(`Claude messages:  http://${server.hostname}:${server.port}/v1/messages`)
    console.log(`Claude tokens:    http://${server.hostname}:${server.port}/v1/messages/count_tokens`)
    console.log(`Models:           http://${server.hostname}:${server.port}/v1/models`)
    if (provider instanceof KiroProvider) {
      console.log(`Kiro models:      http://${server.hostname}:${server.port}/kiro/models`)
    }
    console.log(`Responses:        http://${server.hostname}:${server.port}/v1/responses`)
    console.log(`Chat completions: http://${server.hostname}:${server.port}/v1/chat/completions`)
    if (provider instanceof CodexProvider) {
      console.log(`Usage:            http://${server.hostname}:${server.port}/usage`)
      console.log(`Environments:     http://${server.hostname}:${server.port}/environments`)
    }
    if (provider instanceof KiroProvider) {
      console.log(`Usage:            http://${server.hostname}:${server.port}/usage`)
    }
    console.log(`Health:           http://${server.hostname}:${server.port}/health`)
    console.log(`Test connection:  http://${server.hostname}:${server.port}/test-connection`)
    console.log(`Health interval:  ${healthIntervalMs}ms`)
    console.log(`Log body:         ${logBody ? "enabled" : "disabled"}${logBody ? " (set LOG_BODY=0 to disable)" : ""}`)
    console.log(`Auth file:        ${authFile}`)
    console.log(`Provider:         ${provider.name}`)
    if (authAccount) console.log(`Auth account:     ${authAccount}`)
  }

  return server
}


function serveWithPortFallback(
  hostname: string,
  preferredPort: number,
  createServer: (port: number) => ReturnType<typeof Bun.serve>,
) {
  if (preferredPort === 0) return createServer(0)

  let port = preferredPort
  while (port <= 65_535) {
    try {
      return createServer(port)
    } catch (error) {
      if (!isPortInUseError(error) || port === 65_535) throw error
      port += 1
    }
  }

  throw new Error(`Unable to find an available port starting from ${preferredPort}`)
}

function isPortInUseError(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE") return true
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("EADDRINUSE") || message.toLowerCase().includes("address already in use")
}

async function readLoggedBody(request: Request) {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return
  try {
    const text = await request.clone().text()
    return previewText(redactSecrets(text))
    /* node:coverage ignore next 3 */
  } catch (error) {
    return previewText(`<failed to read body: ${error instanceof Error ? error.message : String(error)}>`)
  }
}

function logRequestStart(id: string, request: Request, url: URL, bodyPreview?: string) {
  const headers = interestingHeaders(request.headers)
  console.log(`[${id}] -> ${request.method} ${url.pathname}${url.search} ${JSON.stringify(headers)}`)
  if (bodyPreview) console.log(`[${id}] body ${bodyPreview}`)
}

function logUpstreamBody(id: string, body: JsonObject) {
  console.log(
    `[${id}] upstream body ${previewText(stringifyNormalizedBody(body))}`,
  )
}

function logResponseEnd(id: string, request: Request, url: URL, response: Response, durationMs: number) {
  const level = response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "log"
  console[level](`[${id}] <- ${response.status} ${request.method} ${url.pathname} ${durationMs}ms`)
}

function logRequestError(id: string, request: Request, url: URL, error: unknown, durationMs: number) {
  console.error(
    `[${id}] !! ${request.method} ${url.pathname} ${durationMs}ms ${error instanceof Error ? error.stack || error.message : String(error)}`,
  )
}

async function responseErrorMessage(response: Response) {
  if (response.status < 400) return "-"
  try {
    return responseErrorText(await response.clone().text())
  } catch (error) {
    return `<failed to read error: ${error instanceof Error ? error.message : String(error)}>`
  }
}

function responseErrorText(text: string) {
  if (!text) return "-"
  try {
    const body = JSON.parse(text) as JsonObject
    const error = body.error
    if (typeof error === "string") return redactSecrets(error).slice(0, LOG_BODY_PREVIEW_LIMIT)
    if (isJsonObject(error) && typeof error.message === "string") {
      return redactSecrets(error.message).slice(0, LOG_BODY_PREVIEW_LIMIT)
    }
    if ("message" in body && typeof body.message === "string") return redactSecrets(body.message).slice(0, LOG_BODY_PREVIEW_LIMIT)
  } catch {
    return redactSecrets(text).slice(0, LOG_BODY_PREVIEW_LIMIT)
  }
  return redactSecrets(text).slice(0, LOG_BODY_PREVIEW_LIMIT)
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function interestingHeaders(headers: Headers) {
  return Object.fromEntries(
    ["anthropic-version", "anthropic-beta", "user-agent", "content-type", "accept"].flatMap((key) => {
      const value = headers.get(key)
      return value ? [[key, redactSecrets(value)] as const] : []
    }),
  )
}

function redactSecrets(text: string) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/"?(api[_-]?key|authorization|x-api-key|anthropic-api-key|access|refresh|access_token|refresh_token)"?\s*:\s*"[^"]+"/gi, '"$1":"[redacted]"')
}

function stringifyNormalizedBody(body: JsonObject) {
  return redactSecrets(JSON.stringify(normalizeReasoningBody(body)))
}

function previewText(text: string) {
  return text.slice(0, LOG_BODY_PREVIEW_LIMIT)
}

function responseWithLoggedBody(
  response: Response & { body: ReadableStream<Uint8Array> },
  onComplete: (responseBody?: string, responseError?: string) => Promise<void>,
) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let preview = ""
  let completed = false

  async function complete(responseError?: string) {
    if (completed) return
    completed = true
    const tail = decoder.decode()
    if (tail) preview = appendPreview(preview, tail)
    await onComplete(preview || undefined, responseError)
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          await complete()
          controller.close()
          return
        }
        controller.enqueue(chunk.value)
        preview = appendPreview(preview, decoder.decode(chunk.value, { stream: true }))
      } catch (error) {
        await complete(error instanceof Error ? error.message : String(error))
        controller.error(error)
      }
    },
    async cancel(reason) {
      await complete(`response cancelled: ${cancelReasonText(reason)}`)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function appendPreview(current: string, next: string) {
  if (!next || current.length >= LOG_BODY_PREVIEW_LIMIT) return current
  return `${current}${next}`.slice(0, LOG_BODY_PREVIEW_LIMIT)
}

function cancelReasonText(reason: unknown) {
  if (reason === undefined) return "client disconnected"
  if (reason instanceof Error) return reason.message
  return String(reason)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function warnRequestLogError(authFile: string, error: unknown) {
  console.warn(`Request log file unavailable at ${requestLogFilePath(authFile)}: ${errorMessage(error)}`)
}

async function proxyUpstream(fetcher: () => Promise<Response>) {
  try {
    const response = await fetcher()
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers),
    })
  } catch (error) {
    return Response.json(
      {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 500 },
    )
  }
}

async function proxyRequestLog(label: string, method: string, target: string, fetcher: () => Promise<Response>) {
  const started = Date.now()
  const response = await proxyUpstream(fetcher)
  return {
    response,
    entry: {
      label,
      method,
      target,
      status: response.status,
      durationMs: Date.now() - started,
      error: await responseErrorMessage(response),
    } satisfies RequestProxyLog,
  }
}

function createHealthMonitor(provider: LlmProvider, intervalMs: number, timeoutMs: number, quiet: boolean) {
  const state: { current: HealthResult; timer?: ReturnType<typeof setInterval> } = {
    current: { ok: false, error: "Health check has not run yet" },
  }

  async function run() {
    const previous = state.current.ok
    state.current = await provider.checkHealth(timeoutMs)
    if (previous === state.current.ok) return
    if (!quiet) {
      console.log(
        state.current.ok
          ? `${provider.name} upstream healthy (${state.current.status ?? "ok"}, ${state.current.latencyMs}ms)`
          : `${provider.name} upstream unhealthy (${state.current.error ?? state.current.status ?? "unknown"})`,
      )
    }
  }

  return {
    get current() {
      return state.current
    },
    start() {
      void run()
      if (intervalMs <= 0) return
      state.timer = setInterval(() => void run(), intervalMs)
    },
    stop() {
      if (!state.timer) return
      clearInterval(state.timer)
    },
  }
}
