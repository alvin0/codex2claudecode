/**
 * Account rotation policy: which upstream failures mean "try another account",
 * how long the failed account rests, and how to read a real reset time or an
 * unexpected quota refill out of a provider's usage payload.
 */

export type RotationReason = "auth" | "quota" | "server"

export interface AccountCooldown {
  account: string
  reason: RotationReason
  status: number
  since: number
  until: number
  /** `upstream` when the reset time came from the provider, `default` when it was estimated. */
  resetSource: "upstream" | "default"
  detail?: string
  lastProbeAt?: number
}

export type AccountCooldownMap = Record<string, AccountCooldown>

export const DEFAULT_COOLDOWN_MS: Record<RotationReason, number> = {
  auth: 30 * 60_000,
  quota: 15 * 60_000,
  server: 60_000,
}

/** How often a quota-blocked account is re-probed in case the provider reset early. */
export const QUOTA_PROBE_INTERVAL_MS = 5 * 60_000

const QUOTA_TEXT = /usage limit|quota|rate.?limit|too many requests|insufficient_quota/i

export function rotationReason(status: number, body?: string): RotationReason | undefined {
  if (status === 402 || status === 429) return "quota"
  if (status === 401 || status === 403) return body && QUOTA_TEXT.test(body) ? "quota" : "auth"
  if (status >= 500) return "server"
  return undefined
}

export function cooldownUntil(reason: RotationReason, now: number, resetAt?: number) {
  if (resetAt && resetAt > now) return { until: resetAt, resetSource: "upstream" as const }
  return { until: now + cooldownMs(reason), resetSource: "default" as const }
}

export function cooldownMs(reason: RotationReason) {
  const override = Number(process.env.ACCOUNT_ROTATION_COOLDOWN_MINUTES)
  if (reason === "quota" && Number.isFinite(override) && override > 0) return override * 60_000
  return DEFAULT_COOLDOWN_MS[reason]
}

export function isCoolingDown(cooldown: AccountCooldown | undefined, now: number) {
  return Boolean(cooldown && cooldown.until > now)
}

/**
 * Earliest future reset timestamp anywhere in a usage payload. Providers spell it
 * differently (`reset_at` seconds, `reset_after_seconds`, ISO `quota_reset_date`),
 * so the whole payload is scanned instead of branching per provider.
 */
export function parseQuotaResetAt(usage: unknown, now = Date.now()): number | undefined {
  let earliest: number | undefined

  walk(usage, (key, value) => {
    const resetAt = resetTimestamp(key, value, now)
    if (resetAt === undefined || resetAt <= now) return
    if (earliest === undefined || resetAt < earliest) earliest = resetAt
  })

  return earliest
}

/**
 * Whether a usage payload says the account can serve requests again.
 * `undefined` means the payload did not say either way.
 */
export function parseQuotaAvailable(usage: unknown): boolean | undefined {
  let blocked = false
  let allowed = false

  walk(usage, (key, value) => {
    if (key === "limit_reached" && value === true) blocked = true
    if (key === "limit_reached" && value === false) allowed = true
    if (key === "allowed" && value === false) blocked = true
    if (key === "allowed" && value === true) allowed = true
    if (key === "used_percent" && typeof value === "number" && value >= 100) blocked = true
    if (key === "remaining" && typeof value === "number" && value > 0) allowed = true
  })

  if (blocked) return false
  return allowed ? true : undefined
}

/** Highest used percentage anywhere in a usage payload, for a one-line quota readout. */
export function parseQuotaUsedPercent(usage: unknown): number | undefined {
  let highest: number | undefined

  walk(usage, (key, value) => {
    if (key !== "used_percent" && key !== "percent_used") return
    if (typeof value !== "number" || !Number.isFinite(value)) return
    if (highest === undefined || value > highest) highest = value
  })

  return highest
}

function resetTimestamp(key: string, value: unknown, now: number) {
  if (typeof value === "number") {
    if (key === "reset_after_seconds" || key === "resets_in_seconds") return now + value * 1000
    if (key.includes("reset")) return value > 1e11 ? value : value * 1000
    return
  }

  if (typeof value === "string" && key.includes("reset")) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }

  return
}

function walk(value: unknown, visit: (key: string, value: unknown) => void, depth = 0) {
  if (depth > 8 || !value || typeof value !== "object") return

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    visit(key, child)
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit, depth + 1)
    } else {
      walk(child, visit, depth + 1)
    }
  }
}
