import { memo, useEffect, useState } from 'react'
import { Box, Text, useStdout } from 'ink'
import { formatTokens, truncate } from './layout.js'
import { C } from './theme.js'

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * The one line that says the agent is working, drawn above the input bar while a
 * turn runs: what it's doing, how long it has been at it, and roughly how much
 * it has written — "⠹ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)".
 *
 * The thought itself is deliberately absent. It lands in the transcript with
 * the step (ctrl+t shows it); streaming it here is a flickering line nobody
 * reads, and the transcript is where the work is judged.
 */
export const StatusLine = memo(function StatusLine({
  label,
  startedAt,
  tokens,
}: {
  label: string
  startedAt: number
  /** Output tokens so far this turn, estimated from streamed characters. */
  tokens: number
}) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    // 200ms is a clean 2× of the runner's 100ms flush, so the two timers
    // phase-lock instead of repainting on drifting, unsynced clocks.
    const t = setInterval(() => setFrame((f) => (f + 1) % SPIN.length), 200)
    return () => clearInterval(t)
  }, [])

  const { stdout } = useStdout()
  const stats = [formatElapsed(Date.now() - startedAt)]
  if (tokens > 0) stats.push(`↓ ${formatTokens(tokens)} tokens`)
  stats.push('esc to interrupt')
  // Always exactly one row: a status line that wraps grows the frame and shoves
  // the transcript up. Root padding (2) + margin (1) + spinner (2).
  const line = truncate(`${label} (${stats.join(' · ')})`, Math.max(10, (stdout?.columns ?? 80) - 5))
  const cut = line.indexOf(' (')

  return (
    <Box marginLeft={1}>
      <Text color={C.yellow}>{SPIN[frame]} </Text>
      {cut < 0 ? (
        <Text>{line}</Text>
      ) : (
        <>
          <Text>{line.slice(0, cut)}</Text>
          <Text dimColor>{line.slice(cut)}</Text>
        </>
      )}
    </Box>
  )
})

/**
 * Messages sent while the agent works, shown until it picks them up — so a
 * correction typed mid-run is visibly waiting rather than seemingly lost.
 */
export function QueuedMessages({ queued }: { queued: string[] }) {
  const { stdout } = useStdout()
  if (!queued.length) return null
  const width = Math.max(10, (stdout?.columns ?? 80) - 20)
  return (
    <Box flexDirection="column" marginLeft={1}>
      {queued.map((q, i) => (
        <Text key={i} dimColor wrap="truncate">
          {`↳ queued · ${truncate(q.replace(/\s+/g, ' '), width)}`}
        </Text>
      ))}
    </Box>
  )
}
