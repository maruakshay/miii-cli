import { Box, Text } from 'ink'

export interface Command {
  name: string
  description: string
}

export const COMMANDS: Command[] = [
  { name: '/models', description: 'switch model, adjust effort, or change provider' },
  { name: '/provider ollama', description: 'switch to Ollama backend' },
  { name: '/provider lmstudio', description: 'switch to LM Studio backend' },
  { name: '/new',    description: 'save current session and start fresh' },
  { name: '/sessions', description: 'list sessions and resume one' },
  { name: '/clear',  description: 'clear chat and reset context' },
  { name: '/exit',   description: 'quit miii' },
]

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
      borderStyle="round"
      borderColor="gray"
      marginX={1}
      marginBottom={0}
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
