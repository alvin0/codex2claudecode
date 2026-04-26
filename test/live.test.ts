import { existsSync } from "node:fs"
import { describe, expect, test } from "bun:test"

import { CodexStandaloneClient } from "../src/upstream/codex/client"
import { resolveAuthFile } from "../src/core/paths"

describe("live Codex smoke test", () => {
  const authFile = resolveAuthFile(process.env.CODEX_AUTH_FILE)
  const testOrSkip = existsSync(authFile) ? test : test.skip
  const reason = `auth file not found at ${authFile}`

  testOrSkip(`streams a simple response using auth-codex.json${testOrSkip === test.skip ? ` (skipped: ${reason})` : ""}`, async () => {
    const client = await CodexStandaloneClient.fromAuthFile(authFile)
    const stream = await client.responsesStream({
      model: "gpt-5.4-mini_low",
      instructions: "You are a test responder.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly: ok" }] }],
      store: false,
    })
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let text = ""

    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })

      while (buffer.includes("\n\n")) {
        const index = buffer.indexOf("\n\n")
        const raw = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const dataText = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (!dataText) continue
        const data = JSON.parse(dataText)
        if (data.type === "response.output_text.delta") text += data.delta
        if (data.type === "response.output_text.done") text = data.text
      }
    }

    expect(text.trim()).toBe("ok")
  })
})
