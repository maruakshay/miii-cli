import { memo, useEffect, useState } from 'react'
import { Box, Text } from 'ink'

interface Props {
  input: string
  disabled?: boolean
  processingLabel?: string
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export const InputBar = memo(function InputBar({ input, disabled, processingLabel }: Props) {
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
          <Text>{input}</Text>
          <Text dimColor>▌</Text>
        </>
      )}
    </Box>
  )
})
