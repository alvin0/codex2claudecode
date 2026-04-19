import { expect } from "bun:test"

export function jwt(payload: unknown) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "",
  ].join(".")
}

export function sse(events: unknown[]) {
  return events.map((event) => `event: ${(event as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`).join("")
}

export async function readSse(response: Response) {
  expect(response.body).toBeTruthy()
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const events: Array<{ event?: string; data: any }> = []

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })

    while (buffer.includes("\n\n")) {
      const index = buffer.indexOf("\n\n")
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const name = raw
        .split(/\r?\n/)
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim()
      const data = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (data) events.push({ event: name, data: JSON.parse(data) })
    }
  }

  return events
}
