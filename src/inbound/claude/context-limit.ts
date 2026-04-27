export function claudeUpstreamErrorMessage(status: number, body: string) {
  const contextMessage = status === 400 || status === 413 ? contextLimitMessage(body) : undefined
  if (contextMessage) return contextMessage
  return `Upstream request failed: ${status} ${body}`
}

export function contextLimitMessage(body: string) {
  const trimmed = body.trim()
  const candidates = [...jsonErrorMessages(trimmed), trimmed]
  return candidates.find(isContextLimitMessage)
}

function isContextLimitMessage(message: string) {
  return /(context[-_ ]?(?:limit|length|window)|context window|input (?:exceeds|is too long)|prompt is too long|maximum (?:context|length)|too many tokens|token limit|request[-_ ]?(?:too[-_ ]?large|exceeds)|exceed(?:s|ed)? (?:the )?(?:maximum )?(?:token|context))/i.test(message)
}

function jsonErrorMessages(text: string): string[] {
  if (!text) return []
  try {
    return errorMessagesFromValue(JSON.parse(text))
  } catch {
    return []
  }
}

function errorMessagesFromValue(value: unknown, depth = 0): string[] {
  if (depth > 4) return []
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap((item) => errorMessagesFromValue(item, depth + 1))
  if (!value || typeof value !== "object") return []

  const record = value as Record<string, unknown>
  return [
    ...errorMessagesFromValue(record.message, depth + 1),
    ...errorMessagesFromValue(record.error, depth + 1),
    ...errorMessagesFromValue(record.detail, depth + 1),
    ...errorMessagesFromValue(record.body, depth + 1),
    ...errorMessagesFromValue(record.code, depth + 1),
    ...errorMessagesFromValue(record.type, depth + 1),
  ]
}
