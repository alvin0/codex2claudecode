import { expect, test } from "bun:test"

import { usageToView } from "../src/ui/limits"

test("maps usage responses into account info and limit rows", () => {
  const view = usageToView({
    email: "user@example.com",
    plan_type: "pro",
    account_id: "acct",
    rate_limit: {
      primary_window: { used_percent: 13, reset_at: 1776607101 },
      secondary_window: { used_percent: 47, reset_at: 1776931925 },
    },
    additional_rate_limits: [
      {
        limit_name: "GPT-5.3-Codex-Spark",
        rate_limit: {
          primary_window: { used_percent: 0, reset_at: 1776613057 },
          secondary_window: { used_percent: 100, reset_at: 1777199857 },
        },
      },
      null,
    ],
  })

  expect(view.accountInfo).toMatchObject({ email: "user@example.com", plan: "pro", accountId: "acct" })
  expect(view.limitGroups).toHaveLength(2)
  expect(view.limitGroups[0].rows[0]).toMatchObject({ label: "5h limit:", used: 13, left: "87% left" })
  expect(view.limitGroups[1].title).toBe("GPT-5.3-Codex-Spark limit:")
  expect(view.limitGroups[1].rows[1]).toMatchObject({ left: "0% left" })
})

test("handles missing or malformed usage data", () => {
  expect(usageToView(undefined)).toEqual({ limitGroups: [] })
  expect(usageToView({ rate_limit: {}, additional_rate_limits: [{ limit_name: 1 }] }).limitGroups).toEqual([])
})
