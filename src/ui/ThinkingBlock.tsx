import { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import { clipTailVisual, liveFrameRows, contentWidth } from './layout.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Muted chalk tone — soft off-white, quiet against the dim hint next to it.
const CHALK = '#c9c7c0'

let globalThinkingVisible = false
const listeners = new Set<() => void>()

export function toggleThinkingVisible() {
  globalThinkingVisible = !globalThinkingVisible
  listeners.forEach((fn) => fn())
}

function useThinkingVisible() {
  const [visible, setVisible] = useState(globalThinkingVisible)

  useEffect(() => {
    const handler = () => setVisible(globalThinkingVisible)
    listeners.add(handler)
    return () => { listeners.delete(handler) }
  }, [])

  return visible
}

export function ThinkingBlock({ content }: { content?: string }) {
  const [frame, setFrame] = useState(0)
  const visible = useThinkingVisible()

  useEffect(() => {
    // Match the agent's FLUSH_MS stream/think cadence. At 80ms the spinner and
    // the 100ms flush beat against each other, so the tall live frame repaints on
    // two unsynced clocks — visible shimmer. Aligning them collapses it to one
    // repaint per tick.
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 100)
    return () => clearInterval(t)
  }, [])

  const label = 'thinking'

  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Box>
        <Text color={CHALK}>{FRAMES[frame]} </Text>
        <Text color={CHALK} italic>{label}</Text>
        <Text dimColor> · ctrl+t to {visible ? 'hide' : 'show'} thoughts</Text>
      </Box>
      {visible && content ? (() => {
        // Clip to the last lines that fit — thoughts can run long, and an
        // oversized live frame is what corrupts Ink's in-place redraw. Measure in
        // VISUAL rows at the wrap width (the content is indented 4 cols), not raw
        // line count, or wrapped long lines blow past the budget and orphan stale
        // frames in scrollback. Leave a row for the header line.
        const width = Math.max(20, contentWidth() - 2)
        const budget = Math.max(4, liveFrameRows() - 1)
        const { text, clipped } = clipTailVisual(content, budget, width)
        return (
          <Box flexDirection="column" marginLeft={2}>
            {clipped > 0 && (
              <Text dimColor>{`↑ ${clipped} earlier line${clipped === 1 ? '' : 's'} above`}</Text>
            )}
            <Box width={width}>
              <Text dimColor italic wrap="wrap">{text}</Text>
            </Box>
          </Box>
        )
      })() : null}
    </Box>
  )
}
