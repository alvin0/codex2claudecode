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
