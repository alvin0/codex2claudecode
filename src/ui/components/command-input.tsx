import React from "react"
import { Box, Text, useStdout } from "ink"

import { filterCommands } from "../commands"

export function CommandInput(props: { value: string; message?: string; selected: number }) {
  const { stdout } = useStdout()
  const isCommand = props.value.startsWith("/")
  const commands = isCommand ? filterCommands(props.value) : []
  const commandWidth = Math.max(22, ...commands.map((command) => command.name.length + 4))
  const descriptionWidth = Math.max(20, (stdout.columns ?? 100) - commandWidth - 6)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="single" borderColor={isCommand ? "#aab3cf" : "gray"} paddingX={1}>
        <Text bold>{"> "}</Text>
        <Text>{props.value}</Text>
        <Text inverse> </Text>
      </Box>
      {isCommand && (
        <Box flexDirection="column" paddingX={1}>
          {commands.map((command) => (
            <Box key={command.name}>
              <Box width={commandWidth}>
                <Text color={commands[props.selected]?.name === command.name ? "#d97757" : "#aab3cf"}>
                  {commands[props.selected]?.name === command.name ? "› " : "  "}
                  {command.name}
                </Text>
              </Box>
              <Text color={commands[props.selected]?.name === command.name ? "white" : "gray"}>{truncate(command.description, descriptionWidth)}</Text>
            </Box>
          ))}
          {!commands.length && <Text color="gray">No matching commands</Text>}
        </Box>
      )}
      {props.message && !isCommand && <Text color="gray">{props.message}</Text>}
    </Box>
  )
}

function truncate(value: string, width: number) {
  return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value
}
