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
    const t = setInterval(() => setFrame((f) => (f + 1) % SPIN.length), 150)
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
