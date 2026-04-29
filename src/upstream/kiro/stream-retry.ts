import { responseHeaders } from "../../core/http"
import { kiroFirstTokenMaxRetries, kiroFirstTokenTimeoutMs } from "./constants"

export class FirstTokenTimeoutError extends Error {
  readonly attempts: number

  constructor(attempts: number) {
    super(`Kiro stream did not emit a first token after ${attempts} attempt${attempts === 1 ? "" : "s"}`)
    this.name = "FirstTokenTimeoutError"
    this.attempts = attempts
  }
}

export async function streamWithFirstTokenRetry(
  makeResponse: (signal?: AbortSignal) => Promise<Response>,
  options: { signal?: AbortSignal; timeoutMs?: number; maxRetries?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? kiroFirstTokenTimeoutMs()
  const maxRetries = options.maxRetries ?? kiroFirstTokenMaxRetries()
  const maxAttempts = maxRetries + 1

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(options.signal)
    const attemptController = new AbortController()
    const signal = combineSignals(options.signal, attemptController.signal)
    const response = await makeResponse(signal)
    const reader = response.body?.getReader()
    if (!reader) return response

    try {
      const first = await readFirstChunk(reader, timeoutMs, options.signal)
      if (first.done) return rebuildResponse(response, reader)
      return rebuildResponse(response, reader, first.value)
    } catch (error) {
      if (!(error instanceof FirstTokenAttemptTimeoutError)) throw error
      attemptController.abort(error)
      void reader.cancel(error).catch(() => undefined)
      if (attempt >= maxAttempts) throw new FirstTokenTimeoutError(attempt)
    }
  }

  throw new FirstTokenTimeoutError(maxAttempts)
}

function rebuildResponse(response: Response, reader: ReadableStreamDefaultReader<Uint8Array>, firstChunk?: Uint8Array) {
  let sentFirstChunk = firstChunk === undefined
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirstChunk && firstChunk) {
        sentFirstChunk = true
        controller.enqueue(firstChunk)
        return
      }
      const chunk = await reader.read()
      if (chunk.done) {
        controller.close()
        return
      }
      controller.enqueue(chunk.value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) })
}

async function readFirstChunk(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number, signal?: AbortSignal) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new FirstTokenAttemptTimeoutError()), timeoutMs)
        if (signal) {
          abortListener = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
          signal.addEventListener("abort", abortListener, { once: true })
        }
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (signal && abortListener) signal.removeEventListener("abort", abortListener)
  }
}

function combineSignals(...signals: Array<AbortSignal | undefined>) {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (!active.length) return undefined
  if (active.length === 1) return active[0]
  return AbortSignal.any(active)
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError")
}

class FirstTokenAttemptTimeoutError extends Error {
  constructor() {
    super("Kiro stream first-token timeout")
    this.name = "FirstTokenAttemptTimeoutError"
  }
}
