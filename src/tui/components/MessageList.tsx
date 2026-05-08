import { useMemo } from 'react'
import { Box, Text } from 'ink'
import type { Message } from '../../types.js'

interface Props {
  messages: Message[]
  rows: number
  cols: number
  scrollOffset: number  // 0 = pinned at bottom; N = N msgs hidden from bottom
  streaming?: boolean
  thinkingTick?: number
}

// ─── height estimation ───────────────────────────────────────────────────────

function msgHeight(msg: Message, cols: number): number {
  const usable = Math.max(cols - 8, 20)
  if (msg.role === 'system') return 2
  if (msg.role === 'tool') return 3
  let h = 2 // label + blank
  for (const line of msg.content.split('\n')) {
    h += Math.max(1, Math.ceil((line.length || 1) / usable))
  }
  return Math.min(h, 40)
}

interface Slice {
  visible: Message[]
  hiddenAbove: number
  hiddenBelow: number
}

function computeSlice(messages: Message[], availRows: number, offset: number, cols: number): Slice {
  const clampedOffset = Math.max(0, Math.min(offset, Math.max(0, messages.length - 1)))
  const endIdx = messages.length - clampedOffset

  let startIdx = endIdx
  let usedRows = 0
  while (startIdx > 0) {
    const h = msgHeight(messages[startIdx - 1], cols)
    if (usedRows + h > availRows) break
    startIdx--
    usedRows += h
  }

  return {
    visible: messages.slice(startIdx, endIdx),
    hiddenAbove: startIdx,
    hiddenBelow: clampedOffset,
  }
}

// ─── segments ────────────────────────────────────────────────────────────────

interface Segment { text: string; code: boolean; fence: boolean }

function parseSegments(content: string): Segment[] {
  const segs: Segment[] = []
  let inCode = false
  for (const line of content.split('\n')) {
    if (line.startsWith('```')) {
      segs.push({ text: line, code: false, fence: true })
      inCode = !inCode
    } else {
      segs.push({ text: line, code: inCode, fence: false })
    }
  }
  return segs
}

function ContentBlock({ content }: { content: string }) {
  const segs = useMemo(() => parseSegments(content), [content])
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {segs.map((seg, i) =>
        seg.fence ? (
          <Text key={i} color="gray" dimColor>{seg.text}</Text>
        ) : seg.code ? (
          <Text key={i} color="yellow">{seg.text || ' '}</Text>
        ) : (
          <Text key={i} wrap="wrap">{seg.text || ' '}</Text>
        )
      )}
    </Box>
  )
}

// ─── message renderers ───────────────────────────────────────────────────────

function UserMsg({ msg }: { msg: Message }) {
  const parts = msg.content.split(/(@[\w./\-]+)/g)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="blue">You</Text>
      <Box paddingLeft={2}>
        <Text wrap="wrap">
          {parts.map((p, i) =>
            p.startsWith('@')
              ? <Text key={i} color="cyan">{p}</Text>
              : <Text key={i}>{p}</Text>
          )}
        </Text>
      </Box>
    </Box>
  )
}

const THINKING_PHRASES = [
  'oh wow, a question. let me pretend to care…',
  'consulting the void…',
  'making something up, just a sec…',
  'definitely not hallucinating right now…',
  'running 47 mental tabs…',
  'staring into the abyss (it blinked)…',
  'calculating your fate, no pressure…',
  'doing the thinking you pay me for…',
  'processing your questionable life choices…',
  'summoning coherent thoughts, rarely works…',
]
const SPARKLE = ['✦', '✧', '✶', '✷', '✸', '✹']

function AssistantMsg({ msg, thinkingTick }: { msg: Message; thinkingTick?: number }) {
  if (!msg.content && thinkingTick !== undefined) {
    const phrase = THINKING_PHRASES[Math.floor(thinkingTick / 62) % THINKING_PHRASES.length]
    const icon = SPARKLE[thinkingTick % SPARKLE.length]
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="green">miii</Text>
        <Box paddingLeft={2}>
          <Text color="yellow">{icon} </Text><Text color="gray" dimColor italic>{phrase}</Text>
        </Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="green">miii</Text>
      <ContentBlock content={msg.content} />
    </Box>
  )
}

function ToolMsg({ msg }: { msg: Message }) {
  const lines = msg.content.split('\n')
  const name = (lines[0] ?? '').replace(/^\[/, '').replace(/\]$/, '')
  const body = lines.slice(1).join('\n').trim()
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Text color="green">✓ <Text color="cyan">{name}</Text></Text>
      {body && (
        <Box paddingLeft={2}>
          <Text color="gray" dimColor wrap="wrap">
            {body.length > 300 ? body.slice(0, 300) + '…' : body}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function SystemMsg({ msg }: { msg: Message }) {
  return (
    <Box marginBottom={1} paddingLeft={1}>
      <Text color="gray" dimColor>─ {msg.content}</Text>
    </Box>
  )
}

function MsgItem({ msg, thinkingTick }: { msg: Message; thinkingTick?: number }) {
  switch (msg.role) {
    case 'user':      return <UserMsg msg={msg} />
    case 'assistant': return <AssistantMsg msg={msg} thinkingTick={thinkingTick} />
    case 'tool':      return <ToolMsg msg={msg} />
    case 'system':    return <SystemMsg msg={msg} />
    default:          return null
  }
}

// ─── scroll hint bar ─────────────────────────────────────────────────────────

function ScrollHint({ hiddenAbove, hiddenBelow }: { hiddenAbove: number; hiddenBelow: number }) {
  if (hiddenAbove === 0 && hiddenBelow === 0) return null
  const parts: string[] = []
  if (hiddenAbove > 0) parts.push(`↑ ${hiddenAbove} above`)
  if (hiddenBelow > 0) parts.push(`↓ ${hiddenBelow} below`)
  return (
    <Box justifyContent="center">
      <Text color="gray" dimColor>{parts.join('  ')}  · PgUp/PgDn</Text>
    </Box>
  )
}

// ─── main export ─────────────────────────────────────────────────────────────

export function MessageList({ messages, rows, cols, scrollOffset, streaming, thinkingTick }: Props) {
  const availRows = Math.max(rows - 2, 4)
  const { visible, hiddenAbove, hiddenBelow } = useMemo(
    () => computeSlice(messages, availRows, scrollOffset, cols),
    [messages, availRows, scrollOffset, cols]
  )

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={1}>
      <ScrollHint hiddenAbove={hiddenAbove} hiddenBelow={hiddenBelow} />

      {visible.length === 0 && hiddenAbove === 0 && (
        <Box paddingTop={1}>
          <Text color="gray" dimColor>start typing below — @ for files, / for commands</Text>
        </Box>
      )}

      {visible.map(msg => <MsgItem key={msg.id} msg={msg} thinkingTick={thinkingTick} />)}

      {streaming && scrollOffset === 0 && (
        <Box paddingLeft={2}><Text color="gray" dimColor>▋</Text></Box>
      )}
    </Box>
  )
}
