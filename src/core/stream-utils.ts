import { createLogPreview } from "./log-preview"

/**
 * Options for wrapping a response body with logging/interception.
 */
export interface StreamInterceptOptions {
  /** Maximum number of characters to capture for preview. Defaults to LOG_BODY_PREVIEW_LIMIT. */
  previewLimit?: number
  /** Called with each decoded text chunk as it flows through. */
  onChunk?: (chunk: string) => void
  /** Called when the stream completes (normally or via error/cancel) with the preview text. */
  onComplete?: (preview: string | undefined) => void
  /** Called when the stream is cancelled by the downstream consumer. */
  onCancel?: (reason: unknown) => void
  /** Called when an error occurs during stream reading. */
  onError?: (error: unknown) => void
}

/**
 * Wrap a Response with stream interception for logging and preview capture.
 *
 * Returns a new Response with the same status, statusText, and headers.
 * The body is wrapped to capture a bounded preview and invoke callbacks
 * without full-body buffering.
 *
 * If the response has no body, returns it unchanged and calls onComplete(undefined).
 */
export function interceptResponseStream(
  response: Response,
  options: StreamInterceptOptions = {},
): Response {
  if (!response.body) {
    options.onComplete?.(undefined)
    return response
  }

  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const preview = createLogPreview(options.previewLimit)
  let completed = false

  function complete() {
    if (completed) return
    completed = true
    const tail = decoder.decode()
    if (tail) {
      preview.append(tail)
      options.onChunk?.(tail)
    }
    options.onComplete?.(preview.text())
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          complete()
          controller.close()
          return
        }
        controller.enqueue(chunk.value)
        const text = decoder.decode(chunk.value, { stream: true })
        preview.append(text)
        options.onChunk?.(text)
      } catch (error) {
        complete()
        options.onError?.(error)
        controller.error(error)
      }
    },
    cancel(reason) {
      complete()
      options.onCancel?.(reason)
      return reader.cancel(reason)
    },
  })

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/**
 * Wrap a Response body to call onChunk for each decoded text chunk.
 * Simpler variant for upstream providers that only need chunk forwarding.
 */
export function withChunkCallback(
  response: Response,
  onChunk: (chunk: string) => void,
): Response {
  if (!response.body) return response

  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          const tail = decoder.decode()
          if (tail) onChunk(tail)
          controller.close()
          return
        }
        onChunk(decoder.decode(chunk.value, { stream: true }))
        controller.enqueue(chunk.value)
      } catch (error) {
        const tail = decoder.decode()
        if (tail) onChunk(tail)
        controller.error(error)
      }
    },
    async cancel(reason) {
      const tail = decoder.decode()
      if (tail) onChunk(tail)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
