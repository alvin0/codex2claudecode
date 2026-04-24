import React from "react"
import { Box, Text, useStdout } from "ink"

import { UI_COMMANDS } from "../commands"

export function CommandInput(props: { selected: number; message?: string }) {
  const { stdout } = useStdout()
  const commands = UI_COMMANDS
  const commandWidth = Math.max(22, ...commands.map((command) => command.name.length + 4))
  const descriptionWidth = Math.max(20, (stdout.columns ?? 100) - commandWidth - 6)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column" paddingX={1}>
        {commands.map((command, index) => (
          <Box key={command.name}>
            <Box width={commandWidth}>
              <Text color={props.selected === index ? "#d97757" : "#aab3cf"}>
                {props.selected === index ? "› " : "  "}
                {command.name}
              </Text>
            </Box>
            <Text color={props.selected === index ? "white" : "gray"}>{truncate(command.description, descriptionWidth)}</Text>
          </Box>
        ))}
      </Box>
      {props.message && <Text color="gray">{props.message}</Text>}
    </Box>
  )
}

function truncate(value: string, width: number) {
  return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value
}
