import { Box, Text } from 'ink'
import type { Effort, ProviderType } from '../config.js'

interface Props {
  models: string[]
  cursor: number
  model: string | undefined
  host: string
  provider: string
  providerType?: ProviderType
  effort: Effort
  query: string
  /** true on the initial forced pick (no model yet) — hides "esc back". */
  requireSelection?: boolean
}

export function ModelsView({ models, cursor, model, host, provider, providerType, effort, query, requireSelection }: Props) {
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box flexDirection="column" marginBottom={1}>
        <Text wrap="truncate">
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
          query ? (
            <Text dimColor>{`no models match "${query}"`}</Text>
          ) : provider === 'lmstudio' ? (
            <Text dimColor>no models. load a model in LM Studio and start the server.</Text>
          ) : providerType === 'ollama' ? (
            <Box flexDirection="column">
              <Text dimColor>no models installed. pull one, then relaunch:</Text>
              <Text color="cyan">  ollama pull qwen2.5-coder:14b</Text>
            </Box>
          ) : (
            <Text dimColor>{`no models found at ${host}. make sure the server is running with a model loaded.`}</Text>
          )
        ) : (
          models.map((m, i) => {
            const sel = i === cursor
            return (
              <Text key={m} wrap="truncate" color={sel ? 'blue' : undefined} dimColor={!sel}>
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
