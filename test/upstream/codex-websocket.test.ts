import { describe, expect, test } from "bun:test"

import { Codex_Upstream_Provider } from "../../src/upstream/codex"
import type { Canonical_Event, Canonical_Request } from "../../src/core/canonical"

class FakeWebSocket extends EventTarget {
  readyState = 0
  readonly sent: string[] = []

  constructor(readonly url: string, readonly headers: Record<string, string>, readonly failHandshake = false) {
    super()
    queueMicrotask(() => {
      if (this.failHandshake) {
        this.dispatchEvent(new Event("error"))
        return
      }
      this.readyState = 1
      this.dispatchEvent(new Event("open"))
    })
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
  }

  emit(payload: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }))
  }
}

function canonicalRequest(): Canonical_Request {
  return {
    model: "gpt-5.6-sol",
    instructions: "Be helpful",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: true,
    passthrough: false,
    metadata: {},
  }
}

const completedTurn = [
  { type: "codex.rate_limits", plan_type: "prolite" },
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", status: "in_progress", content: [] } },
  { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: "OK" },
  { type: "response.output_text.done", output_index: 0, item_id: "msg_1", content_index: 0, text: "OK" },
  { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", status: "completed", content: [{ type: "output_text", text: "OK" }] } },
  { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
]

function provider(sockets: FakeWebSocket[], options?: { failHandshake?: boolean; fetch?: typeof fetch }) {
  return new Codex_Upstream_Provider({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 60_000,
    useWebSocket: true,
    webSocket: (url, headers) => {
      const socket = new FakeWebSocket(url, headers, options?.failHandshake)
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    fetch: options?.fetch ?? ((() => Promise.reject(new Error("unexpected HTTP call"))) as unknown as typeof fetch),
  })
}

async function collect(events: AsyncIterable<Canonical_Event>) {
  const collected: Canonical_Event[] = []
  for await (const event of events) collected.push(event)
  return collected
}

describe("Codex WebSocket transport", () => {
  test("streams a turn over the websocket and reuses the socket", async () => {
    const sockets: FakeWebSocket[] = []
    const upstream = provider(sockets)

    const first = await upstream.proxy(canonicalRequest())
    expect(first.type).toBe("canonical_stream")
    expect(sockets).toHaveLength(1)

    const socket = sockets[0]!
    expect(socket.url).toBe("wss://chatgpt.com/backend-api/codex/responses")
    expect(socket.headers["OpenAI-Beta"] ?? socket.headers["openai-beta"]).toBe("responses_websockets=2026-02-06")
    expect(socket.headers.authorization).toBe("Bearer access")
    expect(socket.headers["content-type"]).toBeUndefined()

    const request = JSON.parse(socket.sent[0]!)
    expect(request.type).toBe("response.create")
    expect(request.model).toBe("gpt-5.6-sol")
    expect(request.stream).toBe(true)

    for (const event of completedTurn) socket.emit(event)

    const events = await collect((first as { events: AsyncIterable<Canonical_Event> }).events)
    expect(events.filter((event) => event.type === "text_delta")).toHaveLength(1)
    expect(events.at(-1)?.type).toBe("message_stop")

    const second = await upstream.proxy(canonicalRequest())
    expect(second.type).toBe("canonical_stream")
    expect(sockets).toHaveLength(1)
    expect(socket.sent).toHaveLength(2)
  })

  test("falls back to HTTP when the websocket handshake fails", async () => {
    const sockets: FakeWebSocket[] = []
    const calls: string[] = []
    const upstream = provider(sockets, {
      failHandshake: true,
      fetch: ((url: string) => {
        calls.push(String(url))
        return Promise.resolve(new Response("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n"))
      }) as unknown as typeof fetch,
    })

    const result = await upstream.proxy(canonicalRequest())
    expect(result.type).toBe("canonical_stream")
    expect(sockets).toHaveLength(1)
    expect(calls).toEqual(["https://chatgpt.com/backend-api/codex/responses"])
  })

  test("keeps using HTTP for non-streaming requests", async () => {
    const sockets: FakeWebSocket[] = []
    const upstream = provider(sockets, {
      fetch: (() => Promise.resolve(new Response("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n"))) as unknown as typeof fetch,
    })

    const result = await upstream.proxy({ ...canonicalRequest(), stream: false })
    expect(result.type).toBe("canonical_response")
    expect(sockets).toHaveLength(0)
  })
})
