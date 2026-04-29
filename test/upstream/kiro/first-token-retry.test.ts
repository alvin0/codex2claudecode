import { describe, expect, test } from "bun:test"

import { FirstTokenTimeoutError, streamWithFirstTokenRetry } from "../../../src/upstream/kiro"

const encoder = new TextEncoder()

function immediateResponse(...chunks: string[]) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }))
}

function stalledResponse(onCancel?: () => void) {
  return new Response(new ReadableStream<Uint8Array>({
    cancel() {
      onCancel?.()
    },
  }))
}

async function responseText(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  return text + decoder.decode()
}

describe("Kiro first-token retry", () => {
  test("returns immediate streams without retrying and preserves the first chunk", async () => {
    let calls = 0
    const response = await streamWithFirstTokenRetry(() => {
      calls += 1
      return Promise.resolve(immediateResponse("first", "second"))
    }, { timeoutMs: 5, maxRetries: 1 })

    expect(calls).toBe(1)
    expect(await responseText(response)).toBe("firstsecond")
  })

  test("retries a stalled first attempt before returning the successful stream", async () => {
    let calls = 0
    let cancelled = 0
    const response = await streamWithFirstTokenRetry(() => {
      calls += 1
      if (calls === 1) return Promise.resolve(stalledResponse(() => { cancelled += 1 }))
      return Promise.resolve(immediateResponse("ok"))
    }, { timeoutMs: 1, maxRetries: 1 })

    expect(calls).toBe(2)
    expect(cancelled).toBe(1)
    expect(await responseText(response)).toBe("ok")
  })

  test("does not wait for timed-out body cancellation before retrying", async () => {
    let calls = 0
    let cancelStarted = false
    const response = await streamWithFirstTokenRetry(() => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
          cancel() {
            cancelStarted = true
            return new Promise(() => {})
          },
        })))
      }
      return Promise.resolve(immediateResponse("recovered"))
    }, { timeoutMs: 1, maxRetries: 1 })

    expect(calls).toBe(2)
    expect(cancelStarted).toBe(true)
    expect(await responseText(response)).toBe("recovered")
  })

  test("throws after all first-token attempts stall", async () => {
    let calls = 0
    try {
      await streamWithFirstTokenRetry(() => {
        calls += 1
        return Promise.resolve(stalledResponse())
      }, { timeoutMs: 1, maxRetries: 2 })
      throw new Error("expected first-token timeout")
    } catch (error) {
      expect(error).toBeInstanceOf(FirstTokenTimeoutError)
      expect((error as FirstTokenTimeoutError).attempts).toBe(3)
      expect(calls).toBe(3)
    }
  })

  test("propagates caller aborts without retrying indefinitely", async () => {
    const controller = new AbortController()
    let calls = 0
    const promise = streamWithFirstTokenRetry(() => {
      calls += 1
      return Promise.resolve(stalledResponse())
    }, { signal: controller.signal, timeoutMs: 50, maxRetries: 3 })

    controller.abort(new DOMException("caller aborted", "AbortError"))

    try {
      await promise
      throw new Error("expected abort")
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException)
      expect((error as DOMException).name).toBe("AbortError")
      expect(calls).toBe(1)
    }
  })
})
