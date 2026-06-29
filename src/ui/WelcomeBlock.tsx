import { Box, Text } from 'ink'
import type { Effort } from '../config.js'

// Lifecycle of the background self-update for the launch banner.
//   idle        — a newer release exists; auto-update off, on cooldown, or failed to start
//   downloading — install kicked off in the background
//   installed   — background install finished; applies on next launch
//   failed      — background install exited non-zero
export type UpdateStatus = 'idle' | 'downloading' | 'installed' | 'failed'

// Single source of truth for the update banner copy, shared by the welcome
// header and the in-chat banner so they never drift.
export function updateBannerText(version: string, status: UpdateStatus): string {
  switch (status) {
    case 'downloading':
      return `↑ v${version} downloading in the background — restart miii to apply`
    case 'installed':
      return `✓ v${version} installed — restart miii to apply`
    case 'failed':
      return `↑ v${version} update failed — run \`miii update\` manually`
    default:
      return `↑ v${version} available — run \`miii update\` to upgrade`
  }
}

interface Props {
  model: string | undefined
  activeCtx: number | null
  effort: Effort
  cwd: string
  error?: string | null
  updateAvailable?: string | null
  updateStatus?: UpdateStatus
}

export function WelcomeBlock({ model, activeCtx, effort, cwd, updateAvailable, updateStatus = 'idle' }: Props) {
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
        <Text color={updateStatus === 'failed' ? 'red' : updateStatus === 'installed' ? 'green' : 'yellow'}>
          {updateBannerText(updateAvailable, updateStatus)}
        </Text>
      )}
    </Box>
  )
}
