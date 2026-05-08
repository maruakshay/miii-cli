import React from 'react'
import { Box, Text } from 'ink'
import type { Status } from '../../types.js'

const DOTS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

interface Props {
  model: string
  provider: string
  status: Status
  tick: number
}

export function StatusBar({ model, provider, status, tick }: Props) {
  const isIdle = status === 'idle'
  const spinner = DOTS[tick % DOTS.length]

  const statusNode =
    status === 'idle' ? <Text color="green">● <Text color="gray">ready</Text></Text>
    : status === 'thinking' ? <Text color="yellow">{spinner} <Text color="gray">thinking</Text></Text>
    : <Text color="yellow">{spinner} <Text color="gray">tool</Text></Text>

  return (
    <Box>
      <Box flexGrow={1} paddingX={1} paddingY={0} justifyContent="space-between">
        <Text bold color="cyan">MIII</Text>
        <Text color="gray" dimColor>{provider}/{model}</Text>
        {statusNode}
      </Box>
    </Box>
  )
}

export function Divider({ cols }: { cols: number }) {
  return <Text color="gray" dimColor>{'─'.repeat(Math.max(cols, 10))}</Text>
}
