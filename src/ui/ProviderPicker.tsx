import { Box, Text } from 'ink'
import { apiKeyFor } from '../config.js'
import type { NamedProvider } from '../config.js'
import { PRESETS } from '../llm/presets.js'

interface Props {
  entries: NamedProvider[]
  cursor: number
  activeName: string
  query: string
}

export function ProviderPicker({ entries, cursor, activeName, query }: Props) {
  // Presets the user hasn't configured yet. Listing them here is the whole
  // discovery story for `/provider add`: the names aren't guessable, and
  // sending people to `miii provider list --all` in another shell to find one
  // defeats the point of the picker. Filters alongside the configured rows so
  // typing narrows both halves at once.
  const configured = new Set(entries.map((e) => e.name))
  const q = query.toLowerCase()
  const addable = Object.entries(PRESETS)
    .filter(([name]) => !configured.has(name))
    .filter(([name]) => !q || name.includes(q))

  const nameWidth = Math.max(8, ...entries.map((e) => e.name.length), ...addable.map(([n]) => n.length))
  // Pad the label so the env-var column lines up under itself; the labels vary
  // by ~14 characters, which reads as ragged without this.
  const labelWidth = Math.max(0, ...addable.map(([, p]) => p.label.length))

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text dimColor>select provider</Text>
      <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        {entries.length === 0 ? (
          <Text dimColor>no providers configured — try /provider add ollama</Text>
        ) : (
          entries.map((e, i) => {
            const sel = i === cursor
            return (
              <Text key={e.name} color={sel ? 'blue' : undefined} dimColor={!sel}>
                {sel ? '❯ ' : '  '}
                {e.name.padEnd(nameWidth)}
                <Text dimColor>{'  '}{e.kind.padEnd(5)}</Text>
                <Text dimColor>{'  '}{e.entry.baseUrl}</Text>
                {/* A remote provider with no key resolves to nothing at request
                    time; flag it here rather than at the first failed turn. */}
                {e.kind === 'api' && !apiKeyFor(e.entry) ? (
                  <Text color="yellow">{'  no key'}</Text>
                ) : null}
                {e.name === activeName ? <Text color="green">{'  ●'}</Text> : null}
              </Text>
            )
          })
        )}

        {addable.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>{'  '}available — /provider add &lt;name&gt; [apiKey]</Text>
            {addable.map(([name, p]) => (
              <Text key={name} dimColor>
                {'  '}
                {name.padEnd(nameWidth)}
                <Text dimColor>{'  '}{(p.type === 'ollama' ? 'local' : p.apiKeyEnv ? 'api' : 'local').padEnd(5)}</Text>
                <Text dimColor>{'  '}{p.apiKeyEnv ? p.label.padEnd(labelWidth) : p.label}</Text>
                {/* Naming the env var is the actionable half: with it already
                    exported, `add <name>` is the entire setup. */}
                {p.apiKeyEnv ? <Text dimColor>{'  '}${p.apiKeyEnv}</Text> : null}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {query ? <Text dimColor>{`filter: ${query}`}</Text> : null}
        <Text dimColor>↑↓ navigate   enter select   type to filter   esc back</Text>
      </Box>
    </Box>
  )
}
