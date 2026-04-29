import { describe, expect, test } from "bun:test"
import { interceptResponseStream, withChunkCallback } from "../../src/core/stream-utils"

function makeStreamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(body, { status, headers: { "content-type": "text/plain" } })
}

async function consumeResponse(response: Response): Promise<string> {
  return response.text()
}

describe("interceptResponseStream", () => {
  test("passes through body content unchanged", async () => {
    const response = makeStreamResponse(["hello", " world"])
    const intercepted = interceptResponseStream(response)
    const text = await consumeResponse(intercepted)
    expect(text).toBe("hello world")
  })

  test("preserves status, statusText, and headers", async () => {
    const response = makeStreamResponse(["data"], 201)
    const intercepted = interceptResponseStream(response)
    expect(intercepted.status).toBe(201)
    expect(intercepted.headers.get("content-type")).toBe("text/plain")
  })

  test("calls onChunk for each chunk", async () => {
    const chunks: string[] = []
    const response = makeStreamResponse(["a", "b", "c"])
    const intercepted = interceptResponseStream(response, {
      onChunk: (chunk) => chunks.push(chunk),
    })
    await consumeResponse(intercepted)
    expect(chunks.join("")).toBe("abc")
  })

  test("calls onComplete with preview text", async () => {
    let preview: string | undefined
    const response = makeStreamResponse(["hello world"])
    const intercepted = interceptResponseStream(response, {
      onComplete: (p) => { preview = p },
    })
    await consumeResponse(intercepted)
    expect(preview).toBe("hello world")
  })

  test("preview is bounded by previewLimit", async () => {
    let preview: string | undefined
    const response = makeStreamResponse(["a".repeat(100)])
    const intercepted = interceptResponseStream(response, {
      previewLimit: 10,
      onComplete: (p) => { preview = p },
    })
    await consumeResponse(intercepted)
    expect(preview).toBe("a".repeat(10))
  })

  test("handles empty body response", async () => {
    let completeCalled = false
    const response = new Response(null, { status: 204 })
    const intercepted = interceptResponseStream(response, {
      onComplete: (p) => {
        completeCalled = true
        expect(p).toBeUndefined()
      },
    })
    expect(completeCalled).toBe(true)
    expect(intercepted.body).toBeNull()
  })

  test("calls onCancel when stream is cancelled", async () => {
    let cancelReason: unknown
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data"))
        // Don't close - let it hang
      },
    })
    const response = new Response(body)
    const intercepted = interceptResponseStream(response, {
      onCancel: (reason) => { cancelReason = reason },
    })
    const reader = intercepted.body!.getReader()
    await reader.read()
    await reader.cancel("test cancel")
    expect(cancelReason).toBe("test cancel")
  })
})

describe("withChunkCallback", () => {
  test("passes through body content unchanged", async () => {
    const response = makeStreamResponse(["hello", " world"])
    const wrapped = withChunkCallback(response, () => {})
    const text = await consumeResponse(wrapped)
    expect(text).toBe("hello world")
  })

  test("calls onChunk for each chunk", async () => {
    const chunks: string[] = []
    const response = makeStreamResponse(["x", "y"])
    const wrapped = withChunkCallback(response, (chunk) => chunks.push(chunk))
    await consumeResponse(wrapped)
    expect(chunks.join("")).toBe("xy")
  })

  test("handles null body", () => {
    const response = new Response(null)
    const wrapped = withChunkCallback(response, () => {})
    expect(wrapped.body).toBeNull()
  })
})
