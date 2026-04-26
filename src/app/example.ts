import { resolveAuthFile } from "../core/paths"
import { CodexStandaloneClient } from "../upstream/codex/client"

export async function runExample() {
  const client = await CodexStandaloneClient.fromAuthFile(resolveAuthFile(process.env.CODEX_AUTH_FILE))

  const response = await client.responses({
    model: "gpt-5.5",
    input: "Say hello in one short sentence.",
  })

  console.log(JSON.stringify(response, null, 2))
  console.log("Updated tokens:", client.tokens)
}
