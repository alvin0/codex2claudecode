import type { AccountInfo } from "../account-info"

export interface LimitRowView {
  label: string
  used: number
  left: string
  reset: string
}

export interface LimitGroupView {
  title?: string
  rows: LimitRowView[]
}

export interface UsageView {
  accountInfo?: Partial<AccountInfo>
  limitGroups: LimitGroupView[]
}

export function usageToView(usage: unknown): UsageView {
  if (!usage || typeof usage !== "object") return { limitGroups: [] }
  const item = usage as {
    email?: unknown
    plan_type?: unknown
    account_id?: unknown
    rate_limit?: unknown
    additional_rate_limits?: unknown
  }
  return {
    accountInfo: {
      ...(typeof item.email === "string" && { email: item.email }),
      ...(typeof item.plan_type === "string" && { plan: item.plan_type }),
      ...(typeof item.account_id === "string" && { accountId: item.account_id }),
      updatedAt: new Date().toISOString(),
    },
    limitGroups: [
      { rows: rateLimitRows(item.rate_limit) },
      ...(Array.isArray(item.additional_rate_limits)
        ? item.additional_rate_limits.flatMap((limit) => {
            if (!limit || typeof limit !== "object") return []
            const extra = limit as { limit_name?: unknown; rate_limit?: unknown }
            return [{ title: typeof extra.limit_name === "string" ? `${extra.limit_name} limit:` : "Additional limit:", rows: rateLimitRows(extra.rate_limit) }]
          })
        : []),
    ].filter((group) => group.rows.length > 0),
  }
}

/**
 * Parse Kiro getUsageLimits API response into the shared UsageView format.
 *
 * Actual Kiro response shape:
 * {
 *   "subscriptionInfo": { "subscriptionTitle": "KIRO POWER", ... },
 *   "userInfo": { "email": "...", "userId": "..." },
 *   "usageBreakdownList": [
 *     { "displayName": "Credit", "currentUsage": 3733, "usageLimit": 10000,
 *       "nextDateReset": 1777593600, "resourceType": "CREDIT", ... }
 *   ],
 *   "nextDateReset": 1777593600,
 *   ...
 * }
 */
export function kiroUsageToView(data: unknown): UsageView {
  if (!data || typeof data !== "object") return { limitGroups: [] }
  const item = data as Record<string, unknown>

  const accountInfo: Partial<AccountInfo> = { updatedAt: new Date().toISOString() }

  // Extract user info
  const userInfo = item.userInfo as Record<string, unknown> | undefined
  if (userInfo && typeof userInfo === "object") {
    if (typeof userInfo.email === "string") accountInfo.email = userInfo.email
  }

  // Extract subscription info
  const subInfo = item.subscriptionInfo as Record<string, unknown> | undefined
  if (subInfo && typeof subInfo === "object") {
    if (typeof subInfo.subscriptionTitle === "string") accountInfo.plan = subInfo.subscriptionTitle
  }

  const groups: LimitGroupView[] = []

  // Parse usageBreakdownList (primary Kiro format)
  const breakdownList = item.usageBreakdownList
  if (Array.isArray(breakdownList)) {
    const rows: LimitRowView[] = []
    for (const entry of breakdownList) {
      if (!entry || typeof entry !== "object") continue
      const row = kiroBreakdownToRow(entry as Record<string, unknown>)
      if (row) rows.push(row)
    }
    if (rows.length) groups.push({ rows })
  }

  // Fallback: try legacy array-based fields
  if (!groups.length) {
    const usageLimits = item.usageLimits ?? item.usage_limits ?? item.limits
    if (Array.isArray(usageLimits)) {
      const rows: LimitRowView[] = []
      for (const entry of usageLimits) {
        if (!entry || typeof entry !== "object") continue
        const row = kiroLegacyLimitToRow(entry as Record<string, unknown>)
        if (row) rows.push(row)
      }
      if (rows.length) groups.push({ rows })
    }
  }

  return { accountInfo, limitGroups: groups }
}

