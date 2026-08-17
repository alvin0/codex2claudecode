import { parseJsonObject } from "../../core/sse"
import type { JsonObject } from "../../core/types"
import { CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS, DEFAULT_CODEX_WEBSOCKET_ENDPOINT } from "./constants"

/**
 * Events that end a `response.create` exchange. The socket stays open afterwards
 * so the next request can reuse it.
 */
const TERMINAL_EVENTS = new Set(["response.completed", "response.failed", "response.incomplete", "error"])

export type CodexWebSocketFactory = (url: string, headers: Record<string, string>) => WebSocket

const defaultFactory: CodexWebSocketFactory = (url, headers) => new WebSocket(url, { headers } as unknown as string[])

export interface CodexWebSocketTransportOptions {
  endpoint?: string
  webSocket?: CodexWebSocketFactory
  connectTimeoutMs?: number
  maxIdleSockets?: number
}

/**
 * Streams Codex `responses` turns over `wss://.../backend-api/codex/responses`.
 *
 * The upstream frames are the same JSON events the SSE endpoint emits, so each
 * frame is re-encoded as an SSE event and the existing SSE parser is reused.
 * Sockets are pooled and reused between turns — that connection reuse is the
 * only reason the WebSocket transport is faster than the HTTP one.
 */
export class CodexWebSocketTransport {
  private readonly endpoint: string
  private readonly factory: CodexWebSocketFactory
  private readonly connectTimeoutMs: number
  private readonly maxIdleSockets: number
  private readonly idle: WebSocket[] = []
  private poolToken?: string

  constructor(options?: CodexWebSocketTransportOptions) {
    this.endpoint = options?.endpoint ?? DEFAULT_CODEX_WEBSOCKET_ENDPOINT
    this.factory = options?.webSocket ?? defaultFactory
    this.connectTimeoutMs = options?.connectTimeoutMs ?? CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS
    this.maxIdleSockets = options?.maxIdleSockets ?? 4
  }

  async stream(body: JsonObject, headers: Headers, signal?: AbortSignal): Promise<Response> {
    const socket = await this.acquire(headers)
    const stream = this.toSseStream(socket, body, signal)
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
  }

  close() {
    for (const socket of this.idle.splice(0)) socket.close()
  }

  private async acquire(headers: Headers) {
    const token = headers.get("authorization") ?? ""
    if (token !== this.poolToken) {
      this.close()
      this.poolToken = token
    }

    while (this.idle.length > 0) {
      const socket = this.idle.pop()
      if (socket && socket.readyState === WebSocket.OPEN) return socket
    }

    return this.connect(headers)
  }

  private release(socket: WebSocket) {
    if (socket.readyState !== WebSocket.OPEN) return
    if (this.idle.length >= this.maxIdleSockets) {
      socket.close()
      return
    }
    this.idle.push(socket)
  }

  private async connect(headers: Headers) {
    const socket = this.factory(this.endpoint, Object.fromEntries(headers))

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error(`Codex WebSocket connect timed out after ${this.connectTimeoutMs}ms`))
      }, this.connectTimeoutMs)

      const settle = (error?: Error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }

      socket.addEventListener("open", () => settle(), { once: true })
      socket.addEventListener("error", () => settle(new Error("Codex WebSocket handshake failed")), { once: true })
      socket.addEventListener("close", () => settle(new Error("Codex WebSocket closed during handshake")), { once: true })
    })

    return socket
  }

  private toSseStream(socket: WebSocket, body: JsonObject, signal?: AbortSignal) {
    const encoder = new TextEncoder()

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        let settled = false

        const cleanup = () => {
          socket.removeEventListener("message", onMessage)
          socket.removeEventListener("close", onClose)
          socket.removeEventListener("error", onError)
          signal?.removeEventListener("abort", onAbort)
        }

        const finish = () => {
          if (settled) return
          settled = true
          cleanup()
          this.release(socket)
          controller.close()
        }

        const fail = (error: Error) => {
          if (settled) return
          settled = true
          cleanup()
          socket.close()
          controller.error(error)
        }

        function onMessage(event: MessageEvent) {
          if (settled) return
          const text = typeof event.data === "string" ? event.data : String(event.data)
          const parsed = parseJsonObject(text) as JsonObject
          const type = typeof parsed.type === "string" ? parsed.type : undefined
          controller.enqueue(encoder.encode(`${type ? `event: ${type}\n` : ""}data: ${text}\n\n`))
          if (type && TERMINAL_EVENTS.has(type)) finish()
        }

        function onClose() {
          fail(new Error("Codex WebSocket closed before the response completed"))
        }

        function onError() {
          fail(new Error("Codex WebSocket stream failed"))
        }

        function onAbort() {
          fail(new Error("Codex WebSocket stream aborted"))
        }

        socket.addEventListener("message", onMessage)
        socket.addEventListener("close", onClose, { once: true })
        socket.addEventListener("error", onError, { once: true })
        signal?.addEventListener("abort", onAbort, { once: true })

        if (signal?.aborted) {
          onAbort()
          return
        }

        try {
          socket.send(JSON.stringify({ type: "response.create", ...body }))
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      },
    })
  }
}
