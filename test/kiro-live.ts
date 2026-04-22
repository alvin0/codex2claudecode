import { cors, responseHeaders } from "../src/http"
import { collectKiroResponse, handleKiroAnthropicMessages, handleKiroChatCompletions, KiroStandaloneClient } from "../src/llm-connect/kiro"
import { defaultKiroAuthFile } from "../src/paths"

type GenerateBody = {
  modelId?: string
  content?: string
  conversationId?: string
  history?: unknown[]
  stream?: boolean
}

type BunServe = (options: {
  hostname: string
  port: number
  fetch(request: Request): Response | Promise<Response>
}) => { hostname: string; port: number }

type BunRuntime = {
  env?: Record<string, string | undefined>
  serve: BunServe
}

function bunRuntime(): BunRuntime {
  const runtime = (globalThis as { Bun?: Partial<BunRuntime> }).Bun
  if (!runtime?.serve) throw new Error("This script must run with Bun")
  return runtime as BunRuntime
}

function env(name: string) {
  return bunRuntime().env?.[name]
}

async function main() {
  const host = env("KIRO_LIVE_HOST") ?? env("HOST") ?? "127.0.0.1"
  const port = Number(env("KIRO_LIVE_PORT") ?? env("PORT") ?? 4041)
  const credsFile = env("KIRO_CREDS_FILE") ?? defaultKiroAuthFile()
  const client = await KiroStandaloneClient.create({ credsFile })

  const server = bunRuntime().serve({
    hostname: host,
    port,
    fetch(request: Request) {
      return handleRequest(request, client, credsFile)
    },
  })

  console.log(`Kiro live API listening at http://${server.hostname}:${server.port}`)
  console.log(`Kiro creds file: ${credsFile}`)
  console.log(`Kiro auth type: ${client.tokens.authType}`)
  console.log("GET  /health")
  console.log("GET  /v1/kiro/models")
  console.log("POST /v1/kiro/generateAssistantResponse")
  console.log("POST /v1/kiro/generateAssistantResponse/collect")
  console.log("POST /v1/messages")
  console.log("POST /v1/chat/completions")
}

async function handleRequest(request: Request, client: KiroStandaloneClient, credsFile: string) {
  const url = new URL(request.url)

  if (request.method === "OPTIONS") {
    return cors(new Response(null, { status: 204 }))
  }

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, credsFile, authType: client.tokens.authType })
    }

    if (request.method === "GET" && url.pathname === "/v1/kiro/models") {
      const models = await client.listAvailableModels()
      return json(models)
    }

    if (request.method === "POST" && url.pathname === "/v1/messages") {
      return cors(await handleKiroAnthropicMessages(client, request))
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      return cors(await handleKiroChatCompletions(client, request))
    }

    if (request.method === "POST" && url.pathname === "/v1/kiro/generateAssistantResponse") {
      const body = await readGenerateBody(request)
      const upstream = await client.generateAssistantResponse({
        modelId: body.modelId,
        content: body.content,
        conversationId: body.conversationId ?? crypto.randomUUID(),
        history: body.history,
        stream: body.stream,
      })
      return cors(
        new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders(upstream.headers),
        }),
      )
    }

    if (request.method === "POST" && url.pathname === "/v1/kiro/generateAssistantResponse/collect") {
      const body = await readGenerateBody(request)
      const upstream = await client.generateAssistantResponse({
        modelId: body.modelId,
        content: body.content,
        conversationId: body.conversationId ?? crypto.randomUUID(),
        history: body.history,
        stream: body.stream,
      })
      const collected = await collectKiroResponse(upstream)
      return json({ status: upstream.status, ...collected })
    }

    if (
      url.pathname === "/health" ||
      url.pathname === "/v1/kiro/models" ||
      url.pathname === "/v1/messages" ||
      url.pathname === "/v1/chat/completions" ||
      url.pathname.startsWith("/v1/kiro/generateAssistantResponse")
    ) {
      return errorJson(405, `${request.method} is not allowed for ${url.pathname}`)
    }

    return errorJson(404, `Route not found: ${url.pathname}`)
  } catch (error) {
    return errorJson(500, error instanceof Error ? error.message : String(error))
  }
}

async function readGenerateBody(request: Request) {
  const body = (await request.json()) as GenerateBody
  if (!body.modelId) throw new Error("modelId is required")
  if (!body.content) throw new Error("content is required")
  return body as {
    modelId: string
    content: string
    conversationId?: string
    history?: unknown[]
    stream?: boolean
  }
}

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json")
  return cors(
    new Response(JSON.stringify(data, null, 2), {
      ...init,
      headers,
    }),
  )
}

function errorJson(status: number, message: string) {
  return json({ error: { message } }, { status })
}

main().catch((error) => {
  console.error(error)
  throw error
})
