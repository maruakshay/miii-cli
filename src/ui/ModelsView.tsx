import { Box, Text } from 'ink'
import type { Effort, ProviderType } from '../config.js'
import { C } from './theme.js'
import { paletteWindow } from './CommandPalette.js'

interface Props {
  models: string[]
  cursor: number
  model: string | undefined
  host: string
  provider: string
  providerType?: ProviderType
  effort: Effort
  query: string
  /** false when the provider has no /models endpoint — the list is only a suggestion. */
  listed?: boolean
  /** true on the initial forced pick (no model yet) — hides "esc back". */
  requireSelection?: boolean
  /** Most model rows to draw; the list scrolls with the cursor past that. */
  maxRows?: number
}

export function ModelsView({ models, cursor, model, host, provider, providerType, effort, query, listed = true, requireSelection, maxRows = Infinity }: Props) {
  const { start, end } = paletteWindow(models.length, cursor, maxRows)
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box flexDirection="column" marginBottom={1}>
        <Text wrap="truncate">
          <Text dimColor>provider </Text><Text color={C.cyan}>{provider}</Text>
          <Text dimColor>{'   '}host </Text><Text>{host}</Text>
        </Text>
        <Text>
          <Text dimColor>effort   </Text><Text>{effort}</Text><Text dimColor>  (← →)</Text>
        </Text>
      </Box>

      <Text dimColor>{listed ? 'select model' : 'select model — this provider doesn\'t list its models, so type any name'}</Text>
      <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={C.gray} paddingX={1}>
        {models.length === 0 ? (
          query ? (
            <Text dimColor>{`no models match "${query}" — enter to use it anyway`}</Text>
          ) : !listed ? (
            <Text dimColor>type a model name and press enter.</Text>
          ) : provider === 'lmstudio' ? (
            <Text dimColor>no models. load a model in LM Studio and start the server.</Text>
          ) : providerType === 'ollama' ? (
            <Box flexDirection="column">
              <Text dimColor>no models installed. pull one, then relaunch:</Text>
              <Text color={C.cyan}>  ollama pull qwen2.5-coder:14b</Text>
            </Box>
          ) : (
            <Text dimColor>{`no models found at ${host}. make sure the server is running with a model loaded, or type a model name and press enter.`}</Text>
          )
        ) : (
          models.slice(start, end).map((m, j) => {
            const sel = start + j === cursor
            return (
              <Text key={m} wrap="truncate" color={sel ? C.blue : undefined} dimColor={!sel}>
                {sel ? '❯ ' : '  '}{m}
                {m === model ? <Text color={C.green}>{'  ●'}</Text> : null}
              </Text>
            )
          })
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {query ? <Text dimColor>{`filter: ${query}`}</Text> : null}
        <Text dimColor>
          {`↑↓ navigate   enter select   ←→ effort   tab provider   type to filter${requireSelection ? '   ctrl+c quit' : '   esc close'}`}
          {end - start < models.length ? `   ${start + 1}–${end} of ${models.length}` : ''}
        </Text>
      </Box>
    </Box>
  )
}
