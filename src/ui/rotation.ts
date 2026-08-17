import { writeRotationConfig } from "../app/rotation-config"
import { asRotatingUpstream } from "../app/rotating-upstream"
import type { ProviderMode } from "../core/provider-state"
import { parseQuotaResetAt, parseQuotaUsedPercent, type AccountCooldown } from "../core/rotation"

export type RotationAccountStatus = "active" | "ready" | "resting"

export interface RotationAccountView {
  key: string
  status: RotationAccountStatus
  /** Why the account is resting, empty for accounts that can serve requests. */
  detail: string
  /** Quota readout from the provider's own usage endpoint, empty until it is loaded. */
  quota: string
}

export interface RotationView {
  enabled: boolean
  /** False while the provider has fewer than two accounts and there is nothing to rotate to. */
  rotatable: boolean
  activeAccount: string
  accounts: RotationAccountView[]
  restingCount: number
}

export interface RotationFallback {
  enabled: boolean
  accounts: string[]
  activeAccount?: string
}

/** Usage payload per account, loaded separately because it costs one call per account. */
export type RotationUsageMap = Record<string, unknown>

/** Matches the single-account limits cadence; one call per account is not free. */
export const ROTATION_USAGE_REFRESH_INTERVAL_MS = 5 * 60_000

const REASON_LABEL: Record<AccountCooldown["reason"], string> = {
  auth: "auth failed",
  quota: "quota",
  server: "upstream error",
}

/**
 * Rotation state for the dashboard and the rotation screen, or undefined when the
 * provider has fewer than two accounts and there is nothing to rotate between.
 */
export function rotationView(upstream: unknown, usage: RotationUsageMap = {}, now = Date.now()): RotationView | undefined {
  const rotating = asRotatingUpstream(upstream)
  if (!rotating) return undefined

  const accounts = rotating.accounts.map((key): RotationAccountView => {
    const cooldown = rotating.accountCooldowns[key]
    const resting = cooldown !== undefined && cooldown.until > now
    return {
      key,
      status: resting ? "resting" : key === rotating.activeAccount ? "active" : "ready",
      detail: resting ? restingDetail(cooldown, now) : "",
      quota: quotaDetail(usage[key], now),
    }
  })

  return {
    enabled: rotating.enabled,
    rotatable: accounts.length > 1,
    activeAccount: rotating.activeAccount,
    accounts,
    restingCount: accounts.filter((account) => account.status === "resting").length,
  }
}

/**
 * The rotating wrapper only exists once a provider has several accounts, but the
 * dashboard still has to show whether rotation is on — otherwise turning it on
 * with a single account looks like nothing happened.
 */
export function rotationViewOrFallback(upstream: unknown, fallback: RotationFallback, usage: RotationUsageMap = {}, now = Date.now()): RotationView | undefined {
  const live = rotationView(upstream, usage, now)
  if (live) return live
  if (fallback.accounts.length === 0) return undefined

  const activeAccount = fallback.activeAccount ?? fallback.accounts[0]!
  return {
    enabled: fallback.enabled,
    rotatable: fallback.accounts.length > 1,
    activeAccount,
    accounts: fallback.accounts.map((key) => ({
      key,
      status: key === activeAccount ? "active" : "ready",
      detail: "",
      quota: quotaDetail(usage[key], now),
    })),
    restingCount: 0,
  }
}

export async function loadRotationUsage(upstream: unknown): Promise<RotationUsageMap> {
  const rotating = asRotatingUpstream(upstream)
  if (!rotating) return {}
  try {
    return await rotating.readAccountUsage()
  } catch {
    return {}
  }
}

/** Applies the toggle to the live upstream first so it takes effect without a restart. */
export async function setRotationEnabled(mode: ProviderMode, upstream: unknown, enabled: boolean) {
  asRotatingUpstream(upstream)?.setEnabled(enabled)
  await writeRotationConfig(mode, undefined, { enabled })
}

function restingDetail(cooldown: AccountCooldown, now: number) {
  const reset = cooldown.resetSource === "upstream"
    ? `resets ${clockTime(cooldown.until)}`
    : `retry in ${formatDuration(cooldown.until - now)}`
  return `${REASON_LABEL[cooldown.reason]} (${cooldown.status}) · ${reset}`
}

function quotaDetail(usage: unknown, now: number) {
  if (usage === undefined) return ""

  const used = parseQuotaUsedPercent(usage)
  const resetAt = parseQuotaResetAt(usage, now)
  const parts = [
    ...(used === undefined ? [] : [`${Math.round(used)}% used`]),
    ...(resetAt === undefined ? [] : [`resets ${clockTime(resetAt)}`]),
  ]
  return parts.join(" · ")
}

function clockTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function formatDuration(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}
