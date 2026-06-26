import { Box, Text } from 'ink'
import type { Effort } from '../config.js'

interface Props {
  model: string | undefined
  activeCtx: number | null
  effort: Effort
  cwd: string
  error?: string | null
  updateAvailable?: string | null
}

export function WelcomeBlock({ model, activeCtx, effort, cwd, updateAvailable }: Props) {
  const ctxLabel = activeCtx != null ? `${Math.round(activeCtx / 1024)}k ctx` : '— ctx'
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={2}
      >
        <Box gap={2}>
          <Text bold color="blue">MIII CLI</Text>
          <Text dimColor>·</Text>
          <Text>{model ?? '/models'}</Text>
          <Text dimColor>·</Text>
          <Text>{ctxLabel}</Text>
          <Text dimColor>·</Text>
          <Text>{effort} effort</Text>
        </Box>
        <Text dimColor>{cwd}</Text>
      </Box>
      {updateAvailable && (
        <Text color="yellow">{`↑ update available: v${updateAvailable} — run: miii --update`}</Text>
      )}
    </Box>
  )
}
