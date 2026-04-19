import React from "react"
import { Box, Text } from "ink"

import { filterCommands } from "../commands"

export function CommandInput(props: { value: string; message?: string; selected: number }) {
  const isCommand = props.value.startsWith("/")
  const commands = isCommand ? filterCommands(props.value) : []

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
              <Box width={18}>
                <Text color={commands[props.selected]?.name === command.name ? "#d97757" : "#aab3cf"}>
                  {commands[props.selected]?.name === command.name ? "› " : "  "}
                  {command.name}
                </Text>
              </Box>
              <Text color={commands[props.selected]?.name === command.name ? "white" : "gray"}>{command.description}</Text>
            </Box>
          ))}
          {!commands.length && <Text color="gray">No matching commands</Text>}
        </Box>
      )}
      {props.message && !isCommand && <Text color="gray">{props.message}</Text>}
    </Box>
  )
}
