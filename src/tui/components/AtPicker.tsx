import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import type { FileEntry } from '../../files/ops.js'

interface Props {
  files: FileEntry[]
  query: string
  idx: number
}

export function AtPicker({ files, query, idx }: Props) {
  const filtered = useMemo(() => {
    if (!query) return files.slice(0, 8)
    return files.filter(f => f.rel.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
  }, [files, query])

  if (!filtered.length) {
    return (
      <Box borderStyle="round" borderColor="gray" marginX={1} paddingX={1}>
        <Text color="gray">no files match "{query}"</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" marginX={1}>
      {filtered.map((f, i) => {
        const active = i === idx
        const icon = f.type === 'dir' ? '/' : ' '
        return (
          <Box key={f.path} paddingX={1}>
            <Text color={active ? 'cyan' : 'white'} bold={active}>
              {active ? '▶' : ' '}
              {icon}
            </Text>
            <Text color={active ? 'cyan' : f.type === 'dir' ? 'blue' : 'white'}>
              {' '}{f.rel}
            </Text>
            {f.size !== undefined && (
              <Text color="gray" dimColor>
                {'  '}{f.size > 1024 ? `${(f.size / 1024).toFixed(0)}k` : `${f.size}b`}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
