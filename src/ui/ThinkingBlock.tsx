import { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import { contentWidth, truncate } from './layout.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Muted chalk tone — soft off-white, quiet against the dim hint next to it.
export const CHALK = '#c9c7c0'

let globalThinkingVisible = false
const listeners = new Set<() => void>()

export function toggleThinkingVisible() {
  globalThinkingVisible = !globalThinkingVisible
  listeners.forEach((fn) => fn())
}

export function useThinkingVisible() {
  const [visible, setVisible] = useState(globalThinkingVisible)

  useEffect(() => {
    const handler = () => setVisible(globalThinkingVisible)
    listeners.add(handler)
    return () => { listeners.delete(handler) }
  }, [])

  return visible
}

/**
 * The live thinking indicator: a spinner and, under it, the single line the
 * model is thinking right now.
 *
 * Deliberately fixed at two rows. The whole thought is accumulated by the runner
 * and committed to the transcript with the turn (see `ChatMessage.thinking`),
 * where it stays scrollable and ctrl+t expands it. Nothing here has to grow, so
 * there's no tail-clipping to get wrong and no live frame that can outgrow the
 * terminal — which is what used to corrupt Ink's in-place redraw.
 */
export function ThinkingBlock({ tail }: { tail?: string }) {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    // Match the agent's FLUSH_MS stream/think cadence. At 80ms the spinner and
    // the 100ms flush beat against each other, so the frame repaints on two
    // unsynced clocks — visible shimmer. Aligning them collapses it to one
    // repaint per tick.
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 100)
    return () => clearInterval(t)
  }, [])

  // Truncate to the content column and forbid wrapping: two guards for the same
  // invariant, because a second row here is a row Ink has to redraw in place.
  const line = tail ? truncate(tail, Math.max(20, contentWidth() - 2)) : ''

  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Box>
        <Text color={CHALK}>{FRAMES[frame]} </Text>
        <Text color={CHALK} italic>thinking</Text>
        <Text dimColor> · ctrl+t for full thoughts</Text>
      </Box>
      {line ? (
        <Box marginLeft={2}>
          <Text dimColor italic wrap="truncate">{line}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
