import { resolveAuthFile } from "../core/paths"
import { Provider_Registry } from "../core/registry"
import type { RuntimeOptions } from "../core/types"
import { Claude_Inbound_Provider } from "../inbound/claude"
import { OpenAI_Inbound_Provider } from "../inbound/openai"
import { Codex_Upstream_Provider } from "../upstream/codex"

export async function bootstrapRuntime(options?: RuntimeOptions) {
  const authFile = resolveAuthFile(options?.authFile ?? process.env.CODEX_AUTH_FILE)
  const authAccount = options?.authAccount ?? process.env.CODEX_AUTH_ACCOUNT
  const upstream = await Codex_Upstream_Provider.fromAuthFile(authFile, { authAccount })
  const registry = new Provider_Registry()

  registry.register(new Claude_Inbound_Provider())
  registry.register(new OpenAI_Inbound_Provider())

  return {
    authFile,
    authAccount,
    registry,
    upstream,
  }
}
