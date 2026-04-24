import { bootstrapRuntime } from "./bootstrap"
import { LOG_BODY_PREVIEW_LIMIT } from "../core/constants"
import { cors, responseHeaders } from "../core/http"
import type { Upstream_Provider } from "../core/interfaces"
import { createLogPreview } from "../core/log-preview"
import { appendRequestLog, ensureRequestLogFile, requestLogFilePath } from "../core/request-logs"
import type { HealthStatus, JsonObject, RequestLogEntry, RequestProxyLog, RuntimeOptions } from "../core/types"

export async function startRuntime(options?: RuntimeOptions) {
  return startRuntimeWithBootstrap(options, bootstrapRuntime)
}

export async function startRuntimeWithBootstrap(
  options: RuntimeOptions | undefined,
  bootstrap: typeof bootstrapRuntime,
) {
  const hostname = options?.hostname ?? process.env.HOST ?? "127.0.0.1"
  const preferredPort = options?.port ?? Number(process.env.PORT || 8787)
  const healthIntervalMs = options?.healthIntervalMs ?? Number(process.env.HEALTH_INTERVAL_MS || 30_000)
  const healthTimeoutMs = options?.healthTimeoutMs ?? Number(process.env.HEALTH_TIMEOUT_MS || 5000)
  const logBody = options?.logBody ?? process.env.LOG_BODY !== "0"
  const quiet = options?.quiet ?? false
  const onRequestLogStart = options?.onRequestLogStart
  const onRequestLog = options?.onRequestLog
  const { authFile, authAccount, registry, upstream } = await bootstrap(options)
  await ensureRequestLogFile(authFile).catch((error) => {
    if (!quiet) warnRequestLogError(authFile, error)
  })
  const health = createHealthMonitor(upstream, healthIntervalMs, healthTimeoutMs, quiet)

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
        const headersPreview = loggedHeaders(request.headers)

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
            // Always warn about log write failures regardless of quiet mode so
            // the caller's onRequestLog callback can surface the error in the UI.
            warnRequestLogError(authFile, logError)
            // Request logging must not change runtime responses or prevent
            // the in-memory callback from firing.
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

        if (request.method === "OPTIONS") return finish(cors(new Response(null, { status: 204 })))

        if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
          return finish(
            cors(
              Response.json({
                message: "Codex2ClaudeCode",
                status: "running",
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
                  responses: "/v1/responses",
                  chat_completions: "/v1/chat/completions",
                  health: "/health",
                  usage: "/usage",
                  environments: "/environments",
                  test_connection: "/test-connection",
                },
                registered_routes: registry.listRoutes(),
              }),
            ),
          )
        }

        if (request.method === "GET" && url.pathname === "/test-connection") {
          try {
            const testStarted = Date.now()
            const testHealth = await upstream.checkHealth(healthTimeoutMs)
            const testDurationMs = Date.now() - testStarted
            if (testHealth.ok) {
              return finish(
                cors(
                  Response.json({
                    status: "success",
                    message: "Successfully connected to Codex upstream",
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
                    message: testHealth.error ?? "Unable to reach Codex upstream",
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

        if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/health") {
          return finish(
            cors(
              Response.json(
                {
                  ok: health.current.ok,
                  runtime: { ok: true },
                  codex: health.current,
                },
                { status: health.current.ok ? 200 : 503 },
              ),
            ),
          )
        }

        if (request.method === "GET" && (url.pathname === "/usage" || url.pathname === "/wham/usage")) {
          if (!upstream.usage) {
            return finish(cors(Response.json({ error: { message: "Not implemented" } }, { status: 501 })))
          }
          const proxy = await proxyRequestLog("Codex usage", "GET", "/usage", () => upstream.usage!({ headers: request.headers, signal: request.signal }))
          return finish(
            cors(proxy.response),
            proxy.entry,
          )
        }

        if (
          request.method === "GET" &&
          (url.pathname === "/environments" || url.pathname === "/wham/environments")
        ) {
          if (!upstream.environments) {
            return finish(cors(Response.json({ error: { message: "Not implemented" } }, { status: 501 })))
          }
          const proxy = await proxyRequestLog("Codex environments", "GET", "/environments", () =>
            upstream.environments!({ headers: request.headers, signal: request.signal }),
          )
          return finish(
            cors(proxy.response),
            proxy.entry,
          )
        }
        const matched = registry.match(request.method, url.pathname, request.headers)
        if (matched) {
          let proxy: RequestProxyLog | undefined
          try {
            return finish(
              cors(
                await matched.provider.handle(request, matched.descriptor, upstream, {
                  requestId,
                  authFile,
                  logBody,
                  quiet,
                  onProxy: (entry) => {
                    proxy = entry
                  },
                }),
              ),
              proxy,
            )
          } catch (error) {
            return fail(error, proxy)
          }
        }

        const allowedMethods = [...new Set(registry.listRoutes().map((route) => route.method))]
          .filter((method) => method !== request.method)
          .filter((method) => Boolean(registry.match(method, url.pathname, request.headers)))

        if (allowedMethods.length > 0) {
          return finish(cors(Response.json({ error: { message: "Method not allowed" } }, { status: 405 })))
        }

        return finish(cors(Response.json({ error: { message: "Not found" } }, { status: 404 })))
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
    console.log(`Codex runtime is listening on http://${server.hostname}:${server.port}`)
    console.log(`Root:             http://${server.hostname}:${server.port}/`)
    console.log(`Claude messages:  http://${server.hostname}:${server.port}/v1/messages`)
    console.log(`Claude tokens:    http://${server.hostname}:${server.port}/v1/messages/count_tokens`)
    console.log(`Models:           http://${server.hostname}:${server.port}/v1/models`)
    console.log(`Responses:        http://${server.hostname}:${server.port}/v1/responses`)
    console.log(`Chat completions: http://${server.hostname}:${server.port}/v1/chat/completions`)
    console.log(`Usage:            http://${server.hostname}:${server.port}/usage`)
    console.log(`Environments:     http://${server.hostname}:${server.port}/environments`)
    console.log(`Health:           http://${server.hostname}:${server.port}/health`)
    console.log(`Test connection:  http://${server.hostname}:${server.port}/test-connection`)
    console.log(`Health interval:  ${healthIntervalMs}ms`)
    console.log(`Log body:         ${logBody ? "enabled" : "disabled"}${logBody ? " (set LOG_BODY=0 to disable)" : ""}`)
    console.log(`Auth file:        ${authFile}`)
    if (authAccount) console.log(`Auth account:     ${authAccount}`)
    for (const route of registry.listRoutes()) {
      console.log(`Route:            ${route.method} ${route.path} (${route.provider})`)
    }
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
  const headers = loggedHeaders(request.headers)
  console.log(`[${id}] -> ${request.method} ${url.pathname}${url.search} ${JSON.stringify(headers)}`)
  if (bodyPreview) console.log(`[${id}] body ${bodyPreview}`)
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

function loggedHeaders(headers: Headers) {
  const entries: Array<[string, string]> = []
  headers.forEach((value, key) => {
    entries.push([key, redactHeaderValue(key, value)])
  })
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)))
}

function redactHeaderValue(key: string, value: string) {
  if (/^(authorization|proxy-authorization|x-api-key|api-key|anthropic-api-key|cookie|set-cookie)$/i.test(key)) {
    return "[redacted]"
  }
  return redactSecrets(value)
}

function redactSecrets(text: string) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/"?(api[_-]?key|authorization|x-api-key|anthropic-api-key|access|refresh|access_token|refresh_token)"?\s*:\s*"[^"]+"/gi, '"$1":"[redacted]"')
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
  const preview = createLogPreview()
  let completed = false

  async function complete(responseError?: string) {
    if (completed) return
    completed = true
    const tail = decoder.decode()
    preview.append(tail)
    await onComplete(preview.text(), responseError)
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
        preview.append(decoder.decode(chunk.value, { stream: true }))
      } catch (error) {
        await complete(error instanceof Error ? error.message : String(error))
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        await complete(`response cancelled: ${cancelReasonText(reason)}`)
      }
    },
  })

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
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

function createHealthMonitor(upstream: Pick<Upstream_Provider, "checkHealth">, intervalMs: number, timeoutMs: number, quiet: boolean) {
  const state: { current: HealthStatus; timer?: ReturnType<typeof setInterval> } = {
    current: { ok: false, error: "Health check has not run yet" },
  }

  async function run() {
    const previous = state.current.ok
    state.current = await upstream.checkHealth(timeoutMs)
    if (previous === state.current.ok) return
    if (!quiet) {
      console.log(
        state.current.ok
          ? `Codex upstream healthy (${state.current.status}, ${state.current.latencyMs}ms)`
          : `Codex upstream unhealthy (${state.current.error ?? state.current.status ?? "unknown"})`,
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
