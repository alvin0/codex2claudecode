import type { JsonObject, SseEvent } from "../types"

export async function consumeCodexSse(
  stream: ReadableStream<Uint8Array> | null,
  onEvent: (event: SseEvent) => void,
  options?: { signal?: AbortSignal },
) {
  if (!stream || options?.signal?.aborted) return

  const decoder = new TextDecoder()
  const reader = stream.getReader()
  const cancel = () => {
    void reader.cancel(options?.signal?.reason).catch(() => undefined)
  }
  let buffer = ""

  options?.signal?.addEventListener("abort", cancel, { once: true })
  try {
    while (true) {
      if (options?.signal?.aborted) return
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })

      while (buffer.includes("\n\n")) {
        const index = buffer.indexOf("\n\n")
        const raw = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const event = parseSseEvent(raw)
        if (event) onEvent(event)
      }
    }

    if (options?.signal?.aborted) return
    buffer += decoder.decode()
    const event = parseSseEvent(buffer)
    if (event) onEvent(event)
  } finally {
    options?.signal?.removeEventListener("abort", cancel)
  }
}

function parseSseEvent(raw: string): SseEvent | undefined {
  const lines = raw.split(/\r?\n/)
  const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim()
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data) return
  return { event, data }
}

export function parseSseJson(event: SseEvent): JsonObject | undefined {
  try {
    return JSON.parse(event.data) as JsonObject
  } catch {
    return
  }
}

export function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}
