import React, { useState, useMemo, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import type { Key } from 'ink'
import type { Status } from '../../types.js'
import type { Skill } from '../../skills/loader.js'
import type { FileEntry } from '../../files/ops.js'
import { listFiles } from '../../files/ops.js'
import { CommandPalette } from './CommandPalette.js'
import { AtPicker } from './AtPicker.js'

const BUILTIN_COMMANDS: Skill[] = [
  { ns: 'builtin', name: 'new',         description: 'start a fresh session (auto-named)' },
  { ns: 'builtin', name: 'models',      description: 'switch or pull Ollama models' },
  { ns: 'builtin', name: 'clear',       description: 'clear chat history for current session' },
  { ns: 'builtin', name: 'sessions',    description: 'list all saved sessions' },
  { ns: 'builtin', name: 'session',     description: 'switch session  /session <name>' },
  { ns: 'builtin', name: 'exit',        description: 'exit miii' },
  { ns: 'builtin', name: 'model',      description: 'switch model mid-session  /model <name>' },
  { ns: 'builtin', name: 'version',     description: 'show current miii version' },
  { ns: 'builtin', name: 'tavily-key',  description: 'set Tavily API key for web search  /tavily-key tvly-...' },
  { ns: 'builtin', name: 'skills',      description: 'install/uninstall/list npm skills  /skills install <name>' },
  { ns: 'builtin', name: 'list',        description: 'list all loaded skills' },
  { ns: 'builtin', name: 'plan',        description: 'start planning mode  /plan [topic]' },
  { ns: 'builtin', name: 'refactor',    description: 'multi-file AI refactor  /refactor <goal>' },
  { ns: 'git',     name: 'status',      description: 'show git working tree status' },
  { ns: 'git',     name: 'diff',        description: 'show unstaged diff' },
  { ns: 'git',     name: 'diff --staged', description: 'show staged diff' },
  { ns: 'git',     name: 'log',         description: 'show recent commits' },
  { ns: 'git',     name: 'review',      description: 'review current changes with AI' },
  { ns: 'git',     name: 'branch',      description: 'list branches' },
  { ns: 'git',     name: 'commit',      description: 'stage all and commit  /git commit <msg>' },
]

const PLANNING_COMMANDS: Skill[] = [
  { ns: 'plan', name: 'next',      description: 'suggest next concrete steps' },
  { ns: 'plan', name: 'breakdown', description: 'break current topic into subtasks' },
  { ns: 'plan', name: 'review',    description: 'review and critique the plan so far' },
  { ns: 'plan', name: 'done',      description: 'exit planning mode' },
]

type Overlay = 'none' | 'command' | 'at'

interface Props {
  status: Status
  skills: Skill[]
  cwd: string
  planningMode?: boolean
  onSubmit: (text: string) => void
  onAbort: () => void
}

export function InputArea({ status, skills, cwd, planningMode, onSubmit, onAbort }: Props) {
  const [lines, setLines] = useState<string[]>([''])
  const [cursor, setCursor] = useState({ row: 0, col: 0 })
  const [overlay, setOverlay] = useState<Overlay>('none')
  const [overlayIdx, setOverlayIdx] = useState(0)

  const [files, setFiles] = useState<FileEntry[]>([])
  const filesLoadedRef = useRef(false)

  // built-ins first, then loaded skills (deduplicated by name)
  const allCommands = useMemo(() => {
    const builtinNames = new Set(BUILTIN_COMMANDS.map(b => b.name))
    const userSkills = skills.filter(s => !builtinNames.has(s.name))
    const base = [...BUILTIN_COMMANDS, ...userSkills]
    return planningMode ? [...PLANNING_COMMANDS, ...base] : base
  }, [skills, planningMode])

  const isActive = status === 'idle'
  const fullInput = lines.join('\n')

  const commandQuery = useMemo(() =>
    fullInput.startsWith('/') ? fullInput.slice(1) : '',
    [fullInput]
  )

  const atQuery = useMemo(() => {
    const line = lines[cursor.row] ?? ''
    const before = line.slice(0, cursor.col)
    const atIdx = before.lastIndexOf('@')
    if (atIdx === -1) return ''
    const after = before.slice(atIdx + 1)
    if (after.includes(' ')) return '' // space breaks @ ref
    return after
  }, [lines, cursor])

  const filteredCommands = useMemo(() => {
    const q = commandQuery.toLowerCase()
    if (!q) return allCommands.slice(0, 10)
    return allCommands.filter(s =>
      s.name.includes(q) ||
      `${s.ns}:${s.name}`.includes(q) ||
      s.description.toLowerCase().includes(q)
    ).slice(0, 10)
  }, [commandQuery, allCommands])

  const filteredFiles = useMemo(() => {
    if (!atQuery) return []
    if (!filesLoadedRef.current) {
      filesLoadedRef.current = true
      setTimeout(() => { try { setFiles(listFiles(cwd, true)) } catch {} }, 0)
      return []
    }
    return files.filter(f => f.rel.toLowerCase().includes(atQuery.toLowerCase())).slice(0, 8)
  }, [atQuery, files, cwd])

  const overlayCount = overlay === 'command' ? filteredCommands.length : filteredFiles.length

  function clearInput() {
    setLines([''])
    setCursor({ row: 0, col: 0 })
    setOverlay('none')
    setOverlayIdx(0)
  }

  function appendChar(ch: string) {
    setLines(prev => {
      const next = [...prev]
      const r = cursor.row
      next[r] = next[r].slice(0, cursor.col) + ch + next[r].slice(cursor.col)
      return next
    })
    setCursor(c => ({ ...c, col: c.col + ch.length }))
  }

  function deleteChar() {
    const { row, col } = cursor
    setLines(prev => {
      const next = [...prev]
      if (col > 0) {
        next[row] = next[row].slice(0, col - 1) + next[row].slice(col)
      } else if (row > 0) {
        const prevLen = next[row - 1].length
        next.splice(row - 1, 2, next[row - 1] + next[row])
        setCursor({ row: row - 1, col: prevLen })
        return next
      }
      return next
    })
    if (col > 0) setCursor(c => ({ ...c, col: c.col - 1 }))
  }

  function selectCommand(skill: Skill) {
    const name = (skill.ns === 'default' || skill.ns === 'builtin')
      ? `/${skill.name}`
      : skill.ns === 'git'
        ? `/git ${skill.name}`
        : `/${skill.ns}:${skill.name}`
    clearInput()
    onSubmit(name)
  }

  function selectFile(file: FileEntry) {
    setLines(prev => {
      const next = [...prev]
      const r = cursor.row
      const line = next[r]
      const before = line.slice(0, cursor.col)
      const atIdx = before.lastIndexOf('@')
      if (atIdx === -1) return prev
      const newLine = line.slice(0, atIdx) + '@' + file.rel + ' ' + line.slice(cursor.col)
      next[r] = newLine
      setCursor({ row: r, col: atIdx + 1 + file.rel.length + 1 })
      return next
    })
    setOverlay('none')
    setOverlayIdx(0)
  }

  useInput((input: string, key: Key) => {
    // ESC: close overlay, abort stream, or clear input
    if (key.escape) {
      if (overlay !== 'none') { setOverlay('none'); setOverlayIdx(0); return }
      if (status !== 'idle') { onAbort(); return }
      clearInput(); return
    }

    // Ctrl+C
    if (key.ctrl && input === 'c') {
      if (status !== 'idle') { onAbort() } else { process.exit(0) }
      return
    }

    if (!isActive) return

    // Overlay navigation
    if (overlay !== 'none') {
      if (key.upArrow) { setOverlayIdx(i => Math.max(0, i - 1)); return }
      if (key.downArrow) { setOverlayIdx(i => Math.min(overlayCount - 1, i + 1)); return }
      if (key.return) {
        if (overlay === 'command') {
          if (commandQuery.includes(' ')) {
            // has args — submit full text, don't pick from palette
            const text = fullInput.trim()
            if (text) { clearInput(); onSubmit(text) }
          } else if (filteredCommands[overlayIdx]) {
            selectCommand(filteredCommands[overlayIdx])
          }
        } else if (overlay === 'at' && filteredFiles[overlayIdx]) {
          selectFile(filteredFiles[overlayIdx])
        }
        return
      }
      // backspace/typing falls through to normal handling below
    }

    if (key.return) {
      const text = fullInput.trim()
      if (text) { clearInput(); onSubmit(text) }
      return
    }

    if (key.backspace || key.delete) {
      deleteChar()
      // Recompute overlay trigger for updated input
      const r = cursor.row
      const col = cursor.col
      const prospectiveLine = col > 0
        ? lines[r].slice(0, col - 1) + lines[r].slice(col)
        : lines[r]
      const prospectiveLines = [...lines]
      prospectiveLines[r] = prospectiveLine
      const prospective = prospectiveLines.join('\n')

      if (overlay === 'command' && !prospective.startsWith('/')) setOverlay('none')
      if (overlay === 'at') {
        const before = prospectiveLine.slice(0, Math.max(0, col - 1))
        const atIdx = before.lastIndexOf('@')
        if (atIdx === -1) setOverlay('none')
      }
      return
    }

    if (key.upArrow && overlay === 'none') { setCursor(c => ({ row: Math.max(0, c.row - 1), col: 0 })); return }
    if (key.downArrow && overlay === 'none') { setCursor(c => ({ row: Math.min(lines.length - 1, c.row + 1), col: 0 })); return }
    if (key.leftArrow) { setCursor(c => ({ ...c, col: Math.max(0, c.col - 1) })); return }
    if (key.rightArrow) { setCursor(c => ({ ...c, col: Math.min(lines[c.row]?.length ?? 0, c.col + 1) })); return }

    if (input && !key.ctrl && !key.meta) {
      // Compute prospective new input to decide overlay
      const r = cursor.row
      const col = cursor.col
      const prospectiveLine = lines[r].slice(0, col) + input + lines[r].slice(col)
      const prospectiveLines = [...lines]
      prospectiveLines[r] = prospectiveLine
      const prospective = prospectiveLines.join('\n')

      appendChar(input)

      // Open/update overlays
      if (prospective.startsWith('/')) {
        const q = prospective.slice(1)
        if (q.includes(' ')) {
          setOverlay('none')  // typing args — close palette, let user type freely
        } else {
          setOverlay('command')
          setOverlayIdx(0)
        }
      } else if (input === '@' || (overlay === 'at' && atQuery !== undefined)) {
        setOverlay('at')
        setOverlayIdx(0)
      } else if (overlay === 'command') {
        setOverlay('none')
      }
    }
  })

  const isProcessing = status !== 'idle'
  const borderColor = isProcessing ? 'yellow' : 'cyan'
  const hint = isProcessing
    ? 'esc to abort'
    : overlay === 'command' && !commandQuery.includes(' ')
    ? '↑↓ navigate  enter select  esc close'
    : overlay === 'at'
    ? '↑↓ navigate  enter select  esc close'
    : planningMode
    ? '📋 planning mode  / suggestions  enter send  /plan:done to exit'
    : '@ file  / command  enter send  ctrl+c exit'

  return (
    <Box flexDirection="column">
      {overlay === 'command' && (
        <CommandPalette skills={allCommands} query={commandQuery} idx={overlayIdx} />
      )}
      {overlay === 'at' && (
        <AtPicker files={filteredFiles} query={atQuery} idx={overlayIdx} />
      )}
      <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
        <Box>
          <Text color={borderColor} bold>{'❯ '}</Text>
          <Box flexDirection="column" flexGrow={1}>
            {lines.length === 1 && !lines[0] ? (
              <Text color={isActive ? 'white' : 'gray'} dimColor={isProcessing}>
                {isActive ? '█' : 'processing...'}
              </Text>
            ) : (
              lines.map((line, i) => (
                <Text key={i} wrap="wrap">
                  {i === cursor.row
                    ? renderLineWithCursor(line, cursor.col, isActive)
                    : line}
                </Text>
              ))
            )}
          </Box>
        </Box>
        <Text color="gray" dimColor>{hint}</Text>
      </Box>
    </Box>
  )
}

function renderLineWithCursor(line: string, col: number, showCursor: boolean): string {
  return line.slice(0, col) + (showCursor ? '█' : '') + line.slice(col)
}