function kiroBreakdownToRow(entry: Record<string, unknown>): LimitRowView | undefined {
  const currentUsage = typeof entry.currentUsageWithPrecision === "number" ? entry.currentUsageWithPrecision : typeof entry.currentUsage === "number" ? entry.currentUsage : undefined
  const usageLimit = typeof entry.usageLimitWithPrecision === "number" ? entry.usageLimitWithPrecision : typeof entry.usageLimit === "number" ? entry.usageLimit : undefined

  if (currentUsage === undefined && usageLimit === undefined) return undefined

  const used = currentUsage ?? 0
  const limit = usageLimit ?? 0
  const remaining = Math.max(0, limit - used)
  const usedPercent = limit > 0 ? Math.round(used / limit * 100) : 0

  const label = typeof entry.displayName === "string"
    ? entry.displayName
    : typeof entry.resourceType === "string"
      ? String(entry.resourceType).toLowerCase().replace(/_/g, " ")
      : "usage"

  const left = limit > 0
    ? `used ${formatNum(used)} · left ${formatNum(remaining)} / ${formatNum(limit)}`
    : `${formatNum(used)} used`

  const resetEpoch = typeof entry.nextDateReset === "number" ? entry.nextDateReset : undefined
  const reset = resetEpoch ? `resets ${formatReset(resetEpoch)}` : "reset unknown"

  return { label, used: usedPercent, left, reset }
}

function formatNum(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function kiroLegacyLimitToRow(entry: Record<string, unknown>): LimitRowView | undefined {
  const used = typeof entry.used === "number" ? entry.used : undefined
  const limit = typeof entry.limit === "number" ? entry.limit : undefined

  if (used === undefined && limit === undefined) return undefined

  const usedPercent = limit && limit > 0 ? Math.round((used ?? 0) / limit * 100) : 0
  const remaining = Math.max(0, (limit ?? 0) - (used ?? 0))
  const left = limit !== undefined ? `${remaining}/${limit} (${Math.max(0, 100 - usedPercent)}% left)` : `${used ?? 0} used`

  const resetAt = entry.resetAt ?? entry.reset_at ?? entry.resetDate ?? entry.nextDateReset
  let reset = "reset unknown"
  if (typeof resetAt === "number") reset = `resets ${formatReset(resetAt)}`
  else if (typeof resetAt === "string") {
    try {
      const date = new Date(resetAt)
      if (!Number.isNaN(date.getTime())) reset = `resets ${formatReset(Math.floor(date.getTime() / 1000))}`
    } catch { /* ignore */ }
  }

  const label = typeof entry.limitType === "string"
    ? String(entry.limitType).toLowerCase().replace(/_/g, " ")
    : typeof entry.label === "string" ? entry.label : "usage"

  return { label, used: usedPercent, left, reset }
}

function rateLimitRows(rateLimit: unknown): LimitRowView[] {
  if (!rateLimit || typeof rateLimit !== "object") return []
  const item = rateLimit as { primary_window?: unknown; secondary_window?: unknown }
  return [
    windowRow("5h limit:", item.primary_window),
    windowRow("Weekly limit:", item.secondary_window),
  ].filter((row) => row !== undefined)
}

function windowRow(label: string, window: unknown) {
  if (!window || typeof window !== "object") return
  const item = window as { used_percent?: unknown; reset_at?: unknown }
  const used = typeof item.used_percent === "number" ? item.used_percent : 0
  return {
    label,
    used,
    left: `${Math.max(0, 100 - Math.round(used))}% left`,
    reset: typeof item.reset_at === "number" ? `resets ${formatReset(item.reset_at)}` : "reset unknown",
  }
}

function formatReset(resetAtSeconds: number) {
  const date = new Date(resetAtSeconds * 1000)
  return `${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })} on ${date.getDate()} ${date.toLocaleString([], { month: "short" })}`
}
