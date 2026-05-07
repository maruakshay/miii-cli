import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { OllamaModel } from '../../llm/ollama.js'
import { fmtSize } from '../../llm/ollama.js'

type Mode = 'list' | 'pull-input' | 'pulling'

interface PullState {
  name: string
  status: string
  pct: number | undefined
}

interface Props {
  models: OllamaModel[]
  current: string
  loading: boolean
  error?: string
  pull?: PullState
  onSelect: (name: string) => void
  onPull: (name: string) => void
  onClose: () => void
}

const BAR_WIDTH = 20

function progressBar(pct: number): string {
  const filled = Math.round((pct / 100) * BAR_WIDTH)
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

export function ModelPicker({ models, current, loading, error, pull, onSelect, onPull, onClose }: Props) {
  const [idx, setIdx] = useState(() => {
    const i = models.findIndex(m => m.name === current)
    return i >= 0 ? i : 0
  })
  const [mode, setMode] = useState<Mode>('list')
  const [pullInput, setPullInput] = useState('')

  const totalItems = models.length + 1 // +1 for "pull new" row

  useInput((input, key) => {
    if (key.escape) {
      if (mode === 'pull-input') { setMode('list'); setPullInput(''); return }
      onClose()
      return
    }

    if (mode === 'list') {
      if (key.upArrow) { setIdx(i => Math.max(0, i - 1)); return }
      if (key.downArrow) { setIdx(i => Math.min(totalItems - 1, i + 1)); return }
      if (key.return) {
        if (idx < models.length) {
          onSelect(models[idx].name)
        } else {
          setMode('pull-input')
        }
        return
      }
      return
    }

    if (mode === 'pull-input') {
      if (key.return) {
        const name = pullInput.trim()
        if (name) { setMode('pulling'); onPull(name) }
        return
      }
      if (key.backspace || key.delete) { setPullInput(p => p.slice(0, -1)); return }
      if (input && !key.ctrl && !key.meta) { setPullInput(p => p + input); return }
    }
  })

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan"> models </Text>
        {loading && <Text color="yellow"> loading...</Text>}
        {error && <Text color="red"> {error}</Text>}
      </Box>

      {mode === 'list' && (
        <>
          {models.map((m, i) => {
            const active = i === idx
            const isCurrent = m.name === current
            const age = new Date(m.modified_at).toLocaleDateString()
            return (
              <Box key={m.name}>
                <Text color={active ? 'cyan' : 'white'}>
                  {active ? '▶ ' : '  '}
                  {m.name.padEnd(28)}
                </Text>
                <Text color="gray">{fmtSize(m.size).padEnd(8)}{age}</Text>
                {isCurrent && <Text color="green" bold>  ✓ active</Text>}
              </Box>
            )
          })}
          <Box marginTop={1}>
            <Text color={idx === models.length ? 'cyan' : 'gray'}>
              {idx === models.length ? '▶ ' : '  '}
              [pull new model...]
            </Text>
          </Box>
        </>
      )}

      {mode === 'pull-input' && (
        <Box flexDirection="column">
          <Box>
            <Text color="cyan">model name: </Text>
            <Text>{pullInput}█</Text>
          </Box>
          <Text color="gray" dimColor>enter to pull, esc to cancel</Text>
        </Box>
      )}

      {mode === 'pulling' && pull && (
        <Box flexDirection="column">
          <Text>pulling <Text color="cyan">{pull.name}</Text></Text>
          <Box>
            <Text color="yellow">{progressBar(pull.pct ?? 0)} </Text>
            <Text>{pull.pct !== undefined ? `${pull.pct}%` : ''}</Text>
          </Box>
          <Text color="gray" dimColor>{pull.status}</Text>
        </Box>
      )}

      <Box marginTop={1} borderTop borderStyle="single" borderColor="gray">
        <Text color="gray" dimColor>↑↓ navigate  enter select  esc close</Text>
      </Box>
    </Box>
  )
}
