import { writeCodexCliConfig } from "../app/codex-cli-config"
import type { Upstream_Provider } from "../core/interfaces"
import { expandHome } from "../core/paths"
import {
  CODEX_CLI_API_KEY_ENV,
  CODEX_CLI_CONFIG_FILE,
  CODEX_CLI_PROVIDER_ID,
  codexCliConfigPreview,
  codexGatewayBaseUrl,
  config as exportConfigCodex,
} from "../inbound/openai/export-config-codex"
import { codex2ClaudeModelIds } from "../inbound/openai/model-alias"

export const codexCliProfilePath = () => expandHome(CODEX_CLI_CONFIG_FILE)

export function codexCliStaticEntries(baseUrl: string): Array<{ key: string; value: string }> {
  return [
    { key: "model_provider", value: CODEX_CLI_PROVIDER_ID },
    { key: "base_url", value: codexGatewayBaseUrl(baseUrl) },
    { key: "wire_api", value: exportConfigCodex.wire_api },
    { key: "env_key", value: exportConfigCodex.env_key },
  ]
}

export function codexCliProfilePreview(baseUrl: string, makeDefault = false) {
  return codexCliConfigPreview({ baseUrl: codexGatewayBaseUrl(baseUrl), makeDefault })
}

export const CODEX_CLI_MODES = [
  { label: "session", description: "codex -c model_provider=codex2claude uses the gateway" },
  { label: "default", description: "plain codex uses the gateway for everything" },
] as const

/** The model ids Codex will offer once it reads `/v1/models` from this gateway. */
export async function codexCliModelIds(upstream?: Upstream_Provider): Promise<string[]> {
  if (!upstream?.listModelDescriptors) return []
  try {
    return (await upstream.listModelDescriptors()).flatMap((model) => codex2ClaudeModelIds(model))
  } catch {
    return []
  }
}

export async function applyCodexCliSetup(baseUrl: string, makeDefault = false) {
  const result = await writeCodexCliConfig({ baseUrl: codexGatewayBaseUrl(baseUrl), makeDefault })

  return [
    `Updated ${result.path}`,
    ...(result.backupPath ? [`Backup: ${result.backupPath}`] : []),
    ...(result.clearedModelsCache ? ["Cleared models_cache.json so Codex asks this gateway for its catalog"] : []),
    "",
    `  export ${CODEX_CLI_API_KEY_ENV}=codex2claudecode`,
    ...(makeDefault
      ? [`  codex   # this gateway is now the default provider`]
      : [
        `  codex                                  # unchanged: the real Codex models`,
        `  codex -c model_provider=${CODEX_CLI_PROVIDER_ID}   # this gateway: ${CODEX_CLI_PROVIDER_ID}-<model>`,
      ]),
    "",
    `Codex binds one provider per session, so the two model lists cannot share a picker.`,
  ].join("\n")
}
