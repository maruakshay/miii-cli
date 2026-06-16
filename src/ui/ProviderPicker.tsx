import { Box, Text } from 'ink'
import type { NamedProvider } from '../config.js'

interface Props {
  entries: NamedProvider[]
  cursor: number
  activeName: string
  query: string
}

export function ProviderPicker({ entries, cursor, activeName, query }: Props) {
  const nameWidth = Math.max(8, ...entries.map((e) => e.name.length))
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text dimColor>select provider</Text>
      <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        {entries.length === 0 ? (
          <Text dimColor>no providers configured — add one in ~/.miii/config.json</Text>
        ) : (
          entries.map((e, i) => {
            const sel = i === cursor
            return (
              <Text key={e.name} color={sel ? 'blue' : undefined} dimColor={!sel}>
                {sel ? '❯ ' : '  '}
                {e.name.padEnd(nameWidth)}
                <Text dimColor>{'  '}{e.kind.padEnd(5)}</Text>
                <Text dimColor>{'  '}{e.entry.baseUrl}</Text>
                {e.name === activeName ? <Text color="green">{'  ●'}</Text> : null}
              </Text>
            )
          })
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {query ? <Text dimColor>{`filter: ${query}`}</Text> : null}
        <Text dimColor>↑↓ navigate   enter select   type to filter   esc back</Text>
      </Box>
    </Box>
  )
}
