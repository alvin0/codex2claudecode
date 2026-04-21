import { defaultKiroAuthFile } from "../src/paths"
import { KiroStandaloneClient } from "../src/llm-connect/kiro"

async function main() {
  const credsFile = process.env.KIRO_CREDS_FILE ?? defaultKiroAuthFile()
  const client = await KiroStandaloneClient.create({ credsFile })

  console.log("Kiro creds file:", credsFile)
  console.log("Kiro auth type:", client.tokens.authType)

  const modelId = process.env.KIRO_SMOKE_MODEL
  if (!modelId) {
    console.log("Listing available models...")
    const models = await client.listAvailableModels()
    console.log(JSON.stringify(models, null, 2))
    console.log("Set KIRO_SMOKE_MODEL to also test generateAssistantResponse.")
    return
  }

  const prompt = process.env.KIRO_SMOKE_PROMPT ?? "Reply with exactly: ok"
  console.log(`Calling generateAssistantResponse with model ${modelId}...`)
  const response = await client.generateAssistantResponse({
    modelId,
    content: prompt,
    conversationId: crypto.randomUUID(),
  })

  console.log("Status:", response.status)
  const parsed = await readKiroStream(response)
  console.log("Content:", parsed.content)
  if (parsed.contextUsagePercentage !== undefined) {
    console.log("Context usage %:", parsed.contextUsagePercentage)
  }
  if (parsed.usage !== undefined) {
    console.log("Usage:", parsed.usage)
  }
}

async function readKiroStream(response: Response) {
  if (!response.body) throw new Error("Kiro response did not include a body")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let content = ""
  let usage: unknown
  let contextUsagePercentage: number | undefined

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })

    const matches = buffer.match(/\{"(?:content|usage|contextUsagePercentage)"[\s\S]*?\}/g) ?? []
    if (!matches.length) continue

    let consumedUntil = 0
    for (const match of matches) {
      const index = buffer.indexOf(match, consumedUntil)
      if (index < 0) continue
      consumedUntil = index + match.length

      try {
        const data = JSON.parse(match) as { content?: string; usage?: unknown; contextUsagePercentage?: number }
        if (typeof data.content === "string") content += data.content
        if (data.usage !== undefined) usage = data.usage
        if (typeof data.contextUsagePercentage === "number") contextUsagePercentage = data.contextUsagePercentage
      } catch {
        consumedUntil = index
        break
      }
    }

    if (consumedUntil > 0) buffer = buffer.slice(consumedUntil)
  }

  return { content, usage, contextUsagePercentage }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
