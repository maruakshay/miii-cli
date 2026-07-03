import { memo, useEffect, useState } from 'react'
import { Box, Text } from 'ink'

interface Props {
  input: string
  caret?: number
  disabled?: boolean
  processingLabel?: string
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export const InputBar = memo(function InputBar({ input, caret, disabled, processingLabel }: Props) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!disabled) return
    // 200ms is a clean 2× of the 100ms stream flush (useAgentRunner FLUSH_MS):
    // the two timers phase-lock instead of beating, so the live frame repaints
    // on a steady cadence rather than at drifting 100/150ms intervals — the
    // extra unsynced repaints were a visible flicker source.
    const t = setInterval(() => setFrame((f) => (f + 1) % SPIN.length), 200)
    return () => clearInterval(t)
  }, [disabled])

  return (
    <Box
      borderStyle="single"
      borderTop={true}
      borderBottom={true}
      borderLeft={false}
      borderRight={false}
      borderColor={disabled ? 'yellow' : 'white dim'}
      paddingX={1}
    >
      {disabled ? (
        <>
          <Text color="yellow">{SPIN[frame] + ' '}</Text>
          <Text dimColor italic>{processingLabel ?? 'processing…'}</Text>
          <Text dimColor>  (esc to cancel)</Text>
        </>
      ) : (
        <>
          <Text dimColor>{'> '}</Text>
          {(() => {
            const pos = Math.max(0, Math.min(caret ?? input.length, input.length))
            const before = input.slice(0, pos)
            const at = input.slice(pos, pos + 1) || ' '
            const after = input.slice(pos + 1)
            return (
              <>
                <Text>{before}</Text>
                <Text inverse>{at}</Text>
                <Text>{after}</Text>
              </>
            )
          })()}
        </>
      )}
    </Box>
  )
})
