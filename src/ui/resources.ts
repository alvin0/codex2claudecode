export interface ResourceUsageSnapshot {
  cpuPercent: number
  rssBytes: number
  heapUsedBytes: number
}

export interface ResourceUsageSample {
  atMs: number
  cpu: ReturnType<typeof process.cpuUsage>
}

export function readResourceUsage(previous?: ResourceUsageSample): { sample: ResourceUsageSample; usage: ResourceUsageSnapshot } {
  const sample = { atMs: Date.now(), cpu: process.cpuUsage() }
  const memory = process.memoryUsage()
  return {
    sample,
    usage: {
      cpuPercent: previous ? cpuUsagePercent(previous, sample) : 0,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    },
  }
}

export function cpuUsagePercent(previous: ResourceUsageSample, current: ResourceUsageSample) {
  const elapsedMicros = Math.max(1, (current.atMs - previous.atMs) * 1000)
  const usedMicros = Math.max(0, current.cpu.user - previous.cpu.user) + Math.max(0, current.cpu.system - previous.cpu.system)
  return (usedMicros / elapsedMicros) * 100
}

export function formatCpuPercent(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0.0%"
  if (value >= 100) return `${Math.round(value)}%`
  return `${value.toFixed(1)}%`
}

export function formatMemoryBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  if (unit === 0) return `${Math.round(value)} ${units[unit]}`
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

export function formatResourceUsageHeader(usage: ResourceUsageSnapshot) {
  return `CPU ${formatCpuPercent(usage.cpuPercent)} · RAM ${formatMemoryBytes(usage.rssBytes)} RSS · Heap ${formatMemoryBytes(usage.heapUsedBytes)}`
}
