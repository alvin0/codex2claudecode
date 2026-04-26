import { describe, expect, test } from "bun:test"

import { cpuUsagePercent, formatCpuPercent, formatMemoryBytes, formatResourceUsageHeader, type ResourceUsageSample } from "../src/ui/resources"

describe("UI resource usage", () => {
  test("computes process CPU percent from cpuUsage deltas", () => {
    const previous: ResourceUsageSample = { atMs: 1_000, cpu: { user: 10_000, system: 5_000 } }
    const current: ResourceUsageSample = { atMs: 3_000, cpu: { user: 210_000, system: 105_000 } }

    expect(cpuUsagePercent(previous, current)).toBe(15)
  })

  test("formats CPU and memory values for dashboard display", () => {
    expect(formatCpuPercent(2.345)).toBe("2.3%")
    expect(formatCpuPercent(120.4)).toBe("120%")
    expect(formatMemoryBytes(512)).toBe("512 B")
    expect(formatMemoryBytes(1024 * 1024 * 128)).toBe("128 MB")
    expect(formatMemoryBytes(1024 * 1024 * 1.5)).toBe("1.50 MB")
    expect(formatResourceUsageHeader({ cpuPercent: 2.345, rssBytes: 1024 * 1024 * 128, heapUsedBytes: 1024 * 1024 * 24 })).toBe("CPU 2.3% RAM 128 MB (24.0 MB Heap)")
  })
})
