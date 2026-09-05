import { Box, Text } from 'ink'
import { COMMANDS, type Command } from './constants.js'
import { customCommands } from '../commands/custom.js'

export type { Command }

interface Props {
  filter: string
  cursor: number
}

/**
 * Everything `/` can complete to: the built-ins, then whatever Markdown files
 * the project and the user have dropped in .miii/commands. Built-ins come first
 * and a custom command may not shadow one — a repo that defines `/clear` should
 * not be able to redefine what clearing the screen does.
 */
export function allCommands(): Command[] {
  const builtin: Command[] = COMMANDS.map((c) => ({ ...c, origin: 'builtin' as const }))
  const taken = new Set(builtin.map((c) => c.name))
  const custom: Command[] = customCommands()
    .filter((c) => !taken.has(c.name))
    .map((c) => ({ name: c.name, description: c.description, origin: c.scope }))
  return [...builtin, ...custom]
}

/**
 * Commands whose name starts with what has been typed.
 *
 * Matched against the whole line, not just its first word: once you type a
 * space the line has arguments and the palette should get out of the way, the
 * same as it already does for `/copy last`. Resolving `/review src/a.ts` back
 * to `/review` is the submit path's job, not the palette's — doing it here
 * would leave the list open over your arguments and let tab overwrite them.
 */
export function filteredCommands(filter: string): Command[] {
  return allCommands().filter((c) => c.name.startsWith(filter))
}

export function CommandPalette({ filter, cursor }: Props) {
  const filtered = filteredCommands(filter)
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
            {cmd.origin && cmd.origin !== 'builtin' && (
              <Text color="cyan" dimColor>{cmd.origin}</Text>
            )}
          </Box>
        )
      })}
      <Box marginTop={0}>
        <Text dimColor>↑↓ navigate   tab/enter autocomplete   esc dismiss</Text>
      </Box>
    </Box>
  )
}
