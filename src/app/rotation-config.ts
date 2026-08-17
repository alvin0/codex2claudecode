import { readProviderSection, updateProviderSection, type ProviderMode } from "../core/provider-state"

export interface AccountRotationConfig {
  enabled: boolean
}

/**
 * Rotation is opt-in: it spends other accounts' quota, so it only runs once the
 * user turns it on from the rotation screen. `ACCOUNT_ROTATION` overrides the
 * stored setting for scripted runs.
 */
export async function readRotationConfig(mode: ProviderMode, filePath?: string): Promise<AccountRotationConfig> {
  const override = rotationEnvOverride()
  if (override !== undefined) return { enabled: override }

  const section = await readProviderSection(mode, filePath).catch(() => undefined)
  const rotation = section?.rotation as AccountRotationConfig | undefined
  return { enabled: rotation?.enabled === true }
}

export async function writeRotationConfig(mode: ProviderMode, filePath: string | undefined, config: AccountRotationConfig) {
  await updateProviderSection(mode, filePath, async (section) => ({
    ...(section ?? {}),
    rotation: { enabled: config.enabled },
  }))
}

export function rotationEnvOverride() {
  const value = process.env.ACCOUNT_ROTATION
  if (value === undefined || value === "") return undefined
  return value !== "0" && value !== "false"
}
