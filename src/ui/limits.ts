import type { AccountInfo } from "../upstream/codex/account-info"

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

// ── Kiro usage limits ──

export interface KiroUsageLimitsView {
  tier?: string
  email?: string
  limitGroups: LimitGroupView[]
}

/**
 * Convert the response from Kiro's /getUsageLimits API into a view model.
 *
 * Example response shape:
 * ```json
 * {
 *   "daysUntilReset": 0,
 *   "nextDateReset": 1777593600,
 *   "subscriptionInfo": { "subscriptionTitle": "KIRO POWER", "type": "Q_DEVELOPER_STANDALONE_POWER", ... },
 *   "usageBreakdownList": [{
 *     "displayName": "Credit", "displayNamePlural": "Credits",
 *     "currentUsage": 3733, "currentUsageWithPrecision": 3733.89,
 *     "usageLimit": 10000, "usageLimitWithPrecision": 10000,
 *     "currentOverages": 0, "overageRate": 0.04,
 *     "nextDateReset": 1777593600, "resourceType": "CREDIT", ...
 *   }],
 *   "userInfo": { "email": "...", "userId": "..." }
 * }
 * ```
 */
export function kiroUsageLimitsToView(data: unknown): KiroUsageLimitsView {
  const item = unwrapKiroUsageLimits(data)
  if (!item) return { limitGroups: [] }

  const subInfo = item.subscriptionInfo as Record<string, unknown> | undefined
  const tier = typeof subInfo?.subscriptionTitle === "string" ? subInfo.subscriptionTitle : undefined
  const userInfo = item.userInfo as Record<string, unknown> | undefined
  const email = typeof userInfo?.email === "string" ? userInfo.email : undefined

  const breakdownList = creditUsageEntries(item)
  const rows: LimitRowView[] = []

  for (const entry of breakdownList) {
    if (!entry || typeof entry !== "object") continue
    const b = entry as Record<string, unknown>

    const displayName = typeof b.displayName === "string" ? b.displayName : "Credit"
    const displayNamePlural = typeof b.displayNamePlural === "string" ? b.displayNamePlural : `${displayName}s`
    const unit = displayNamePlural.toLowerCase()
    const label = `${displayName} limit:`
    const used = typeof b.currentUsageWithPrecision === "number" ? b.currentUsageWithPrecision : typeof b.currentUsage === "number" ? b.currentUsage : 0
    const limit = typeof b.usageLimitWithPrecision === "number" ? b.usageLimitWithPrecision : typeof b.usageLimit === "number" ? b.usageLimit : 0
    const remaining = Math.max(0, limit - used)
    const usedPercent = limit > 0 ? Math.max(0, Math.min(100, Math.round((used / limit) * 100))) : 0

    const resetEpoch = typeof b.nextDateReset === "number" ? b.nextDateReset : typeof item.nextDateReset === "number" ? item.nextDateReset : undefined
    const resetLabel = resetEpoch ? `resets ${formatResetEpoch(resetEpoch)}` : "monthly"

    rows.push({
      label,
      used: usedPercent,
      left: limit > 0 ? `${formatNumber(remaining)} left` : `${formatNumber(used)} used`,
      reset: limit > 0 ? `${formatNumber(used)} / ${formatNumber(limit)} ${unit} · ${resetLabel}` : resetLabel,
    })

    const overages = typeof b.currentOveragesWithPrecision === "number" ? b.currentOveragesWithPrecision : typeof b.currentOverages === "number" ? b.currentOverages : 0
    const overageRate = typeof b.overageRate === "number" ? b.overageRate : 0
    if (overages > 0) {
      rows.push({ label: "Overage:", used: 0, left: `${formatNumber(overages)} credits`, reset: overageRate > 0 ? `$${overageRate}/credit` : "" })
    }
  }

  return { tier, email, limitGroups: rows.length ? [{ rows }] : [] }
}

function unwrapKiroUsageLimits(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object") return
  const item = data as Record<string, unknown>
  if (Array.isArray(item.usageBreakdownList) || item.subscriptionInfo || item.userInfo) return item

  const output = item.Output
  if (output && typeof output === "object") {
    const outputItem = output as Record<string, unknown>
    if (Array.isArray(outputItem.usageBreakdownList) || outputItem.subscriptionInfo || outputItem.userInfo) return outputItem
    if (typeof outputItem.message === "string") {
      try {
        const parsed = JSON.parse(outputItem.message) as unknown
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      } catch {
        return
      }
    }
  }
}

function creditUsageEntries(item: Record<string, unknown>) {
  const entries = Array.isArray(item.usageBreakdownList) ? item.usageBreakdownList : []
  const creditEntries = entries.filter((entry) => {
    if (!entry || typeof entry !== "object") return false
    const usage = entry as Record<string, unknown>
    return usage.resourceType === "CREDIT" || usage.displayName === "Credit" || usage.displayNamePlural === "Credits"
  })
  return creditEntries.length ? creditEntries : entries
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
}

function formatResetEpoch(epochSeconds: number) {
  const date = new Date(epochSeconds * 1000)
  if (Number.isNaN(date.getTime())) return "unknown"
  return `${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })} on ${date.getDate()} ${date.toLocaleString([], { month: "short" })}`
}
