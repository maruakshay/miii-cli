/**
 * mouse — terminal mouse reporting.
 *
 * The transcript scrolls inside miii's own viewport (see scroll.ts), so the app
 * needs the wheel: this turns on xterm button tracking (mode 1000) with
 * SGR-encoded reports (mode 1006). Motion tracking is deliberately left off, so
 * the terminal keeps as much native behaviour as it can — drag-to-select still
 * works with the usual override (option-drag on macOS, shift-drag elsewhere).
 *
 * Reports arrive on stdin as `ESC [ < b ; x ; y M|m`. Ink's parse-keypress
 * leaves them intact and strips only the leading ESC, so the keyboard handler
 * matches them with parseMouseEvent() and swallows them before they can reach
 * the input bar.
 */
const ENABLE = '\x1b[?1000h\x1b[?1006h'
export const DISABLE = '\x1b[?1006l\x1b[?1000l'

// SGR report minus the ESC that Ink strips: `[<button;col;row` + M (press) / m (release).
const SGR_RE = /^\[<(\d+);(\d+);(\d+)([Mm])$/

export type MouseEvent = {
  /** Button number with the modifier/motion bits masked off (0 = left). */
  button: number
  /** 1-based terminal column and row. */
  x: number
  y: number
  /** true = button press, false = release. */
  press: boolean
  /** Wheel notch rather than a button; `up` says which way. */
  wheel: boolean
  up: boolean
}

let enabled = false

export function enableMouse(): void {
  if (enabled || !process.stdout.isTTY) return
  enabled = true
  process.stdout.write(ENABLE)
}

export function disableMouse(): void {
  if (!enabled) return
  enabled = false
  if (process.stdout.isTTY) process.stdout.write(DISABLE)
}

/** Parse one useInput chunk as a mouse report; null when it isn't one. */
export function parseMouseEvent(input: string): MouseEvent | null {
  const m = SGR_RE.exec(input)
  if (!m) return null
  const raw = Number(m[1])
  // Low 2 bits are the button (or the wheel direction); 4/8/16 are
  // shift/meta/ctrl, 32 is motion, 64 marks a wheel notch.
  return {
    button: raw & 3,
    x: Number(m[2]),
    y: Number(m[3]),
    press: m[4] === 'M',
    wheel: (raw & 64) !== 0,
    up: (raw & 1) === 0,
  }
}
