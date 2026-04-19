import React from "react"
import { Box, Text } from "ink"

export function CommandOutput(props: { title: string; output: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#aab3cf">────────────────────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1}>
        <Text bold color="#c7d2fe">{props.title}</Text>
      </Box>
      {props.output.split("\n").map((line, index) => (
        <Text key={`${line}-${index}`} color="#aab3cf">{line}</Text>
      ))}
    </Box>
  )
}
