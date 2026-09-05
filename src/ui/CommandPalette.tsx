import { Box, Text } from 'ink'
import { COMMANDS, type Command } from './constants.js'

export type { Command }

interface Props {
  filter: string
  cursor: number
}

export function CommandPalette({ filter, cursor }: Props) {
  const filtered = COMMANDS.filter((c) => c.name.startsWith(filter))
  if (filtered.length === 0) return null

  const nameWidth = Math.max(...filtered.map((c) => c.name.length))

  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      {filtered.map((cmd, i) => {
        const active = i === cursor
        return (
          <Box key={cmd.name} gap={2}>
            <Text bold={active} color={active ? 'blue' : undefined} dimColor={!active}>
              {active ? '❯ ' : '  '}{cmd.name.padEnd(nameWidth)}
            </Text>
            <Text dimColor>{cmd.description}</Text>
          </Box>
        )
      })}
      <Box marginTop={0}>
        <Text dimColor>↑↓ navigate   tab/enter autocomplete   esc dismiss</Text>
      </Box>
    </Box>
  )
}

export function filteredCommands(filter: string): Command[] {
  return COMMANDS.filter((c) => c.name.startsWith(filter))
}
