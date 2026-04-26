import React, { useEffect, useRef, useState } from "react"
import { Text } from "ink"

import { formatResourceUsageHeader, readResourceUsage, type ResourceUsageSample, type ResourceUsageSnapshot } from "../resources"

const RESOURCE_REFRESH_INTERVAL_MS = 2000

export function ResourceUsageHeader(props: { intervalMs?: number; initialUsage?: ResourceUsageSnapshot }) {
  const initial = useRef(readResourceUsage())
  const sample = useRef<ResourceUsageSample>(initial.current.sample)
  const [usage, setUsage] = useState<ResourceUsageSnapshot>(() => props.initialUsage ?? initial.current.usage)

  useEffect(() => {
    const timer = setInterval(() => {
      const next = readResourceUsage(sample.current)
      sample.current = next.sample
      setUsage(next.usage)
    }, props.intervalMs ?? RESOURCE_REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [props.intervalMs])

  return <Text color="#8f817e" wrap="truncate-end"> · {formatResourceUsageHeader(usage)}</Text>
}
