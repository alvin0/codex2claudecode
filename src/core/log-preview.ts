import { LOG_BODY_PREVIEW_LIMIT } from "./constants"

export function createLogPreview(limit = LOG_BODY_PREVIEW_LIMIT) {
  const chunks: string[] = []
  let length = 0

  return {
    append(text: string) {
      if (!text || length >= limit) return
      const next = text.slice(0, limit - length)
      chunks.push(next)
      length += next.length
    },
    text() {
      return chunks.length ? chunks.join("") : undefined
    },
  }
}
