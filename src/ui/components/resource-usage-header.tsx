import React, { useEffect, useRef, useState } from "react"
import { Box, Text } from "ink"

import { formatResourceUsageHeader, readResourceUsage, type ResourceUsageSample, type ResourceUsageSnapshot } from "../resources"

const RESOURCE_REFRESH_INTERVAL_MS = 2000
const MIN_RULE_WIDTH = 6

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

  return <Text color="#8f817e" wrap="truncate-end"> | {formatResourceUsageHeader(usage)}</Text>
}

export function StatusHeader(props: { width: number; text: string; resourceWidth: number; intervalMs?: number; initialUsage?: ResourceUsageSnapshot }) {
  const initial = useRef(readResourceUsage())
  const sample = useRef<ResourceUsageSample>(initial.current.sample)
  const [usage, setUsage] = useState<ResourceUsageSnapshot>(() => props.initialUsage ?? initial.current.usage)
  const resourceText = props.resourceWidth > 0 ? ` | ${formatResourceUsageHeader(usage)}` : ""
  const resourceWidth = Math.min(resourceText.length, props.resourceWidth, Math.max(0, props.width - 12 - 2 - MIN_RULE_WIDTH))
  const textWidth = Math.max(12, Math.min(props.text.length, props.width - resourceWidth - 2 - MIN_RULE_WIDTH))
  const ruleWidth = Math.max(0, props.width - textWidth - resourceWidth - 2)
  const leftRuleWidth = Math.floor(ruleWidth / 2)
  const rightRuleWidth = ruleWidth - leftRuleWidth

  useEffect(() => {
    const timer = setInterval(() => {
      const next = readResourceUsage(sample.current)
      sample.current = next.sample
      setUsage(next.usage)
    }, props.intervalMs ?? RESOURCE_REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [props.intervalMs])

  return (
    <Box width={props.width}>
      <Text color="#d97757">{"─".repeat(leftRuleWidth)}</Text>
      <Text> </Text>
      <Box width={textWidth}>
        <Text color="#aab3cf" wrap="truncate-end">{props.text}</Text>
      </Box>
      {resourceWidth > 0 && (
        <Box width={resourceWidth}>
          <Text color="#8f817e" wrap="truncate-end">{resourceText}</Text>
        </Box>
      )}
      <Text> </Text>
      <Text color="#d97757">{"─".repeat(rightRuleWidth)}</Text>
    </Box>
  )
}
