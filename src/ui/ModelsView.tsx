import { Box, Text } from 'ink'
import type { Effort } from '../config.js'

interface Props {
  models: string[]
  cursor: number
  model: string | undefined
  host: string
  provider: string
  effort: Effort
  query: string
  /** true on the initial forced pick (no model yet) — hides "esc back". */
  requireSelection?: boolean
}

export function ModelsView({ models, cursor, model, host, provider, effort, query, requireSelection }: Props) {
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text dimColor>provider </Text><Text color="cyan">{provider}</Text>
          <Text dimColor>{'   '}host </Text><Text>{host}</Text>
        </Text>
        <Text>
          <Text dimColor>effort   </Text><Text>{effort}</Text><Text dimColor>  (← →)</Text>
        </Text>
      </Box>

      <Text dimColor>select model</Text>
      <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        {models.length === 0 ? (
          <Text dimColor>
            {query
              ? `no models match "${query}"`
              : provider === 'lmstudio'
                ? 'no models. load a model in LM Studio and start the server.'
                : 'no models found.'}
          </Text>
        ) : (
          models.map((m, i) => {
            const sel = i === cursor
            return (
              <Text key={m} color={sel ? 'blue' : undefined} dimColor={!sel}>
                {sel ? '❯ ' : '  '}{m}
                {m === model ? <Text color="green">{'  ●'}</Text> : null}
              </Text>
            )
          })
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {query ? <Text dimColor>{`filter: ${query}`}</Text> : null}
        <Text dimColor>
          {`↑↓ navigate   enter select   ←→ effort   tab provider   type to filter${requireSelection ? '   ctrl+c quit' : '   esc close'}`}
        </Text>
      </Box>
    </Box>
  )
}
