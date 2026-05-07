import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import type { Skill } from '../../skills/loader.js'

interface Props {
  skills: Skill[]
  query: string
  idx: number
}

export function CommandPalette({ skills, query, idx }: Props) {
  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    if (!q) return skills.slice(0, 10)
    return skills.filter(s =>
      s.name.includes(q) ||
      `${s.ns}:${s.name}`.includes(q) ||
      s.description.toLowerCase().includes(q)
    ).slice(0, 10)
  }, [skills, query])

  if (!filtered.length) {
    return (
      <Box borderStyle="round" borderColor="gray" marginX={1} paddingX={1}>
        <Text color="gray">no commands match</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" marginX={1}>
      {filtered.map((s, i) => {
        const active = i === idx
        const isBuiltin = s.ns === 'builtin'
        const name = (s.ns === 'default' || s.ns === 'builtin')
          ? `/${s.name}`
          : `/${s.ns}:${s.name}`
        return (
          <Box key={`${s.ns}:${s.name}`} paddingX={1}>
            <Text color={active ? 'cyan' : isBuiltin ? 'white' : 'magenta'} bold={active}>
              {active ? '▶ ' : '  '}
              {name.padEnd(20)}
            </Text>
            <Text color="gray" dimColor>{s.description}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
