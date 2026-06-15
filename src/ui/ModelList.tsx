import { Box, Text } from 'ink'

interface Props {
  models: string[]
  cursor: number
  activeModel?: string
  showActive?: boolean
  provider?: string
}

export function ModelList({ models, cursor, activeModel, showActive, provider }: Props) {
  if (models.length === 0) {
    const hint = provider === 'lmstudio'
      ? 'no models found. load a model in LM Studio and ensure the server is running.'
      : 'no models found. run: ollama pull {model}'
    return <Text dimColor>{hint}</Text>
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {models.map((m, i) => (
        <Text key={m} color={i === cursor ? 'blue' : undefined} dimColor={i !== cursor}>
          {i === cursor ? '❯ ' : '  '}{m}
          {showActive && m === activeModel ? <Text dimColor>  (active)</Text> : null}
        </Text>
      ))}
    </Box>
  )
}
