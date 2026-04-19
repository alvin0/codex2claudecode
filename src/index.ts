export * from "./types"
export * from "./cli"
export * from "./account-info"
export * from "./auth"
export * from "./client"
export * from "./reasoning"
export * from "./runtime"

import { CodexStandaloneClient } from "./client"
import { resolveAuthFile } from "./paths"
import { startRuntime } from "./runtime"

export async function runExample() {
  const client = await CodexStandaloneClient.fromAuthFile(resolveAuthFile(process.env.CODEX_AUTH_FILE))

  const response = await client.responses({
    model: "gpt-5.1-codex",
    input: "Say hello in one short sentence.",
  })

  console.log(JSON.stringify(response, null, 2))
  console.log("Updated tokens:", client.tokens)
}
