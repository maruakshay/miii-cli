import { memo, useEffect, useState } from 'react'
import { Box, Text, useStdout } from 'ink'
import { INPUT_PLACEHOLDER, INPUT_HINTS, BUSY_HINTS } from './constants.js'
import { MODE_LABEL, type PermissionMode } from '../permissions/policy.js'

interface Props {
  input: string
  caret?: number
  disabled?: boolean
  processingLabel?: string
  /** Replaces the default key hints — used to surface a provider error. */
  hint?: string
  /** Permission mode; anything but 'default' is shown, and colours the frame. */
  mode?: PermissionMode
}

/**
 * The frame colour carries the mode, so the state you are in is visible without
 * reading anything. Red for bypass is the point: a session that never asks
 * should not look like an ordinary one.
 */
const MODE_COLOR: Record<PermissionMode, string> = {
  default: 'gray',
  plan: 'cyan',
  acceptEdits: 'green',
  bypass: 'red',
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * Prompt mark, one column. The space that separates it from the text comes from
 * the left scroll-indicator cell below, so there is exactly one gap either way.
 */
const PROMPT = '›'

/**
 * Columns consumed by everything around the text: the app's outer padding (1
 * each side), the box border (1), the box's padding (1), the prompt mark, and
 * the two scroll-indicator cells. The indicators are reserved whether or not
 * they're showing, so the field width — and the bar's height — never changes.
 */
const CHROME_COLS = 6 + PROMPT.length + 2

/** Text columns available inside the framed field, for a terminal `cols` wide. */
export function fieldWidth(cols: number): number {
  return Math.max(8, cols - CHROME_COLS)
}

/**
 * Fit the ` · `-separated hints into one row. A wrapped hint line grows the bar,
 * which pushes the pinned frame past the terminal height — the same redraw the
 * field's horizontal scrolling exists to avoid — so segments are dropped from
 * the right until the line fits rather than being allowed to wrap.
 */
export function fitHint(hint: string, cols: number): string {
  const width = Math.max(8, cols - 4) // outer padding (1 each side) + this box's (1 each side)
  if (hint.length <= width) return hint
  const parts = hint.split(' · ')
  while (parts.length > 1 && parts.join(' · ').length > width) parts.pop()
  const fitted = parts.join(' · ')
  return fitted.length <= width ? fitted : `${fitted.slice(0, Math.max(1, width - 1))}…`
}

/**
 * A single-row window onto `input` that always contains the caret.
 *
 * The field must never wrap: this bar sits in Ink's live frame, and a bar that
 * grows with a long paste pushes the frame past the terminal height, forcing
 * Ink's full-screen redraw — the flicker the chat view works hard to avoid. So
 * long input scrolls horizontally instead, with `‹`/`›` marking hidden text.
 *
 * Derived purely from (input, caret, width) so there is no scroll state to keep
 * in sync: the window is pinned so the caret sits at its right edge once the
 * text outruns the field, which is how a shell prompt behaves.
 *
 * `text` is at most `width` columns INCLUDING the caret cell, so the caller can
 * render before/at/after without overflowing the field.
 */
export function viewport(
  input: string,
  caret: number,
  width: number,
): { text: string; caretCol: number; more: boolean; less: boolean } {
  const w = Math.max(1, width)
  const pos = Math.max(0, Math.min(caret, input.length))
  // Room for every character plus the caret cell — no scrolling needed.
  if (input.length < w) {
    return { text: input, caretCol: pos, more: false, less: false }
  }
  const start = Math.max(0, Math.min(pos - w + 1, input.length - w + 1))
  return {
    text: input.slice(start, start + w),
    caretCol: pos - start,
    more: start + w <= input.length,
    less: start > 0,
  }
}

export const InputBar = memo(function InputBar({
  input,
  caret,
  disabled,
  processingLabel,
  hint,
  mode = 'default',
}: Props) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!disabled) return
    // 200ms is a clean 2× of the 100ms stream flush (useAgentRunner FLUSH_MS):
    // the two timers phase-lock instead of beating, so the live frame repaints
    // on a steady cadence rather than at drifting 100/150ms intervals — the
    // extra unsynced repaints were a visible flicker source.
    const t = setInterval(() => setFrame((f) => (f + 1) % SPIN.length), 200)
    return () => clearInterval(t)
  }, [disabled])

  // The stream Ink is actually rendering to, not the global process.stdout —
  // they differ under test and when the app is driven programmatically.
  const { stdout } = useStdout()
  const view = viewport(input, caret ?? input.length, fieldWidth(stdout?.columns ?? 80))
  const showPlaceholder = !disabled && input.length === 0

  return (
    <Box flexDirection="column" width="100%">
      <Box
        width="100%"
        borderStyle="round"
        borderColor={disabled ? 'yellow' : MODE_COLOR[mode]}
        paddingX={1}
      >
        {disabled ? (
          <>
            <Text color="yellow">{SPIN[frame]} </Text>
            <Text>{processingLabel ?? 'processing…'}</Text>
          </>
        ) : (
          <>
            <Text color={showPlaceholder ? 'gray' : 'blue'}>{PROMPT}</Text>
            {/* Gutter: the separator after the prompt, doubling as the
                scrolled-left marker. Always one column, so the field width —
                and therefore the bar's height — never changes. */}
            <Text dimColor>{view.less ? '‹' : ' '}</Text>
            {showPlaceholder ? (
              <>
                {/* The caret sits on the placeholder's first cell, so an empty
                    bar still shows where typing will land. */}
                <Text inverse>{INPUT_PLACEHOLDER.slice(0, 1)}</Text>
                <Text dimColor>{INPUT_PLACEHOLDER.slice(1)}</Text>
              </>
            ) : (
              <>
                <Text>{view.text.slice(0, view.caretCol)}</Text>
                <Text inverse>{view.text.slice(view.caretCol, view.caretCol + 1) || ' '}</Text>
                <Text>{view.text.slice(view.caretCol + 1)}</Text>
                <Text dimColor>{view.more ? '›' : ' '}</Text>
              </>
            )}
          </>
        )}
      </Box>
      <Box paddingX={1}>
        {mode !== 'default' && (
          <Text color={MODE_COLOR[mode]} bold>{MODE_LABEL[mode]}{' · '}</Text>
        )}
        <Text dimColor>
          {fitHint(
            hint ?? (disabled ? BUSY_HINTS : INPUT_HINTS),
            // The mode chip eats into the same row, so the hints have to fit
            // what's left of it or the bar wraps and pushes the frame.
            (stdout?.columns ?? 80) - (mode === 'default' ? 0 : MODE_LABEL[mode].length + 3),
          )}
        </Text>
      </Box>
    </Box>
  )
})
