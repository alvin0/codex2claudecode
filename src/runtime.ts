import { CodexStandaloneClient } from "./client"
import { LOG_BODY_PREVIEW_LIMIT } from "./constants"
import { handleClaudeCountTokens, handleClaudeMessages } from "./claude"
import { cors, responseHeaders } from "./http"
import { resolveAuthFile } from "./paths"
import { normalizeReasoningBody, normalizeRequestBody } from "./reasoning"
import type { HealthStatus, JsonObject, RequestLogEntry, RuntimeOptions } from "./types"

export async function startRuntime(options?: RuntimeOptions) {
  const authFile = resolveAuthFile(options?.authFile ?? process.env.CODEX_AUTH_FILE)
  const authAccount = options?.authAccount ?? process.env.CODEX_AUTH_ACCOUNT
  const hostname = options?.hostname ?? process.env.HOST ?? "127.0.0.1"
  const port = options?.port ?? Number(process.env.PORT || 8787)
  const healthIntervalMs = options?.healthIntervalMs ?? Number(process.env.HEALTH_INTERVAL_MS || 30_000)
  const healthTimeoutMs = options?.healthTimeoutMs ?? Number(process.env.HEALTH_TIMEOUT_MS || 5000)
  const logBody = options?.logBody ?? process.env.LOG_BODY !== "0"
  const quiet = options?.quiet ?? false
  const onRequestLog = options?.onRequestLog
  const client = await CodexStandaloneClient.fromAuthFile(authFile, { authAccount })
  const health = createHealthMonitor(client, healthIntervalMs, healthTimeoutMs, quiet)

  health.start()

  const server = Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const requestId = crypto.randomUUID().slice(0, 8)
      const started = Date.now()
      const url = new URL(request.url)
      const bodyPreview = logBody ? await readBodyPreview(request) : undefined

      if (!quiet) logRequestStart(requestId, request, url, bodyPreview)

      async function requestLog(response: Response, durationMs: number, error?: string): Promise<RequestLogEntry> {
        return {
          id: requestId,
          at: new Date().toISOString(),
          method: request.method,
          path: `${url.pathname}${url.search}`,
          status: response.status,
          durationMs,
          error: error ?? await responseErrorMessage(response),
        }
      }

      async function finish(response: Response) {
        const durationMs = Date.now() - started
        if (!quiet) logResponseEnd(requestId, request, url, response, durationMs)
        onRequestLog?.(await requestLog(response, durationMs))
        return response
      }

      async function fail(error: unknown) {
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
        onRequestLog?.(await requestLog(response, durationMs, error instanceof Error ? error.message : String(error)))
        return response
      }

      if (request.method === "OPTIONS") return finish(cors(new Response(null, { status: 204 })))
      if (request.method === "GET" && url.pathname === "/health") {
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
        return finish(
          cors(await proxyUpstream(() => client.usage({ headers: request.headers, signal: request.signal }))),
        )
      }

      if (
        request.method === "GET" &&
        (url.pathname === "/environments" || url.pathname === "/wham/environments")
      ) {
        return finish(
          cors(await proxyUpstream(() => client.environments({ headers: request.headers, signal: request.signal }))),
        )
      }

      if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        return finish(cors(await handleClaudeCountTokens(request)))
      }

      if (request.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/v1/message")) {
        return finish(cors(await handleClaudeMessages(client, request, requestId, logBody && !quiet)))
      }

      if (request.method !== "POST") {
        return finish(cors(Response.json({ error: { message: "Method not allowed" } }, { status: 405 })))
      }

      if (url.pathname !== "/v1/responses" && url.pathname !== "/v1/chat/completions") {
        return finish(cors(Response.json({ error: { message: "Not found" } }, { status: 404 })))
      }

      try {
        const body = normalizeRequestBody(url.pathname, (await request.json()) as JsonObject)
        if (logBody && !quiet) logUpstreamBody(requestId, body)
        const response = await client.proxy(body, {
          headers: request.headers,
          signal: request.signal,
        })
        if (!response.ok) {
          const text = await response.text()
          if (!quiet) console.error(`[${requestId}] upstream error ${response.status}: ${text.slice(0, LOG_BODY_PREVIEW_LIMIT)}`)
          const errorResponse = cors(
            new Response(text, {
              status: response.status,
              statusText: response.statusText,
              headers: responseHeaders(response.headers),
            }),
          )
          const durationMs = Date.now() - started
          if (!quiet) logResponseEnd(requestId, request, url, errorResponse, durationMs)
          onRequestLog?.(await requestLog(errorResponse, durationMs, text.slice(0, LOG_BODY_PREVIEW_LIMIT)))
          return errorResponse
        }
        return finish(
          cors(
            new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers: responseHeaders(response.headers),
            }),
          ),
        )
      } catch (error) {
        return fail(error)
      }
    },
  })

  const stop = server.stop.bind(server)
  server.stop = (closeActiveConnections?: boolean) => {
    health.stop()
    return stop(closeActiveConnections)
  }

  if (!quiet) {
    console.log(`Codex runtime is listening on http://${server.hostname}:${server.port}`)
    console.log(`Claude messages:  http://${server.hostname}:${server.port}/v1/messages`)
    console.log(`Claude tokens:    http://${server.hostname}:${server.port}/v1/messages/count_tokens`)
    console.log(`Responses:        http://${server.hostname}:${server.port}/v1/responses`)
    console.log(`Chat completions: http://${server.hostname}:${server.port}/v1/chat/completions`)
    console.log(`Usage:            http://${server.hostname}:${server.port}/usage`)
    console.log(`Environments:     http://${server.hostname}:${server.port}/environments`)
    console.log(`Health:           http://${server.hostname}:${server.port}/health`)
    console.log(`Health interval:  ${healthIntervalMs}ms`)
    console.log(`Log body:         ${logBody ? "enabled" : "disabled"}${logBody ? " (set LOG_BODY=0 to disable)" : ""}`)
    console.log(`Auth file:        ${authFile}`)
    if (authAccount) console.log(`Auth account:     ${authAccount}`)
  }

  return server
}

async function readBodyPreview(request: Request) {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return
  try {
    const text = await request.clone().text()
    return redactSecrets(text).slice(0, LOG_BODY_PREVIEW_LIMIT)
    /* node:coverage ignore next 3 */
  } catch (error) {
    return `<failed to read body: ${error instanceof Error ? error.message : String(error)}>`
  }
}

function logRequestStart(id: string, request: Request, url: URL, bodyPreview?: string) {
  const headers = interestingHeaders(request.headers)
  console.log(`[${id}] -> ${request.method} ${url.pathname}${url.search} ${JSON.stringify(headers)}`)
  if (bodyPreview) console.log(`[${id}] body ${bodyPreview}`)
}

function logUpstreamBody(id: string, body: JsonObject) {
  console.log(
    `[${id}] upstream body ${redactSecrets(JSON.stringify(normalizeReasoningBody(body))).slice(0, LOG_BODY_PREVIEW_LIMIT)}`,
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

function createHealthMonitor(client: CodexStandaloneClient, intervalMs: number, timeoutMs: number, quiet: boolean) {
  const state: { current: HealthStatus; timer?: ReturnType<typeof setInterval> } = {
    current: { ok: false, error: "Health check has not run yet" },
  }

  async function run() {
    const previous = state.current.ok
    state.current = await client.checkHealth(timeoutMs)
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
